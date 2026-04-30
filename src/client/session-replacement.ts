import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { SESSION_REPLACEMENT_HANDOFF_TTL_MS } from "../broker/policy.js";
import type { BrokerState, SessionRegistration, TelegramRoute } from "../broker/types.js";
import { canonicalRouteKey, retargetTurnToRoute, routeMatchesTopicIdentity } from "../shared/routing.js";
import { ensurePrivateDir, invalidDurableJson, isRecord, now, readJson, writeJson } from "../shared/utils.js";

export type SessionReplacementReason = "new" | "resume" | "fork";

export interface SessionReplacementContext {
	reason: SessionReplacementReason;
	previousSessionFile?: string;
	sessionFile?: string;
}

export interface SessionReplacementHandoff {
	schemaVersion: 1;
	reason: SessionReplacementReason;
	oldSessionId: string;
	oldSessionFile?: string;
	targetSessionFile?: string;
	route: TelegramRoute;
	connectionNonce?: string;
	connectionStartedAtMs?: number;
	createdAtMs: number;
	expiresAtMs: number;
}

export interface MatchedSessionReplacementHandoff {
	path: string;
	handoff: SessionReplacementHandoff;
}

export function isSessionReplacementReason(reason: string | undefined): reason is SessionReplacementReason {
	return reason === "new" || reason === "resume" || reason === "fork";
}

export function sessionReplacementHandoffPath(dir: string, oldSessionId: string, targetSessionFile?: string): string {
	const targetHash = createHash("sha256").update(targetSessionFile ?? "unknown-target").digest("hex").slice(0, 16);
	return join(dir, `${oldSessionId}-${targetHash}.json`);
}

export async function writeSessionReplacementHandoff(options: {
	dir: string;
	reason: SessionReplacementReason;
	oldSessionId: string;
	oldSessionFile?: string;
	targetSessionFile?: string;
	route: TelegramRoute;
	connectionNonce?: string;
	connectionStartedAtMs?: number;
	nowMs?: number;
}): Promise<SessionReplacementHandoff> {
	const createdAtMs = options.nowMs ?? now();
	const handoff: SessionReplacementHandoff = {
		schemaVersion: 1,
		reason: options.reason,
		oldSessionId: options.oldSessionId,
		oldSessionFile: options.oldSessionFile,
		targetSessionFile: options.targetSessionFile,
		route: options.route,
		connectionNonce: options.connectionNonce,
		connectionStartedAtMs: options.connectionStartedAtMs,
		createdAtMs,
		expiresAtMs: createdAtMs + SESSION_REPLACEMENT_HANDOFF_TTL_MS,
	};
	await ensurePrivateDir(options.dir);
	await writeJson(sessionReplacementHandoffPath(options.dir, options.oldSessionId, options.targetSessionFile), handoff);
	return handoff;
}

export async function findMatchingSessionReplacementHandoff(options: {
	dir: string;
	context: SessionReplacementContext;
	nowMs?: number;
	deleteExpired?: boolean;
	onInvalidHandoff?: (path: string, error: unknown) => void;
}): Promise<MatchedSessionReplacementHandoff | undefined> {
	const nowMs = options.nowMs ?? now();
	const names = await readdir(options.dir).catch(() => [] as string[]);
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(options.dir, name);
		let handoff: SessionReplacementHandoff | undefined;
		try {
			handoff = validateHandoff(path, await readJson<unknown>(path));
		} catch (error) {
			options.onInvalidHandoff?.(path, error);
			continue;
		}
		if (!handoff) continue;
		if (handoff.expiresAtMs < nowMs) {
			if (options.deleteExpired ?? true) await rm(path, { force: true }).catch(() => undefined);
			continue;
		}
		if (!handoffMatchesContext(handoff, options.context)) continue;
		return { path, handoff };
	}
	return undefined;
}

export async function hasMatchingSessionReplacementHandoff(options: {
	dir: string;
	context: SessionReplacementContext;
	nowMs?: number;
	onInvalidHandoff?: (path: string, error: unknown) => void;
}): Promise<boolean> {
	return (await findMatchingSessionReplacementHandoff({ ...options, deleteExpired: true })) !== undefined;
}

export async function consumeSessionReplacementHandoffInBroker(options: {
	dir: string;
	brokerState: BrokerState;
	registration: SessionRegistration;
	nowMs?: number;
	onInvalidHandoff?: (path: string, error: unknown) => void;
}): Promise<boolean> {
	const context = options.registration.replacement;
	if (!context) return false;
	const match = await findMatchingSessionReplacementHandoff({ dir: options.dir, context, nowMs: options.nowMs, deleteExpired: true, onInvalidHandoff: options.onInvalidHandoff });
	if (!match) return false;
	if (match.handoff.oldSessionId === options.registration.sessionId) return false;
	retargetBrokerStateForReplacement(options.brokerState, match.handoff, options.registration);
	await rm(match.path, { force: true }).catch(() => undefined);
	return true;
}

