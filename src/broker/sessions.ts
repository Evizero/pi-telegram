import type { BrokerState, QueuedTurnControlState, TelegramRoute } from "../shared/types.js";
import { now } from "../shared/utils.js";
import {
	isMissingDeletedTelegramMessage,
	shouldPreserveTelegramMessageRefOnDeleteFailure,
} from "../telegram/errors.js";
import { deleteTelegramMessage } from "../telegram/message-ops.js";
import { disconnectRequestBelongsToCurrentConnection, disconnectRequestMatchesRoute, isRouteScopedDisconnectRequest, type PendingDisconnectRequest } from "./disconnect-requests.js";
import { cleanupTargetsActiveRoute, detachRoutesForSessionAndQueueCleanup, queueRouteCleanup, turnBelongsToRoute } from "./routes.js";
import { markQueuedTurnControlExpired, queuedControlBelongsToRoute, QUEUED_CONTROL_TEXT } from "./queued-controls.js";
import { createTelegramOutboxRunnerState, drainTelegramOutboxInBroker, enqueueQueuedControlStatusEditJob, markRouteQueuedControlsForCleanup, migrateLegacyTelegramOutboxState, type TelegramOutboxRunnerState } from "./telegram-outbox.js";

const defaultTelegramOutboxRunner = createTelegramOutboxRunnerState();

interface SessionCleanupOptions {
	targetSessionId: string;
	getBrokerState: () => BrokerState | undefined;
	loadBrokerState: () => Promise<BrokerState>;
	setBrokerState: (state: BrokerState) => void;
	persistBrokerState: () => Promise<void>;
	refreshTelegramStatus: () => void;
	stopTypingLoop: (turnId: string) => void;
	callTelegram: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
	assertCanDeleteRoute?: () => Promise<void> | void;
	telegramOutbox?: TelegramOutboxRunnerState;
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
	assertCanDeleteRoute?: () => Promise<void> | void;
	telegramOutbox?: TelegramOutboxRunnerState;
	logTerminalCleanupFailure?: (route: TelegramRoute, reason: string) => void;
}

async function ensureBrokerState(options: Pick<SessionCleanupOptions, "getBrokerState" | "loadBrokerState" | "setBrokerState">): Promise<BrokerState> {
	const existing = options.getBrokerState();
	if (existing) return existing;
	const loaded = await options.loadBrokerState();
	options.setBrokerState(loaded);
	return loaded;
}

function removeSelectorSelectionsForSession(brokerState: BrokerState, targetSessionId: string): void {
	for (const [chatId, selection] of Object.entries(brokerState.selectorSelections ?? {})) {
		if (selection.sessionId !== targetSessionId) continue;
		delete brokerState.selectorSelections![chatId];
	}
}

function removePendingManualCompactionsForSession(brokerState: BrokerState, targetSessionId: string): string[] {
	const removedOperationIds: string[] = [];
	for (const [operationId, operation] of Object.entries(brokerState.pendingManualCompactions ?? {})) {
		if (operation.sessionId !== targetSessionId) continue;
		delete brokerState.pendingManualCompactions![operationId];
		removedOperationIds.push(operationId);
	}
	return removedOperationIds;
}

function removePendingTurnsBlockedByManualCompactions(brokerState: BrokerState, operationIds: string[], stopTypingLoop: (turnId: string) => void): string[] {
	if (operationIds.length === 0) return [];
	const operationIdSet = new Set(operationIds);
	const removedTurnIds: string[] = [];
	for (const [turnId, pending] of Object.entries(brokerState.pendingTurns ?? {})) {
		const blocker = pending.turn.blockedByManualCompactionOperationId;
		if (!blocker || !operationIdSet.has(blocker)) continue;
		stopTypingLoop(turnId);
		delete brokerState.pendingTurns![turnId];
		rememberCompletedTurnId(brokerState, turnId);
		removedTurnIds.push(turnId);
		if (brokerState.assistantPreviewMessages?.[turnId]) delete brokerState.assistantPreviewMessages[turnId];
	}
	return removedTurnIds;
}

