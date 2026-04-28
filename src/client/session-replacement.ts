import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { SESSION_REPLACEMENT_HANDOFF_TTL_MS } from "../shared/config.js";
import type { BrokerState, PendingTelegramTurn, SessionRegistration, TelegramRoute } from "../shared/types.js";
import { ensurePrivateDir, now, readJson, writeJson } from "../shared/utils.js";

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
}): Promise<MatchedSessionReplacementHandoff | undefined> {
	const nowMs = options.nowMs ?? now();
	const names = await readdir(options.dir).catch(() => [] as string[]);
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(options.dir, name);
		const handoff = await readJson<SessionReplacementHandoff>(path);
		if (!isValidHandoff(handoff)) continue;
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
}): Promise<boolean> {
	return (await findMatchingSessionReplacementHandoff({ ...options, deleteExpired: true })) !== undefined;
}

export async function consumeSessionReplacementHandoffInBroker(options: {
	dir: string;
	brokerState: BrokerState;
	registration: SessionRegistration;
	nowMs?: number;
}): Promise<boolean> {
	const context = options.registration.replacement;
	if (!context) return false;
	const match = await findMatchingSessionReplacementHandoff({ dir: options.dir, context, nowMs: options.nowMs, deleteExpired: true });
	if (!match) return false;
	if (match.handoff.oldSessionId === options.registration.sessionId) return false;
	retargetBrokerStateForReplacement(options.brokerState, match.handoff, options.registration);
	await rm(match.path, { force: true }).catch(() => undefined);
	return true;
}

function isValidHandoff(value: SessionReplacementHandoff | undefined): value is SessionReplacementHandoff {
	return value?.schemaVersion === 1
		&& isSessionReplacementReason(value.reason)
		&& typeof value.oldSessionId === "string"
		&& value.route !== undefined
		&& typeof value.createdAtMs === "number"
		&& typeof value.expiresAtMs === "number";
}

function handoffMatchesContext(handoff: SessionReplacementHandoff, context: SessionReplacementContext): boolean {
	if (handoff.reason !== context.reason) return false;
	if (handoff.oldSessionFile && context.previousSessionFile && handoff.oldSessionFile !== context.previousSessionFile) return false;
	if (handoff.oldSessionFile && !context.previousSessionFile) return false;
	if (handoff.targetSessionFile && context.sessionFile && handoff.targetSessionFile !== context.sessionFile) return false;
	if (handoff.targetSessionFile && !context.sessionFile) return false;
	return true;
}

function retargetTurn(turn: PendingTelegramTurn, oldSessionId: string, newSessionId: string, route: TelegramRoute): PendingTelegramTurn {
	if (turn.sessionId !== oldSessionId) return turn;
	return {
		...turn,
		sessionId: newSessionId,
		routeId: turn.routeId === undefined || turn.routeId === route.routeId ? route.routeId : turn.routeId,
		chatId: route.chatId,
		messageThreadId: route.messageThreadId,
	};
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
	const routeKey = route.messageThreadId === undefined ? `${route.routeId}:${registration.sessionId}` : route.routeId;
	brokerState.routes[routeKey] = route;
	for (const pending of Object.values(brokerState.pendingTurns ?? {})) {
		pending.turn = retargetTurn(pending.turn, oldSessionId, registration.sessionId, route);
	}
	for (const pending of Object.values(brokerState.pendingAssistantFinals ?? {})) {
		pending.turn = retargetTurn(pending.turn, oldSessionId, registration.sessionId, route);
	}
	for (const selection of Object.values(brokerState.selectorSelections ?? {})) {
		if (selection.sessionId === oldSessionId) {
			selection.sessionId = registration.sessionId;
			selection.updatedAtMs = now();
		}
	}
}