function validateRoute(path: string, value: unknown): TelegramRoute {
	if (!isRecord(value)) invalidDurableJson(path, "route must be an object");
	if (typeof value.routeId !== "string") invalidDurableJson(path, "route.routeId must be a string");
	if (typeof value.sessionId !== "string") invalidDurableJson(path, "route.sessionId must be a string");
	if (typeof value.chatId !== "number" && typeof value.chatId !== "string") invalidDurableJson(path, "route.chatId must be a number or string");
	if (typeof value.chatId === "number" && !Number.isFinite(value.chatId)) invalidDurableJson(path, "route.chatId must be finite when numeric");
	if (value.messageThreadId !== undefined && (typeof value.messageThreadId !== "number" || !Number.isFinite(value.messageThreadId))) invalidDurableJson(path, "route.messageThreadId must be a finite number when present");
	if (value.routeMode !== "private_topic" && value.routeMode !== "forum_supergroup_topic" && value.routeMode !== "single_chat_selector") invalidDurableJson(path, "route.routeMode must be a known route mode");
	if (typeof value.topicName !== "string") invalidDurableJson(path, "route.topicName must be a string");
	if (typeof value.createdAtMs !== "number" || !Number.isFinite(value.createdAtMs)) invalidDurableJson(path, "route.createdAtMs must be a finite number");
	if (typeof value.updatedAtMs !== "number" || !Number.isFinite(value.updatedAtMs)) invalidDurableJson(path, "route.updatedAtMs must be a finite number");
	return value as unknown as TelegramRoute;
}

function validateHandoff(path: string, value: unknown): SessionReplacementHandoff | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) invalidDurableJson(path, "root value must be an object");
	if (value.schemaVersion !== 1) invalidDurableJson(path, "schemaVersion must be 1");
	const reason = typeof value.reason === "string" ? value.reason : undefined;
	if (!isSessionReplacementReason(reason)) invalidDurableJson(path, "reason must be new, resume, or fork");
	if (typeof value.oldSessionId !== "string") invalidDurableJson(path, "oldSessionId must be a string");
	if (value.oldSessionFile !== undefined && typeof value.oldSessionFile !== "string") invalidDurableJson(path, "oldSessionFile must be a string when present");
	if (value.targetSessionFile !== undefined && typeof value.targetSessionFile !== "string") invalidDurableJson(path, "targetSessionFile must be a string when present");
	const route = validateRoute(path, value.route);
	if (value.connectionNonce !== undefined && typeof value.connectionNonce !== "string") invalidDurableJson(path, "connectionNonce must be a string when present");
	if (value.connectionStartedAtMs !== undefined && (typeof value.connectionStartedAtMs !== "number" || !Number.isFinite(value.connectionStartedAtMs))) invalidDurableJson(path, "connectionStartedAtMs must be a finite number when present");
	if (typeof value.createdAtMs !== "number" || !Number.isFinite(value.createdAtMs)) invalidDurableJson(path, "createdAtMs must be a finite number");
	if (typeof value.expiresAtMs !== "number" || !Number.isFinite(value.expiresAtMs)) invalidDurableJson(path, "expiresAtMs must be a finite number");
	return {
		schemaVersion: 1,
		reason,
		oldSessionId: value.oldSessionId,
		oldSessionFile: value.oldSessionFile,
		targetSessionFile: value.targetSessionFile,
		route,
		connectionNonce: value.connectionNonce,
		connectionStartedAtMs: value.connectionStartedAtMs,
		createdAtMs: value.createdAtMs,
		expiresAtMs: value.expiresAtMs,
	};
}

function handoffMatchesContext(handoff: SessionReplacementHandoff, context: SessionReplacementContext): boolean {
	if (handoff.reason !== context.reason) return false;
	if (handoff.oldSessionFile && context.previousSessionFile && handoff.oldSessionFile !== context.previousSessionFile) return false;
	if (handoff.oldSessionFile && !context.previousSessionFile) return false;
	if (handoff.targetSessionFile && context.sessionFile && handoff.targetSessionFile !== context.sessionFile) return false;
	if (handoff.targetSessionFile && !context.sessionFile) return false;
	return true;
}

function retargetBrokerStateForReplacement(brokerState: BrokerState, handoff: SessionReplacementHandoff, registration: SessionRegistration): void {
	const oldSessionId = handoff.oldSessionId;
	delete brokerState.sessions[oldSessionId];
	for (const [key, route] of Object.entries(brokerState.routes)) {
		if (route.sessionId !== oldSessionId) continue;
		delete brokerState.routes[key];
	}
	const route: TelegramRoute = {
		...handoff.route,
		sessionId: registration.sessionId,
		topicName: handoff.route.topicName || registration.topicName,
		updatedAtMs: now(),
	};
	brokerState.routes[canonicalRouteKey(route)] = route;
	for (const [cleanupId, cleanup] of Object.entries(brokerState.pendingRouteCleanups ?? {})) {
		if (routeMatchesTopicIdentity(route, cleanup.route)) delete brokerState.pendingRouteCleanups![cleanupId];
	}
	for (const pending of Object.values(brokerState.pendingTurns ?? {})) {
		pending.turn = retargetTurnToRoute(pending.turn, oldSessionId, registration.sessionId, route);
	}
	for (const pending of Object.values(brokerState.pendingAssistantFinals ?? {})) {
		pending.turn = retargetTurnToRoute(pending.turn, oldSessionId, registration.sessionId, route);
	}
	for (const operation of Object.values(brokerState.pendingManualCompactions ?? {})) {
		if (operation.sessionId !== oldSessionId) continue;
		operation.sessionId = registration.sessionId;
		operation.routeId = route.routeId;
		operation.chatId = route.chatId;
		operation.messageThreadId = route.messageThreadId;
		operation.updatedAtMs = now();
	}
	for (const control of Object.values(brokerState.queuedTurnControls ?? {})) {
		if (control.sessionId !== oldSessionId) continue;
		control.sessionId = registration.sessionId;
		control.routeId = control.routeId === undefined || control.routeId === route.routeId ? route.routeId : control.routeId;
		control.chatId = route.chatId;
		control.messageThreadId = route.messageThreadId;
		control.updatedAtMs = now();
	}
	for (const selection of Object.values(brokerState.selectorSelections ?? {})) {
		if (selection.sessionId === oldSessionId) {
			selection.sessionId = registration.sessionId;
			selection.updatedAtMs = now();
		}
	}
}