function removePendingManualCompactionsForRoutes(brokerState: BrokerState, routes: TelegramRoute[]): void {
	for (const [operationId, operation] of Object.entries(brokerState.pendingManualCompactions ?? {})) {
		if (!routes.some((route) => operation.routeId === route.routeId || (String(operation.chatId) === String(route.chatId) && operation.messageThreadId === route.messageThreadId))) continue;
		delete brokerState.pendingManualCompactions![operationId];
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

function telegramOutboxRunner(options: Pick<SessionCleanupOptions, "telegramOutbox"> | Pick<RouteCleanupOptions, "telegramOutbox">): TelegramOutboxRunnerState {
	return options.telegramOutbox ?? defaultTelegramOutboxRunner;
}

async function drainTelegramCleanupOutbox(options: SessionCleanupOptions | RouteCleanupOptions, jobKinds?: Array<"queued_control_status_edit" | "route_topic_delete">): Promise<void> {
	await drainTelegramOutboxInBroker(telegramOutboxRunner(options), {
		getBrokerState: options.getBrokerState,
		loadBrokerState: options.loadBrokerState,
		setBrokerState: options.setBrokerState,
		persistBrokerState: options.persistBrokerState,
		callTelegram: options.callTelegram,
		assertCanRun: options.assertCanDeleteRoute,
		logTerminalCleanupFailure: options.logTerminalCleanupFailure,
		jobKinds,
	});
}

async function enqueueAndDrainQueuedControlFinalizations(options: SessionCleanupOptions | RouteCleanupOptions, brokerState: BrokerState, controls: QueuedTurnControlState[]): Promise<void> {
	let changed = false;
	for (const control of controls) changed = enqueueQueuedControlStatusEditJob(brokerState, control) || changed;
	changed = migrateLegacyTelegramOutboxState(brokerState) || changed;
	if (changed) await options.persistBrokerState();
	await drainTelegramCleanupOutbox(options, ["queued_control_status_edit"]);
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

async function clearVisiblePendingTurnPreviews(options: Pick<SessionCleanupOptions, "callTelegram">, brokerState: BrokerState, targetSessionId: string): Promise<void> {
	for (const [turnId, pending] of Object.entries(brokerState.pendingTurns ?? {})) {
		if (pending.turn.sessionId !== targetSessionId) continue;
		const preview = brokerState.assistantPreviewMessages?.[turnId];
		if (!preview) continue;
		try {
			await deleteTelegramMessage(options.callTelegram, preview.chatId, preview.messageId, { ignoreMissing: true });
			delete brokerState.assistantPreviewMessages?.[turnId];
		} catch (error) {
			if (shouldPreserveTelegramMessageRefOnDeleteFailure(error)) continue;
			if (!isMissingDeletedTelegramMessage(error)) delete brokerState.assistantPreviewMessages?.[turnId];
			else delete brokerState.assistantPreviewMessages?.[turnId];
		}
	}
}

async function removeSessionFromBrokerState(options: SessionCleanupOptions, brokerState: BrokerState): Promise<QueuedTurnControlState[]> {
	delete brokerState.sessions[options.targetSessionId];
	detachRoutesForSessionAndQueueCleanup(brokerState, options.targetSessionId);
	removeSelectorSelectionsForSession(brokerState, options.targetSessionId);
	removePendingManualCompactionsForSession(brokerState, options.targetSessionId);
	const removedTurnIds = removeTurnStateForSession(brokerState, options.targetSessionId, options.stopTypingLoop);
	return markQueuedControlsCleared(brokerState, removedTurnIds, QUEUED_CONTROL_TEXT.cleared, (control) => control.sessionId === options.targetSessionId);
}

async function cleanupSessionTempDirIfPossible(options: SessionCleanupOptions, brokerState: BrokerState): Promise<void> {
	await options.cleanupSessionTempDir?.(options.targetSessionId, brokerState);
}

export async function retryPendingRouteCleanupsInBroker(options: RouteCleanupOptions): Promise<{ ok: true }> {
	const brokerState = await ensureBrokerState(options);
	let changed = migrateLegacyTelegramOutboxState(brokerState);
	for (const [cleanupId, entry] of Object.entries(brokerState.pendingRouteCleanups ?? {})) {
		if (cleanupTargetsActiveRoute(brokerState, entry.route)) {
			delete brokerState.pendingRouteCleanups![cleanupId];
			changed = true;
			continue;
		}
		const markedControls = markRouteQueuedControlsForCleanup(brokerState, entry.route);
		changed = markedControls.length > 0 || changed;
	}
	if (changed) await options.persistBrokerState();
	await drainTelegramCleanupOutbox(options);
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
		removePendingManualCompactionsForSession(brokerState, targetSessionId);
		finalizedSessionControls = markQueuedControlsCleared(brokerState, [], QUEUED_CONTROL_TEXT.cleared, (control) => control.sessionId === targetSessionId);
		if (targetRoutes.length === 0) {
			await options.persistBrokerState();
			await enqueueAndDrainQueuedControlFinalizations(options, brokerState, finalizedSessionControls);
			await cleanupSessionTempDirIfPossible(options, brokerState);
			options.refreshTelegramStatus();
			return { ok: true, honored: true };
		}
	} else if (targetRoutes.length === 0) return { ok: true, honored: false };
	const pendingFinalTurnIds = pendingFinalTurnIdsForRoutes(brokerState, targetRoutes);
	if (pendingFinalTurnIds.length > 0) await options.cancelPendingFinalDeliveries?.(targetSessionId, pendingFinalTurnIds);
	for (const route of detachRoutesForDisconnectRequest(brokerState, request)) queueRouteCleanup(brokerState, route);
	removePendingManualCompactionsForRoutes(brokerState, targetRoutes);
	const removedTurnIds = removeTurnStateForRoutes(brokerState, targetRoutes, options.stopTypingLoop);
	const finalizedControls = requestTargetsCurrentConnection ? finalizedSessionControls : markQueuedControlsCleared(brokerState, removedTurnIds, QUEUED_CONTROL_TEXT.cleared, (control) => targetRoutes.some((route) => queuedControlBelongsToRoute(control, route)));
	await options.persistBrokerState();
	await enqueueAndDrainQueuedControlFinalizations(options, brokerState, finalizedControls);
	await retryPendingRouteCleanupsInBroker(options);
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
	await enqueueAndDrainQueuedControlFinalizations(options, brokerState, finalizedControls);
	await retryPendingRouteCleanupsInBroker(options);
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
	const removedCompactionIds = removePendingManualCompactionsForSession(brokerState, targetSessionId);
	removePendingTurnsBlockedByManualCompactions(brokerState, removedCompactionIds, options.stopTypingLoop);
	const pendingState = pendingOfflineSessionState(brokerState, targetSessionId, options.stopTypingLoop);
	if (!pendingState.hasPendingAssistantFinals) {
		await clearVisiblePendingTurnPreviews(options, brokerState, targetSessionId);
		detachRoutesForSessionAndQueueCleanup(brokerState, targetSessionId);
	}
	const finalizedControls = markQueuedControlsCleared(brokerState, [], QUEUED_CONTROL_TEXT.cleared, (control) => control.sessionId === targetSessionId);
	await options.persistBrokerState();
	await enqueueAndDrainQueuedControlFinalizations(options, brokerState, finalizedControls);
	await retryPendingRouteCleanupsInBroker(options);
	await cleanupSessionTempDirIfPossible(options, brokerState);
	options.refreshTelegramStatus();
	return { ok: true };
}
