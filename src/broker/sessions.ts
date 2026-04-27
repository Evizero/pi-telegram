import type { BrokerState, TelegramRoute, PendingTelegramTurn } from "../shared/types.js";
import { errorMessage, now } from "../shared/utils.js";
import { getTelegramRetryAfterMs, TelegramApiError } from "../telegram/api.js";
import { disconnectRequestBelongsToCurrentConnection, disconnectRequestMatchesRoute, isRouteScopedDisconnectRequest, type PendingDisconnectRequest } from "./disconnect-requests.js";

const DEFAULT_ROUTE_CLEANUP_RETRY_MS = 1_000;

interface SessionCleanupOptions {
	targetSessionId: string;
	getBrokerState: () => BrokerState | undefined;
	loadBrokerState: () => Promise<BrokerState>;
	setBrokerState: (state: BrokerState) => void;
	persistBrokerState: () => Promise<void>;
	refreshTelegramStatus: () => void;
	stopTypingLoop: (turnId: string) => void;
	callTelegram: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
	cancelPendingFinalDeliveries?: (sessionId: string, turnIds?: string[]) => Promise<void> | void;
	logTerminalCleanupFailure?: (route: TelegramRoute, reason: string) => void;
}

interface RouteCleanupOptions {
	getBrokerState: () => BrokerState | undefined;
	loadBrokerState: () => Promise<BrokerState>;
	setBrokerState: (state: BrokerState) => void;
	persistBrokerState: () => Promise<void>;
	callTelegram: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
	logTerminalCleanupFailure?: (route: TelegramRoute, reason: string) => void;
}

async function ensureBrokerState(options: Pick<SessionCleanupOptions, "getBrokerState" | "loadBrokerState" | "setBrokerState">): Promise<BrokerState> {
	const existing = options.getBrokerState();
	if (existing) return existing;
	const loaded = await options.loadBrokerState();
	options.setBrokerState(loaded);
	return loaded;
}

function queueRouteCleanup(brokerState: BrokerState, route: TelegramRoute): void {
	if (route.messageThreadId === undefined) return;
	brokerState.pendingRouteCleanups ??= {};
	brokerState.pendingRouteCleanups[route.routeId] = {
		route,
		createdAtMs: brokerState.pendingRouteCleanups[route.routeId]?.createdAtMs ?? now(),
		updatedAtMs: now(),
	};
}

function removeSelectorSelectionsForSession(brokerState: BrokerState, targetSessionId: string): void {
	for (const [chatId, selection] of Object.entries(brokerState.selectorSelections ?? {})) {
		if (selection.sessionId !== targetSessionId) continue;
		delete brokerState.selectorSelections![chatId];
	}
}

function rememberCompletedTurnId(brokerState: BrokerState, turnId: string): void {
	brokerState.completedTurnIds ??= [];
	if (!brokerState.completedTurnIds.includes(turnId)) brokerState.completedTurnIds.push(turnId);
	if (brokerState.completedTurnIds.length > 1000) brokerState.completedTurnIds.splice(0, brokerState.completedTurnIds.length - 1000);
}

function removeTurnStateForSession(brokerState: BrokerState, targetSessionId: string, stopTypingLoop: (turnId: string) => void): void {
	for (const [turnId, pending] of Object.entries(brokerState.pendingTurns ?? {})) {
		if (pending.turn.sessionId !== targetSessionId) continue;
		stopTypingLoop(turnId);
		delete brokerState.pendingTurns![turnId];
		rememberCompletedTurnId(brokerState, turnId);
		if (brokerState.assistantPreviewMessages?.[turnId]) delete brokerState.assistantPreviewMessages[turnId];
	}
	for (const [turnId, pending] of Object.entries(brokerState.pendingAssistantFinals ?? {})) {
		if (pending.turn.sessionId !== targetSessionId) continue;
		stopTypingLoop(turnId);
		delete brokerState.pendingAssistantFinals![turnId];
		rememberCompletedTurnId(brokerState, turnId);
		if (brokerState.assistantPreviewMessages?.[turnId]) delete brokerState.assistantPreviewMessages[turnId];
	}
}

function pendingOfflineSessionState(brokerState: BrokerState, targetSessionId: string, stopTypingLoop: (turnId: string) => void): { hasPendingTurns: boolean; hasPendingAssistantFinals: boolean } {
	let hasPendingTurns = false;
	let hasPendingAssistantFinals = false;
	for (const [turnId, pending] of Object.entries(brokerState.pendingTurns ?? {})) {
		if (pending.turn.sessionId !== targetSessionId) continue;
		stopTypingLoop(turnId);
		hasPendingTurns = true;
	}
	for (const [turnId, pending] of Object.entries(brokerState.pendingAssistantFinals ?? {})) {
		if (pending.turn.sessionId !== targetSessionId) continue;
		stopTypingLoop(turnId);
		hasPendingAssistantFinals = true;
	}
	return { hasPendingTurns, hasPendingAssistantFinals };
}

