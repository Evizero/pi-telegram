import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { BrokerState, SessionRegistration, TelegramRoute } from "../shared/types.js";
import { invalidDurableJson, isRecord, readJson } from "../shared/utils.js";

export interface PendingDisconnectRequest {
	sessionId: string;
	requestedAtMs: number;
	connectionNonce?: string;
	connectionStartedAtMs?: number;
	routeId?: string;
	chatId?: number | string;
	messageThreadId?: number;
	routeCreatedAtMs?: number;
}

export function validatePendingDisconnectRequest(path: string, value: unknown): PendingDisconnectRequest | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) invalidDurableJson(path, "root value must be an object");
	if (value.schemaVersion !== undefined && value.schemaVersion !== 1) invalidDurableJson(path, "schemaVersion must be 1 when present");
	if (typeof value.sessionId !== "string") invalidDurableJson(path, "sessionId must be a string");
	if (typeof value.requestedAtMs !== "number" || !Number.isFinite(value.requestedAtMs)) invalidDurableJson(path, "requestedAtMs must be a finite number");
	if (value.connectionNonce !== undefined && typeof value.connectionNonce !== "string") invalidDurableJson(path, "connectionNonce must be a string when present");
	if (value.connectionStartedAtMs !== undefined && (typeof value.connectionStartedAtMs !== "number" || !Number.isFinite(value.connectionStartedAtMs))) invalidDurableJson(path, "connectionStartedAtMs must be a finite number when present");
	if (value.routeId !== undefined && typeof value.routeId !== "string") invalidDurableJson(path, "routeId must be a string when present");
	if (value.chatId !== undefined && typeof value.chatId !== "number" && typeof value.chatId !== "string") invalidDurableJson(path, "chatId must be a number or string when present");
	if (typeof value.chatId === "number" && !Number.isFinite(value.chatId)) invalidDurableJson(path, "chatId must be finite when numeric");
	if (value.messageThreadId !== undefined && (typeof value.messageThreadId !== "number" || !Number.isFinite(value.messageThreadId))) invalidDurableJson(path, "messageThreadId must be a finite number when present");
	if (value.routeCreatedAtMs !== undefined && (typeof value.routeCreatedAtMs !== "number" || !Number.isFinite(value.routeCreatedAtMs))) invalidDurableJson(path, "routeCreatedAtMs must be a finite number when present");
	return {
		sessionId: value.sessionId,
		requestedAtMs: value.requestedAtMs,
		connectionNonce: value.connectionNonce,
		connectionStartedAtMs: value.connectionStartedAtMs,
		routeId: value.routeId,
		chatId: value.chatId,
		messageThreadId: value.messageThreadId,
		routeCreatedAtMs: value.routeCreatedAtMs,
	};
}

export async function readPendingDisconnectRequestFromPath(path: string): Promise<PendingDisconnectRequest | undefined> {
	return validatePendingDisconnectRequest(path, await readJson<unknown>(path));
}

export async function readPendingDisconnectRequestsFromDir(options: {
	dir: string;
	onInvalidRequest?: (path: string, error: unknown) => void;
}): Promise<PendingDisconnectRequest[]> {
	const names = await readdir(options.dir).catch(() => [] as string[]);
	const requests: PendingDisconnectRequest[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(options.dir, name);
		try {
			const request = await readPendingDisconnectRequestFromPath(path);
			if (request) requests.push(request);
		} catch (error) {
			options.onInvalidRequest?.(path, error);
		}
	}
	return requests;
}

export function isRouteScopedDisconnectRequest(request: PendingDisconnectRequest): boolean {
	return request.routeId !== undefined || request.chatId !== undefined || request.messageThreadId !== undefined;
}

export function disconnectRequestMatchesRoute(request: PendingDisconnectRequest, route: TelegramRoute): boolean {
	if (route.sessionId !== request.sessionId) return false;
	if (request.routeId !== undefined && route.routeId !== request.routeId) return false;
	if (request.chatId !== undefined && String(route.chatId) !== String(request.chatId)) return false;
	if (request.messageThreadId !== undefined && route.messageThreadId !== request.messageThreadId) return false;
	if (request.routeCreatedAtMs !== undefined && route.createdAtMs !== request.routeCreatedAtMs) return false;
	if (request.routeCreatedAtMs === undefined && route.createdAtMs >= request.requestedAtMs) return false;
	return isRouteScopedDisconnectRequest(request);
}

export function disconnectRequestBelongsToCurrentConnection(request: PendingDisconnectRequest, session: SessionRegistration | undefined): boolean {
	if (!session) return false;
	if (request.connectionNonce && session.connectionNonce !== request.connectionNonce) return false;
	if (request.connectionStartedAtMs !== undefined && session.connectionStartedAtMs !== request.connectionStartedAtMs) return false;
	return session.connectionStartedAtMs <= request.requestedAtMs;
}

export async function processDisconnectRequestsInBroker(options: {
	brokerState: BrokerState;
	requests: PendingDisconnectRequest[];
	unregisterSession: (sessionId: string) => Promise<unknown>;
	honorRouteScopedDisconnect?: (request: PendingDisconnectRequest) => Promise<{ honored: boolean }>;
	clearRequest: (sessionId: string) => Promise<void>;
}): Promise<void> {
	for (const request of options.requests) {
		const session = options.brokerState.sessions[request.sessionId];
		if (isRouteScopedDisconnectRequest(request)) {
			const result = await options.honorRouteScopedDisconnect?.(request);
			if (result?.honored || !Object.values(options.brokerState.routes).some((route) => disconnectRequestMatchesRoute(request, route))) {
				await options.clearRequest(request.sessionId);
			}
			continue;
		}
		if (session) {
			if (request.connectionNonce && session.connectionNonce && session.connectionNonce !== request.connectionNonce) {
				await options.clearRequest(request.sessionId);
				continue;
			}
			if (session.connectionStartedAtMs > request.requestedAtMs) {
				await options.clearRequest(request.sessionId);
				continue;
			}
		} else if (
			Object.values(options.brokerState.pendingTurns ?? {}).some((entry) => entry.turn.sessionId === request.sessionId)
			|| Object.values(options.brokerState.pendingAssistantFinals ?? {}).some((entry) => entry.turn.sessionId === request.sessionId)
		) {
			await options.clearRequest(request.sessionId);
			continue;
		}
		if (Object.values(options.brokerState.pendingAssistantFinals ?? {}).some((entry) => entry.turn.sessionId === request.sessionId)) continue;
		await options.unregisterSession(request.sessionId);
		await options.clearRequest(request.sessionId);
	}
}
