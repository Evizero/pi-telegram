import type { BrokerState, QueuedTurnControlState, TelegramRoute, PendingTelegramTurn } from "../shared/types.js";
import { errorMessage, now } from "../shared/utils.js";
import { getTelegramRetryAfterMs, TelegramApiError } from "../telegram/api.js";
import { editTelegramTextMessage } from "../telegram/text.js";
import { disconnectRequestBelongsToCurrentConnection, disconnectRequestMatchesRoute, isRouteScopedDisconnectRequest, type PendingDisconnectRequest } from "./disconnect-requests.js";
import { DEFAULT_QUEUED_CONTROL_EDIT_RETRY_MS, isTransientQueuedControlEditError, markQueuedTurnControlExpired, queuedControlBelongsToRoute, QUEUED_CONTROL_TEXT } from "./queued-controls.js";

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
	cleanupSessionTempDir?: (sessionId: string, brokerState: BrokerState) => Promise<void> | void;
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

function removeTurnStateForSession(brokerState: BrokerState, targetSessionId: string, stopTypingLoop: (turnId: string) => void): string[] {
	const removedTurnIds: string[] = [];
	for (const [turnId, pending] of Object.entries(brokerState.pendingTurns ?? {})) {
		if (pending.turn.sessionId !== targetSessionId) continue;
		stopTypingLoop(turnId);
		delete brokerState.pendingTurns![turnId];
		rememberCompletedTurnId(brokerState, turnId);
		removedTurnIds.push(turnId);
		if (brokerState.assistantPreviewMessages?.[turnId]) delete brokerState.assistantPreviewMessages[turnId];
	}
	for (const [turnId, pending] of Object.entries(brokerState.pendingAssistantFinals ?? {})) {
		if (pending.turn.sessionId !== targetSessionId) continue;
		stopTypingLoop(turnId);
		delete brokerState.pendingAssistantFinals![turnId];
		rememberCompletedTurnId(brokerState, turnId);
		removedTurnIds.push(turnId);
		if (brokerState.assistantPreviewMessages?.[turnId]) delete brokerState.assistantPreviewMessages[turnId];
	}
	return removedTurnIds;
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

function removeTurnStateForRoutes(brokerState: BrokerState, routes: TelegramRoute[], stopTypingLoop: (turnId: string) => void): string[] {
	const removedTurnIds: string[] = [];
	for (const [turnId, pending] of Object.entries(brokerState.pendingTurns ?? {})) {
		if (!routes.some((route) => turnBelongsToRoute(pending.turn, route))) continue;
		stopTypingLoop(turnId);
		delete brokerState.pendingTurns![turnId];
		rememberCompletedTurnId(brokerState, turnId);
		removedTurnIds.push(turnId);
		if (brokerState.assistantPreviewMessages?.[turnId]) delete brokerState.assistantPreviewMessages[turnId];
	}
	for (const [turnId, pending] of Object.entries(brokerState.pendingAssistantFinals ?? {})) {
		if (!routes.some((route) => turnBelongsToRoute(pending.turn, route))) continue;
		stopTypingLoop(turnId);
		delete brokerState.pendingAssistantFinals![turnId];
		rememberCompletedTurnId(brokerState, turnId);
		removedTurnIds.push(turnId);
		if (brokerState.assistantPreviewMessages?.[turnId]) delete brokerState.assistantPreviewMessages[turnId];
	}
	return removedTurnIds;
}

function markQueuedControlsCleared(brokerState: BrokerState, turnIds: string[], text: string = QUEUED_CONTROL_TEXT.cleared, matchesControl?: (control: QueuedTurnControlState) => boolean): QueuedTurnControlState[] {
	if (!brokerState.queuedTurnControls) return [];
	const turnIdSet = new Set(turnIds);
	const controls: QueuedTurnControlState[] = [];
	for (const control of Object.values(brokerState.queuedTurnControls)) {
		const matches = turnIdSet.has(control.turnId) || matchesControl?.(control) === true;
		if (!matches) continue;
		if (control.statusMessageId !== undefined && control.completedText && control.statusMessageFinalizedAtMs === undefined) {
			controls.push(control);
			continue;
		}
		if (!markQueuedTurnControlExpired(control, text)) continue;
		controls.push(control);
	}
	return controls;
}

async function finalizeQueuedControlMessages(options: Pick<SessionCleanupOptions, "callTelegram" | "persistBrokerState">, brokerState: BrokerState, controls: QueuedTurnControlState[]): Promise<{ deferred: boolean; retryAtMs?: number }> {
	let changed = false;
	let deferred = false;
	let retryAtMs: number | undefined;
	if (brokerState.queuedTurnControlCleanupRetryAtMs !== undefined) {
		if (brokerState.queuedTurnControlCleanupRetryAtMs > now()) return { deferred: true, retryAtMs: brokerState.queuedTurnControlCleanupRetryAtMs };
		delete brokerState.queuedTurnControlCleanupRetryAtMs;
		changed = true;
	}
	const pendingRetryAtMs = controls.reduce<number | undefined>((earliest, control) => {
		if (control.statusMessageRetryAtMs === undefined || control.statusMessageRetryAtMs <= now()) return earliest;
		return earliest === undefined ? control.statusMessageRetryAtMs : Math.min(earliest, control.statusMessageRetryAtMs);
	}, undefined);
	if (pendingRetryAtMs !== undefined) {
		brokerState.queuedTurnControlCleanupRetryAtMs = pendingRetryAtMs;
		await options.persistBrokerState();
		return { deferred: true, retryAtMs: pendingRetryAtMs };
	}
	for (const control of controls) {
		if (control.statusMessageId === undefined || !control.completedText || control.statusMessageFinalizedAtMs !== undefined) continue;
		if (control.statusMessageRetryAtMs !== undefined && control.statusMessageRetryAtMs > now()) {
			deferred = true;
			retryAtMs = retryAtMs === undefined ? control.statusMessageRetryAtMs : Math.min(retryAtMs, control.statusMessageRetryAtMs);
			brokerState.queuedTurnControlCleanupRetryAtMs = retryAtMs;
			changed = true;
			break;
		}
		try {
			await editTelegramTextMessage(options.callTelegram, control.chatId, control.statusMessageId, control.completedText);
		} catch (error) {
			const retryAfterMs = getTelegramRetryAfterMs(error);
			if (retryAfterMs !== undefined || isTransientQueuedControlEditError(error)) {
				control.statusMessageRetryAtMs = now() + (retryAfterMs ?? DEFAULT_QUEUED_CONTROL_EDIT_RETRY_MS) + (retryAfterMs !== undefined ? 250 : 0);
				brokerState.queuedTurnControlCleanupRetryAtMs = control.statusMessageRetryAtMs;
				retryAtMs = retryAtMs === undefined ? control.statusMessageRetryAtMs : Math.min(retryAtMs, control.statusMessageRetryAtMs);
				control.updatedAtMs = now();
				changed = true;
				deferred = true;
				break;
			}
		}
		control.statusMessageRetryAtMs = undefined;
		control.statusMessageFinalizedAtMs = now();
		control.updatedAtMs = now();
		changed = true;
	}
	if (changed) await options.persistBrokerState();
	return { deferred, retryAtMs };
}

function deferPendingRouteCleanups(brokerState: BrokerState, retryAtMs: number | undefined): boolean {
	if (retryAtMs === undefined) return false;
	let changed = false;
	for (const cleanup of Object.values(brokerState.pendingRouteCleanups ?? {})) {
		if (cleanup.retryAtMs !== undefined && cleanup.retryAtMs >= retryAtMs) continue;
		cleanup.retryAtMs = retryAtMs;
		cleanup.updatedAtMs = now();
		changed = true;
	}
	return changed;
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

async function removeSessionFromBrokerState(options: SessionCleanupOptions, brokerState: BrokerState): Promise<QueuedTurnControlState[]> {
	delete brokerState.sessions[options.targetSessionId];
	for (const route of detachSessionRoutes(brokerState, options.targetSessionId)) queueRouteCleanup(brokerState, route);
	removeSelectorSelectionsForSession(brokerState, options.targetSessionId);
	const removedTurnIds = removeTurnStateForSession(brokerState, options.targetSessionId, options.stopTypingLoop);
	return markQueuedControlsCleared(brokerState, removedTurnIds, QUEUED_CONTROL_TEXT.cleared, (control) => control.sessionId === options.targetSessionId);
}

async function cleanupSessionTempDirIfPossible(options: SessionCleanupOptions, brokerState: BrokerState): Promise<void> {
	await options.cleanupSessionTempDir?.(options.targetSessionId, brokerState);
}

export async function retryPendingRouteCleanupsInBroker(options: RouteCleanupOptions): Promise<{ ok: true }> {
	const brokerState = await ensureBrokerState(options);
	let changed = false;
	for (const [cleanupId, entry] of Object.entries(brokerState.pendingRouteCleanups ?? {})) {
		if (entry.retryAtMs !== undefined && entry.retryAtMs > now()) continue;
		const markedControls = markQueuedControlsCleared(brokerState, [], QUEUED_CONTROL_TEXT.cleared, (control) => queuedControlBelongsToRoute(control, entry.route));
		if (markedControls.length > 0) {
			changed = true;
			await options.persistBrokerState();
		}
		const pendingQueuedControls = Object.values(brokerState.queuedTurnControls ?? {}).filter((control) => queuedControlBelongsToRoute(control, entry.route) && control.statusMessageId !== undefined && control.completedText !== undefined && control.statusMessageFinalizedAtMs === undefined);
		const queuedControlCleanup = await finalizeQueuedControlMessages(options, brokerState, pendingQueuedControls);
		if (queuedControlCleanup.deferred) {
			entry.retryAtMs = queuedControlCleanup.retryAtMs;
			brokerState.queuedTurnControlCleanupRetryAtMs = queuedControlCleanup.retryAtMs;
			entry.updatedAtMs = now();
			changed = true;
			continue;
		}
		if (pendingQueuedControls.some((control) => control.statusMessageFinalizedAtMs === undefined)) continue;
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
	let finalizedSessionControls: QueuedTurnControlState[] = [];
	if (requestTargetsCurrentConnection) {
		delete brokerState.sessions[targetSessionId];
		removeSelectorSelectionsForSession(brokerState, targetSessionId);
		finalizedSessionControls = markQueuedControlsCleared(brokerState, [], QUEUED_CONTROL_TEXT.cleared, (control) => control.sessionId === targetSessionId);
		if (targetRoutes.length === 0) {
			await options.persistBrokerState();
			await finalizeQueuedControlMessages(options, brokerState, finalizedSessionControls);
			await cleanupSessionTempDirIfPossible(options, brokerState);
			options.refreshTelegramStatus();
			return { ok: true, honored: true };
		}
	} else if (targetRoutes.length === 0) return { ok: true, honored: false };
	const pendingFinalTurnIds = pendingFinalTurnIdsForRoutes(brokerState, targetRoutes);
	if (pendingFinalTurnIds.length > 0) await options.cancelPendingFinalDeliveries?.(targetSessionId, pendingFinalTurnIds);
	for (const route of detachRoutesForDisconnectRequest(brokerState, request)) queueRouteCleanup(brokerState, route);
	const removedTurnIds = removeTurnStateForRoutes(brokerState, targetRoutes, options.stopTypingLoop);
	const finalizedControls = requestTargetsCurrentConnection ? finalizedSessionControls : markQueuedControlsCleared(brokerState, removedTurnIds, QUEUED_CONTROL_TEXT.cleared, (control) => targetRoutes.some((route) => queuedControlBelongsToRoute(control, route)));
	await options.persistBrokerState();
	const queuedControlCleanup = await finalizeQueuedControlMessages(options, brokerState, finalizedControls);
	if (queuedControlCleanup.deferred) {
		brokerState.queuedTurnControlCleanupRetryAtMs = queuedControlCleanup.retryAtMs;
		deferPendingRouteCleanups(brokerState, queuedControlCleanup.retryAtMs);
		await options.persistBrokerState();
	}
	if (!queuedControlCleanup.deferred) await retryPendingRouteCleanupsInBroker(options);
	await cleanupSessionTempDirIfPossible(options, brokerState);
	options.refreshTelegramStatus();
	return { ok: true, honored: true };
}

export async function unregisterSessionFromBroker(options: SessionCleanupOptions): Promise<{ ok: true }> {
	const { targetSessionId } = options;
	if (!targetSessionId) return { ok: true };
	const brokerState = await ensureBrokerState(options);
	await options.cancelPendingFinalDeliveries?.(targetSessionId);
	const finalizedControls = await removeSessionFromBrokerState(options, brokerState);
	await options.persistBrokerState();
	const queuedControlCleanup = await finalizeQueuedControlMessages(options, brokerState, finalizedControls);
	if (queuedControlCleanup.deferred) {
		brokerState.queuedTurnControlCleanupRetryAtMs = queuedControlCleanup.retryAtMs;
		deferPendingRouteCleanups(brokerState, queuedControlCleanup.retryAtMs);
		await options.persistBrokerState();
	}
	if (!queuedControlCleanup.deferred) await retryPendingRouteCleanupsInBroker(options);
	await cleanupSessionTempDirIfPossible(options, brokerState);
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
	const finalizedControls = markQueuedControlsCleared(brokerState, [], QUEUED_CONTROL_TEXT.cleared, (control) => control.sessionId === targetSessionId);
	await options.persistBrokerState();
	const queuedControlCleanup = await finalizeQueuedControlMessages(options, brokerState, finalizedControls);
	if (queuedControlCleanup.deferred) {
		brokerState.queuedTurnControlCleanupRetryAtMs = queuedControlCleanup.retryAtMs;
		deferPendingRouteCleanups(brokerState, queuedControlCleanup.retryAtMs);
		await options.persistBrokerState();
	}
	if (!queuedControlCleanup.deferred) await retryPendingRouteCleanupsInBroker(options);
	await cleanupSessionTempDirIfPossible(options, brokerState);
	options.refreshTelegramStatus();
	return { ok: true };
}