function detachSessionRoutes(brokerState: BrokerState, targetSessionId: string): TelegramRoute[] {
	const removedRoutes: TelegramRoute[] = [];
	for (const [id, route] of Object.entries(brokerState.routes)) {
		if (route.sessionId !== targetSessionId) continue;
		removedRoutes.push(route);
		delete brokerState.routes[id];
	}
	return removedRoutes;
}

function turnBelongsToRoute(turn: PendingTelegramTurn, route: TelegramRoute): boolean {
	if (turn.sessionId !== route.sessionId) return false;
	if (turn.routeId !== undefined) return turn.routeId === route.routeId;
	return String(turn.chatId) === String(route.chatId) && turn.messageThreadId === route.messageThreadId;
}

function pendingFinalTurnIdsForRoutes(brokerState: BrokerState, routes: TelegramRoute[]): string[] {
	return Object.entries(brokerState.pendingAssistantFinals ?? {})
		.filter(([, pending]) => routes.some((route) => turnBelongsToRoute(pending.turn, route)))
		.map(([turnId]) => turnId);
}

function removeTurnStateForRoutes(brokerState: BrokerState, routes: TelegramRoute[], stopTypingLoop: (turnId: string) => void): void {
	for (const [turnId, pending] of Object.entries(brokerState.pendingTurns ?? {})) {
		if (!routes.some((route) => turnBelongsToRoute(pending.turn, route))) continue;
		stopTypingLoop(turnId);
		delete brokerState.pendingTurns![turnId];
		rememberCompletedTurnId(brokerState, turnId);
		if (brokerState.assistantPreviewMessages?.[turnId]) delete brokerState.assistantPreviewMessages[turnId];
	}
	for (const [turnId, pending] of Object.entries(brokerState.pendingAssistantFinals ?? {})) {
		if (!routes.some((route) => turnBelongsToRoute(pending.turn, route))) continue;
		stopTypingLoop(turnId);
		delete brokerState.pendingAssistantFinals![turnId];
		rememberCompletedTurnId(brokerState, turnId);
		if (brokerState.assistantPreviewMessages?.[turnId]) delete brokerState.assistantPreviewMessages[turnId];
	}
}

function detachRoutesForDisconnectRequest(brokerState: BrokerState, request: PendingDisconnectRequest): TelegramRoute[] {
	const removedRoutes: TelegramRoute[] = [];
	for (const [id, route] of Object.entries(brokerState.routes)) {
		if (!disconnectRequestMatchesRoute(request, route)) continue;
		removedRoutes.push(route);
		delete brokerState.routes[id];
	}
	return removedRoutes;
}

function shouldPreservePreviewRefOnDeleteFailure(error: unknown): boolean {
	if (!(error instanceof TelegramApiError)) return true;
	const errorCode = error.errorCode ?? 0;
	return errorCode === 429 || errorCode >= 500;
}

function isMissingDeletedPreviewError(error: unknown): boolean {
	return error instanceof TelegramApiError
		&& error.errorCode === 400
		&& /message to delete not found/i.test(error.description ?? error.message);
}

function isAlreadyDeletedTopicError(error: unknown): boolean {
	if (!(error instanceof TelegramApiError)) return false;
	const description = (error.description ?? error.message).toLowerCase();
	if (error.errorCode !== 400) return false;
	return /message\s+thread\s+not\s+found|thread\s+not\s+found|topic\s+not\s+found|message\s+thread\s+.*closed|topic\s+.*closed/.test(description);
}

function isTerminalTopicCleanupError(error: unknown): boolean {
	if (!(error instanceof TelegramApiError)) return false;
	if (getTelegramRetryAfterMs(error) !== undefined) return false;
	const description = (error.description ?? error.message).toLowerCase();
	if (error.errorCode === 401) return true;
	if (error.errorCode === 403) {
		return /forbidden|bot\s+was\s+kicked|bot\s+was\s+blocked|bot\s+is\s+not\s+a\s+member|not\s+enough\s+rights|can't\s+delete|cannot\s+delete/.test(description);
	}
	if (error.errorCode === 400) {
		return /chat\s+not\s+found|bot\s+is\s+not\s+a\s+member|not\s+enough\s+rights|can't\s+delete|cannot\s+delete/.test(description);
	}
	return false;
}

function topicCleanupFailureReason(error: unknown): string {
	if (error instanceof TelegramApiError) return `${error.method}: ${error.description ?? error.message}`;
	return errorMessage(error);
}

async function clearVisiblePendingTurnPreviews(options: Pick<SessionCleanupOptions, "callTelegram">, brokerState: BrokerState, targetSessionId: string): Promise<void> {
	for (const [turnId, pending] of Object.entries(brokerState.pendingTurns ?? {})) {
		if (pending.turn.sessionId !== targetSessionId) continue;
		const preview = brokerState.assistantPreviewMessages?.[turnId];
		if (!preview) continue;
		try {
			await options.callTelegram("deleteMessage", { chat_id: preview.chatId, message_id: preview.messageId });
			delete brokerState.assistantPreviewMessages?.[turnId];
		} catch (error) {
			if (shouldPreservePreviewRefOnDeleteFailure(error)) continue;
			if (!isMissingDeletedPreviewError(error)) delete brokerState.assistantPreviewMessages?.[turnId];
			else delete brokerState.assistantPreviewMessages?.[turnId];
		}
	}
}

async function removeSessionFromBrokerState(options: SessionCleanupOptions, brokerState: BrokerState): Promise<void> {
	delete brokerState.sessions[options.targetSessionId];
	for (const route of detachSessionRoutes(brokerState, options.targetSessionId)) queueRouteCleanup(brokerState, route);
	removeSelectorSelectionsForSession(brokerState, options.targetSessionId);
	removeTurnStateForSession(brokerState, options.targetSessionId, options.stopTypingLoop);
}

export async function retryPendingRouteCleanupsInBroker(options: RouteCleanupOptions): Promise<{ ok: true }> {
	const brokerState = await ensureBrokerState(options);
	let changed = false;
	for (const [cleanupId, entry] of Object.entries(brokerState.pendingRouteCleanups ?? {})) {
		if (entry.retryAtMs !== undefined && entry.retryAtMs > now()) continue;
		try {
			await options.callTelegram("deleteForumTopic", { chat_id: entry.route.chatId, message_thread_id: entry.route.messageThreadId });
			delete brokerState.pendingRouteCleanups![cleanupId];
			changed = true;
		} catch (error) {
			if (isAlreadyDeletedTopicError(error)) {
				delete brokerState.pendingRouteCleanups![cleanupId];
				changed = true;
				continue;
			}
			if (isTerminalTopicCleanupError(error)) {
				delete brokerState.pendingRouteCleanups![cleanupId];
				changed = true;
				options.logTerminalCleanupFailure?.(entry.route, topicCleanupFailureReason(error));
				continue;
			}
			entry.retryAtMs = now() + (getTelegramRetryAfterMs(error) ?? DEFAULT_ROUTE_CLEANUP_RETRY_MS) + 250;
			entry.updatedAtMs = now();
			changed = true;
		}
	}
	if (changed) await options.persistBrokerState();
	return { ok: true };
}

export async function honorExplicitDisconnectRequestInBroker(options: SessionCleanupOptions & { request: PendingDisconnectRequest }): Promise<{ ok: true; honored: boolean }> {
	const { targetSessionId, request } = options;
	if (!targetSessionId || !isRouteScopedDisconnectRequest(request)) return { ok: true, honored: false };
	const brokerState = await ensureBrokerState(options);
	const currentSession = brokerState.sessions[targetSessionId];
	const requestTargetsCurrentConnection = disconnectRequestBelongsToCurrentConnection(request, currentSession);
	const targetRoutes = Object.values(brokerState.routes).filter((route) => disconnectRequestMatchesRoute(request, route));
	if (requestTargetsCurrentConnection) {
		delete brokerState.sessions[targetSessionId];
		removeSelectorSelectionsForSession(brokerState, targetSessionId);
		if (targetRoutes.length === 0) {
			await options.persistBrokerState();
			options.refreshTelegramStatus();
			return { ok: true, honored: true };
		}
	} else if (targetRoutes.length === 0) return { ok: true, honored: false };
	const pendingFinalTurnIds = pendingFinalTurnIdsForRoutes(brokerState, targetRoutes);
	if (pendingFinalTurnIds.length > 0) await options.cancelPendingFinalDeliveries?.(targetSessionId, pendingFinalTurnIds);
	for (const route of detachRoutesForDisconnectRequest(brokerState, request)) queueRouteCleanup(brokerState, route);
	removeTurnStateForRoutes(brokerState, targetRoutes, options.stopTypingLoop);
	await options.persistBrokerState();
	await retryPendingRouteCleanupsInBroker(options);
	options.refreshTelegramStatus();
	return { ok: true, honored: true };
}

export async function unregisterSessionFromBroker(options: SessionCleanupOptions): Promise<{ ok: true }> {
	const { targetSessionId } = options;
	if (!targetSessionId) return { ok: true };
	const brokerState = await ensureBrokerState(options);
	await options.cancelPendingFinalDeliveries?.(targetSessionId);
	await removeSessionFromBrokerState(options, brokerState);
	await options.persistBrokerState();
	await retryPendingRouteCleanupsInBroker(options);
	options.refreshTelegramStatus();
	return { ok: true };
}

export async function markSessionOfflineInBroker(options: SessionCleanupOptions): Promise<{ ok: true }> {
	const { targetSessionId } = options;
	if (!targetSessionId) return { ok: true };
	const brokerState = await ensureBrokerState(options);
	delete brokerState.sessions[targetSessionId];
	removeSelectorSelectionsForSession(brokerState, targetSessionId);
	const pendingState = pendingOfflineSessionState(brokerState, targetSessionId, options.stopTypingLoop);
	if (!pendingState.hasPendingAssistantFinals) {
		await clearVisiblePendingTurnPreviews(options, brokerState, targetSessionId);
		for (const route of detachSessionRoutes(brokerState, targetSessionId)) queueRouteCleanup(brokerState, route);
	}
	await options.persistBrokerState();
	await retryPendingRouteCleanupsInBroker(options);
	options.refreshTelegramStatus();
	return { ok: true };
}
