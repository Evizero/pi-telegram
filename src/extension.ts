import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BROKER_HEARTBEAT_MS, CLIENT_HEARTBEAT_MS } from "./broker/policy.js";
import { BROKER_DIR, DISCONNECT_REQUESTS_DIR, LOCK_DIR, LOCK_PATH, SESSION_REPLACEMENT_HANDOFFS_DIR, STATE_PATH, TEMP_DIR } from "./shared/paths.js";
import type { ActiveActivityMessageRef, BrokerLease, BrokerState, SessionRegistration, TelegramRoute } from "./broker/types.js";
import type { PendingTelegramTurn, AssistantFinalPayload } from "./client/types.js";
import type { IpcEnvelope } from "./shared/ipc-types.js";
import type { TelegramMediaGroupState, TelegramMessage } from "./telegram/types.js";
import type { TelegramConfig } from "./shared/config-types.js";
import { readConfig, writeConfig } from "./shared/config.js";
import { configureBrokerScope } from "./shared/paths.js";
import { ActivityRenderer, ActivityReporter, type ActivityUpdatePayload } from "./broker/activity.js";
import { isRouteScopedDisconnectRequest, processDisconnectRequestsInBroker, readPendingDisconnectRequestFromPath, readPendingDisconnectRequestsFromDir, type PendingDisconnectRequest } from "./broker/disconnect-requests.js";
import { handleBrokerBackgroundError, runBrokerBackgroundTask } from "./broker/background.js";
import { createBrokerHeartbeatState, runBrokerHeartbeatCycle } from "./broker/heartbeat.js";
import { renewBrokerLease as renewBrokerLeaseFile, StaleBrokerError, tryAcquireBrokerLease } from "./broker/lease.js";
import { targetChatIdForRoutes as routeTargetChatIdForRoutes, usesForumSupergroupRouting as routeUsesForumSupergroupRouting } from "./broker/routes.js";
import { honorExplicitDisconnectRequestInBroker, unregisterSessionFromBroker, markSessionOfflineInBroker, retryPendingRouteCleanupsInBroker } from "./broker/sessions.js";
import { createTelegramOutboxRunnerState, drainTelegramOutboxInBroker } from "./broker/telegram-outbox.js";
import { BrokerSessionRegistrationCoordinator, isStaleSessionConnectionError } from "./broker/session-registration.js";
import { createRuntimeUpdateHandlers } from "./broker/updates.js";
import { resolveAllowedAttachmentPath as resolveSafeAttachmentPath } from "./client/attachment-path.js";
import { consumeSessionReplacementHandoffInBroker, hasMatchingSessionReplacementHandoff, isSessionReplacementReason, writeSessionReplacementHandoff, type SessionReplacementContext } from "./client/session-replacement.js";
import { ClientAssistantFinalHandoff } from "./client/final-handoff.js";
import { RetryAwareTelegramTurnFinalizer } from "./client/retry-aware-finalization.js";
import { ClientRuntimeHost } from "./client/runtime-host.js";
import { TelegramCommandRouter } from "./broker/commands.js";
import { QUEUED_CONTROL_TEXT } from "./shared/queued-control-text.js";
import { AssistantFinalDeliveryLedger } from "./broker/finals.js";
import { handleLocalUserMirrorMessage } from "./broker/local-user-message.js";
import { ensurePrivateDir, errorMessage, invalidDurableJson, isRecord, now, processExists, randomId, readJson, writeJson } from "./shared/utils.js";
import { createIpcServer as createIpcServerBase, postIpc as postIpcBase } from "./shared/ipc.js";
import { callTelegram as callTelegramBase, callTelegramMultipart as callTelegramMultipartBase, downloadTelegramFile as downloadTelegramFileBase } from "./telegram/api.js";
import { getTelegramRetryAfterMs } from "./telegram/api-errors.js";
import { withTelegramRetry } from "./telegram/retry.js";
import { sendTelegramMarkdownReply, sendTelegramTextReply, type SendTextReplyOptions } from "./telegram/text.js";
import { createTelegramTurnForSession as buildTelegramTurnForSession, durableTelegramTurn } from "./telegram/turns.js";
import { PreviewManager } from "./telegram/previews.js";
import { cleanupDownloadedTelegramSessionTempDirIfUnused, sweepOrphanedDownloadedTelegramSessionTempDirs } from "./telegram/temp-files.js";
import { createTypingLoopController } from "./telegram/typing.js";
import { createPiDiagnosticReporter } from "./pi/diagnostics.js";
import { registerRuntimePiHooks, type RuntimePiHooksDeps } from "./pi/hooks.js";
import { promptForTelegramConfig } from "./telegram/setup.js";
import { pairingInstructions, telegramStatusText } from "./shared/ui-status.js";
export interface TelegramRuntime {
	hooks: RuntimePiHooksDeps;
	isConnected: () => boolean;
}

export function createTelegramRuntime(pi: ExtensionAPI): TelegramRuntime {
	const ownerId = randomId("own");
	const startedAtMs = now();
	let sessionId = randomId("pis");
	let config: TelegramConfig = {};
	let latestCtx: ExtensionContext | undefined;
	let brokerServer: Server | undefined;
	let isBroker = false;
	let brokerLeaseEpoch = 0;
	let brokerToken = "";
	let brokerState: BrokerState | undefined;
	let brokerPollAbort: AbortController | undefined;
	let brokerHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
	const brokerHeartbeatState = createBrokerHeartbeatState();
	const telegramOutboxRunner = createTelegramOutboxRunnerState();
	let sessionReplacementContext: SessionReplacementContext | undefined;
	let localBrokerSocketPath = join(BROKER_DIR, `broker-${ownerId}.sock`);
	let connectedBrokerSocketPath = localBrokerSocketPath;
	let clientHost: ClientRuntimeHost;
	function applyBrokerScope(): void {
		configureBrokerScope(config.botId);
		clientHost?.refreshBrokerScope();
		localBrokerSocketPath = join(BROKER_DIR, `broker-${ownerId}.sock`);
		if (!clientHost?.getConnectedRoute()) connectedBrokerSocketPath = localBrokerSocketPath;
	}
	function setLatestContext(ctx: ExtensionContext): string {
		latestCtx = ctx;
		return (sessionId = ctx.sessionManager.getSessionId());
	}
	let setupInProgress = false;
	let telegramStatusVisible = false;
	const mediaGroups = new Map<string, TelegramMediaGroupState>();
	const typingLoops = createTypingLoopController((body, signal) => callTelegram("sendChatAction", body, { signal }));
	let activeTurnFinalizer: RetryAwareTelegramTurnFinalizer;
	const assistantFinalHandoff = new ClientAssistantFinalHandoff({
		getSessionId: () => sessionId,
		getConnectionNonce: () => clientHost.getConnectionNonce(),
		getConnectionStartedAtMs: () => clientHost.getConnectionStartedAtMs(),
		getConnectedRoute: () => clientHost.getConnectedRoute(),
		isTurnDisconnected: (turnId) => clientHost.isTurnDisconnected(turnId),
		peekDeferredPayload: () => activeTurnFinalizer?.peekDeferredPayload(),
		getBrokerState: () => brokerState,
		acceptBrokerFinal: (payload) => assistantFinalLedger.accept(payload),
		postAssistantFinal: (payload) => postIpc(connectedBrokerSocketPath, "assistant_final", payload, sessionId),
		postRestoreDeferredFinal: (clientSocketPath, targetSessionId, payload) => postIpc(clientSocketPath, "restore_deferred_final", payload, targetSessionId),
		readLease,
		isLeaseLive,
		setConnectedBrokerSocketPath: (socketPath) => { connectedBrokerSocketPath = socketPath; },
		isStaleSessionConnectionError,
		getAwaitingTelegramFinalTurnId: () => clientHost.getAwaitingTelegramFinalTurnId(),
		clearAwaitingTelegramFinalTurn: (turnId) => { clientHost.clearAwaitingTelegramFinalTurn(turnId); },
		getActiveTelegramTurn: () => clientHost.getActiveTelegramTurn(),
		setActiveTelegramTurn: (turn) => { clientHost.setActiveTelegramTurn(turn); },
		rememberCompletedLocalTurn: (turnId) => clientHost.rememberCompletedLocalTurn(turnId),
		startNextTelegramTurn: () => clientHost.startNextTelegramTurn(),
		reportInvalidDurableState,
	});
	activeTurnFinalizer = new RetryAwareTelegramTurnFinalizer({
		getActiveTelegramTurn: () => clientHost.getActiveTelegramTurn(),
		setActiveTelegramTurn: (turn) => { clientHost.setActiveTelegramTurn(turn); },
		rememberCompletedLocalTurn: (turnId) => clientHost.rememberCompletedLocalTurn(turnId),
		startNextTelegramTurn: () => clientHost.startNextTelegramTurn(),
		sendAssistantFinalToBroker,
		handoffAssistantFinalToBroker: handoffAssistantFinalToBrokerConfirmed,
		setAwaitingTelegramFinalTurn: (turnId) => { clientHost.setAwaitingTelegramFinalTurn(turnId); },
		persistDeferredState: () => assistantFinalHandoff.persistDeferredState(sessionId),
		clearPreview: async (turnId, chatId, messageThreadId) => {
			await clearAssistantPreviewInBroker(turnId, chatId, messageThreadId, true);
		},
	});
	clientHost = new ClientRuntimeHost({
		pi,
		ownerId,
		startedAtMs,
		getSessionId: () => sessionId,
		getLatestCtx: () => latestCtx,
		setLatestContext,
		getSessionReplacementContext: () => sessionReplacementContext,
		getConfig: () => config,
		setConfig: (nextConfig) => { config = nextConfig; },
		readConfig,
		writeConfig,
		showTelegramStatus,
		promptForConfig,
		applyBrokerScope,
		callTelegram,
		readLease,
		isLeaseLive,
		tryAcquireBroker,
		ensureBrokerStarted,
		getLocalBrokerSocketPath: () => localBrokerSocketPath,
		getConnectedBrokerSocketPath: () => connectedBrokerSocketPath,
		setConnectedBrokerSocketPath: (socketPath) => { connectedBrokerSocketPath = socketPath; },
		createIpcServer,
		postIpc,
		acknowledgeStaleClientConnection: async (connectionNonce) => {
			await postIpcBase<{ ok: true }>(connectedBrokerSocketPath, "stale_client_connection_ack", { sessionId, connectionNonce }, sessionId, brokerToken, connectionNonce).catch(() => undefined);
		},
		isStaleSessionConnectionError,
		activeTurnFinalizer,
		assistantFinalHandoff,
		clearAssistantPreviewInBroker,
		isRoutableRoute,
		sendAssistantFinalToBroker,
		updateStatus,
	});
	let brokerStatePersistQueue = Promise.resolve();
	const previewManager = new PreviewManager(callTelegram, sendMarkdownReply, rememberVisiblePreviewMessage, forgetVisiblePreviewMessage);
	const activityReporter = new ActivityReporter((payload) => postIpc(connectedBrokerSocketPath, "activity_update", payload, sessionId));
	const reportPiDiagnostic = createPiDiagnosticReporter({
		getLatestContext: () => latestCtx,
	});
	const notifiedPiDiagnosticKeys = new Set<string>();
	function reportPiDiagnosticOnce(key: string, event: Parameters<typeof reportPiDiagnostic>[0]): void {
		if (event.notify) {
			if (notifiedPiDiagnosticKeys.has(key)) return;
			notifiedPiDiagnosticKeys.add(key);
			if (notifiedPiDiagnosticKeys.size > 1000) {
				const oldestKey = notifiedPiDiagnosticKeys.values().next().value;
				if (oldestKey !== undefined) notifiedPiDiagnosticKeys.delete(oldestKey);
			}
		}
		reportPiDiagnostic(event);
	}
	const activityRenderer = new ActivityRenderer(callTelegramOnce, startTypingLoopFor, {
		getDurableMessage: (activityId) => brokerState?.activeActivityMessages?.[activityId],
		listDurableMessages: () => Object.values(brokerState?.activeActivityMessages ?? {}),
		listDurableMessagesForTurn: (turnId) => Object.values(brokerState?.activeActivityMessages ?? {}).filter((message) => message.turnId === turnId),
		saveDurableMessage: async (message) => {
			brokerState ??= await loadBrokerState();
			brokerState.activeActivityMessages ??= {};
			if (!activeActivityRenderStillValid(message)) {
				const current = brokerState.activeActivityMessages[message.activityId];
				if (current && activeActivityDurableRefMatches(current, message)) {
					delete brokerState.activeActivityMessages[message.activityId];
					try {
						await persistBrokerState();
					} catch (error) {
						brokerState.activeActivityMessages[message.activityId] = current;
						throw error;
					}
				}
				throw new Error(`Activity render state is no longer valid for ${message.activityId}`);
			}
			brokerState.activeActivityMessages[message.activityId] = message;
			await persistBrokerState();
		},
		deleteDurableMessage: async (activityId, expected) => {
			brokerState ??= await loadBrokerState();
			const current = brokerState.activeActivityMessages?.[activityId];
			if (!current) return;
			if (expected && !activeActivityDurableRefMatches(current, expected)) return;
			delete brokerState.activeActivityMessages![activityId];
			try {
				await persistBrokerState();
			} catch (error) {
				brokerState.activeActivityMessages![activityId] = current;
				throw error;
			}
		},
		canRenderMessage: activeActivityRenderStillValid,
		reportDiagnostic: reportPiDiagnostic,
	});
	const assistantFinalLedger = new AssistantFinalDeliveryLedger({
		getBrokerState: () => brokerState,
		setBrokerState: (state) => { brokerState = state; },
		loadBrokerState,
		persistBrokerState,
		activityComplete: (turnId) => activityRenderer.complete(turnId),
		stopTypingLoop,
		previewManager,
		callTelegram: callTelegramOnce,
		callTelegramMultipart: callTelegramMultipartOnce,
		isBrokerActive,
		rememberCompletedBrokerTurn,
		logTerminalFailure: (turnId, reason) => {
			const message = `Terminal Telegram final delivery failure for ${turnId}: ${reason}`;
			reportPiDiagnostic({ message, severity: "error", notify: true });
		},
	});
	const brokerSessions = new BrokerSessionRegistrationCoordinator({
		getBrokerState: () => brokerState,
		setBrokerState: (state) => { brokerState = state; },
		loadBrokerState,
		persistBrokerState,
		getConfig: () => config,
		selectedChatIdForSession,
		sendTextReply,
		callTelegram,
		postStaleClientConnection: (registration) => { void postIpc(registration.clientSocketPath, "stale_client_connection", { sessionId: registration.sessionId, connectionNonce: registration.connectionNonce }, registration.sessionId).catch(() => undefined); },
		honorPendingDisconnectRequest,
		refreshTelegramStatus,
		retryPendingTurns: () => { runDetachedBrokerTask("pending turn retry", retryPendingTurns); },
		kickAssistantFinalLedger: () => assistantFinalLedger.kick(),
		createTelegramTurnForSession: (messages, sessionIdForTurn) => buildTelegramTurnForSession(messages, sessionIdForTurn, downloadTelegramFile),
		consumeReplacementHandoff: (state, registration) => consumeSessionReplacementHandoffInBroker({ dir: SESSION_REPLACEMENT_HANDOFFS_DIR, brokerState: state, registration, onInvalidHandoff: reportInvalidDurableState }),
		staleStandDownGraceMs: CLIENT_HEARTBEAT_MS * 2 + 500,
	});
	let updateHandlers!: ReturnType<typeof createRuntimeUpdateHandlers>;
	const commandRouter = new TelegramCommandRouter({
		getBrokerState: () => brokerState,
		getConfig: () => config,
		persistBrokerState,
		markOfflineSessions: () => updateHandlers.markOfflineSessions(),
		createTelegramTurnForSession,
		durableTelegramTurn,
		sendTextReply,
		callTelegram,
		callTelegramForQueuedControlCleanup: callTelegramOnce,
		telegramOutbox: telegramOutboxRunner,
		postIpc,
		stopTypingLoop,
		unregisterSession,
		brokerInfo: () => `Broker: pid ${process.pid}, epoch ${brokerLeaseEpoch}, sessions ${Object.keys(brokerState?.sessions ?? {}).length}`,
	});
	updateHandlers = createRuntimeUpdateHandlers({
		getConfig: () => config,
		setConfig: (nextConfig) => { config = nextConfig; },
		getBrokerState: () => brokerState,
		setBrokerState: (nextBrokerState) => { brokerState = nextBrokerState; },
		getBrokerLeaseEpoch: () => brokerLeaseEpoch,
		getOwnerId: () => ownerId,
		commandRouter,
		mediaGroups,
		callTelegram,
		writeConfig,
		persistBrokerState,
		loadBrokerState,
		readLease,
		stopBroker,
		updateStatus,
		refreshTelegramStatus,
		sendTextReply,
		ensureRoutesAfterPairing,
		isAllowedTelegramChat,
		stopTypingLoop,
		dropAssistantPreviewState: async (turnId) => { await previewManager.detachForFinal(turnId); },
		postIpc,
		unregisterSession,
		markSessionOffline,
	});
	function pollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> { return updateHandlers.pollLoop(ctx, signal); }
	function schedulePendingMediaGroups(ctx: ExtensionContext): void { updateHandlers.schedulePendingMediaGroups(ctx); }
	function retryPendingTurns(): Promise<void> { return updateHandlers.retryPendingTurns(); }
	function brokerBackgroundDeps() { return { stopBroker, log: (message: string) => { reportPiDiagnostic({ message, severity: "warning", notify: true }); } }; }
	function runDetachedBrokerTask(label: string, task: () => Promise<void>): void { runBrokerBackgroundTask(label, task, brokerBackgroundDeps()); }
	function logTerminalRouteCleanupFailure(route: TelegramRoute, reason: string): void {
		const message = `Telegram bridge could not clean up topic ${route.topicName} (${route.routeId}): ${reason}`;
		reportPiDiagnostic({ message, severity: "error", notify: true });
	}
	function cleanupSessionTempDir(sessionId: string, currentBrokerState: BrokerState): Promise<void> {
		return cleanupDownloadedTelegramSessionTempDirIfUnused({ sessionId, brokerState: currentBrokerState }).then(() => undefined);
	}
	function sweepOrphanedTelegramTempDirs(): Promise<void> {
		return sweepOrphanedDownloadedTelegramSessionTempDirs({ brokerState }).then(() => undefined);
	}
	async function retryQueuedTurnControlFinalizations(): Promise<void> {
		try {
			await commandRouter.retryQueuedTurnControlFinalizations();
		} catch (error) {
			if (getTelegramRetryAfterMs(error) === undefined) {
				const message = `Failed to finalize queued Telegram controls: ${errorMessage(error)}`;
				reportPiDiagnosticOnce(`queued-control-finalization:${message}`, { message, severity: "warning", notify: true });
			}
		}
	}
	async function retryPendingManualCompactions(): Promise<void> {
		try {
			const clearedAny = await commandRouter.retryPendingManualCompactions();
			if (clearedAny) await retryPendingTurns();
		} catch (error) {
			if (getTelegramRetryAfterMs(error) === undefined) {
				const message = `Failed to retry queued Telegram compaction: ${errorMessage(error)}`;
				reportPiDiagnosticOnce(`manual-compaction-retry:${message}`, { message, severity: "warning", notify: true });
			}
		}
	}
	async function retryTelegramOutbox(): Promise<void> {
		await drainTelegramOutboxInBroker(telegramOutboxRunner, {
			getBrokerState: () => brokerState,
			loadBrokerState,
			setBrokerState: (state) => { brokerState = state; },
			persistBrokerState,
			callTelegram: callTelegramOnce,
			assertCanRun: assertCurrentBrokerLeaseForPersist,
			logTerminalCleanupFailure: logTerminalRouteCleanupFailure,
		});
	}
	function retryPendingRouteCleanups(): Promise<{ ok: true }> {
		return retryPendingRouteCleanupsInBroker({
			getBrokerState: () => brokerState,
			loadBrokerState,
			setBrokerState: (state) => { brokerState = state; },
			persistBrokerState,
			callTelegram: callTelegramOnce,
			assertCanDeleteRoute: assertCurrentBrokerLeaseForPersist,
			telegramOutbox: telegramOutboxRunner,
			logTerminalCleanupFailure: logTerminalRouteCleanupFailure,
		});
	}
	function updateStatus(ctx: ExtensionContext): void {
		const text = telegramStatusText({ theme: ctx.ui.theme, visible: telegramStatusVisible, config, isBroker, brokerState, connectedRoute: clientHost?.getConnectedRoute() });
		if (text !== undefined) ctx.ui.setStatus("telegram", text);
	}
	function showTelegramStatus(ctx: ExtensionContext): void {
		telegramStatusVisible = true;
		updateStatus(ctx);
	}
	function hideTelegramStatus(ctx: ExtensionContext): void {
		telegramStatusVisible = false;
		ctx.ui.setStatus("telegram", "");
	}
	function refreshTelegramStatus(): void { if (latestCtx) updateStatus(latestCtx); }
	function rememberVisiblePreviewMessage(turnId: string, chatId: number | string, messageThreadId: number | undefined, messageId: number): void {
		if (!brokerState) return;
		brokerState.assistantPreviewMessages ??= {};
		brokerState.assistantPreviewMessages[turnId] = { chatId, messageThreadId, messageId, updatedAtMs: now() };
		void persistBrokerState().catch(() => undefined);
	}
	function forgetVisiblePreviewMessage(turnId: string): void {
		if (!brokerState?.assistantPreviewMessages?.[turnId]) return;
		delete brokerState.assistantPreviewMessages[turnId];
		void persistBrokerState().catch(() => undefined);
	}
	function showPairingInstructions(ctx: ExtensionContext, pin: string): void {
		const text = pairingInstructions(config.botUsername, pin);
		ctx.ui.notify(text, "info");
		pi.sendMessage({ customType: "telegram_setup", content: text, display: true }, { triggerTurn: false });
	}
	function callTelegramOnce<TResponse>(method: string, body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<TResponse> {
		return callTelegramBase<TResponse>(config.botToken, method, body, options);
	}
	function callTelegram<TResponse>(method: string, body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<TResponse> {
		return withTelegramRetry((signal) => callTelegramOnce<TResponse>(method, body, { signal }), options?.signal);
	}
	function callTelegramMultipartOnce<TResponse>(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		filePath: string,
		fileName: string,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		return callTelegramMultipartBase<TResponse>(config.botToken, method, fields, fileField, filePath, fileName, options);
	}
	function callTelegramMultipart<TResponse>(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		filePath: string,
		fileName: string,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		return withTelegramRetry((signal) => callTelegramMultipartOnce<TResponse>(method, fields, fileField, filePath, fileName, { signal }), options?.signal);
	}
	function downloadTelegramFile(fileId: string, suggestedName: string, fileSize?: number): Promise<string> {
		return withTelegramRetry(() => downloadTelegramFileBase(config.botToken, sessionId, fileId, suggestedName, fileSize));
	}
	async function postIpc<TResponse>(socketPath: string, type: string, payload: unknown, targetSessionId?: string): Promise<TResponse> {
		try {
			return await postIpcBase<TResponse>(socketPath, type, payload, targetSessionId, brokerToken, clientHost.getConnectionNonce());
		} catch (error) {
			if (isStaleSessionConnectionError(error)) await clientHost.standDownStaleClientConnection();
			throw error;
		}
	}
	async function postBrokerControl(type: string, payload: unknown): Promise<unknown> {
		try { return await postIpc(connectedBrokerSocketPath, type, payload, sessionId); } catch (error) { const lease = await readLease(); if (await isLeaseLive(lease)) { connectedBrokerSocketPath = lease!.socketPath; return await postIpc(connectedBrokerSocketPath, type, payload, sessionId); } throw error; }
	}
	async function clearAssistantPreviewInBroker(turnId: string, chatId: number | string, messageThreadId: number | undefined, preserveOnFailure: boolean): Promise<void> {
		const payload = { turnId, chatId, messageThreadId, stopTyping: true, preserveOnFailure };
		let firstError: unknown;
		try {
			await postIpc(connectedBrokerSocketPath, "assistant_preview_clear", payload, sessionId);
			return;
		} catch (error) {
			firstError = error;
			const lease = await readLease();
			if (await isLeaseLive(lease)) {
				connectedBrokerSocketPath = lease!.socketPath;
				await postIpc(connectedBrokerSocketPath, "assistant_preview_clear", payload, sessionId);
				return;
			}
		}
		throw firstError instanceof Error ? firstError : new Error("Could not clear assistant preview in broker");
	}
	function disconnectRequestPath(targetSessionId: string): string {
		return join(DISCONNECT_REQUESTS_DIR, `${targetSessionId}.json`);
	}
	function makeDisconnectRequest(targetSessionId: string, route?: TelegramRoute): PendingDisconnectRequest {
		return {
			sessionId: targetSessionId,
			requestedAtMs: now(),
			connectionNonce: clientHost.getConnectionNonce(),
			connectionStartedAtMs: clientHost.getConnectionStartedAtMs(),
			routeId: route?.routeId,
			chatId: route?.chatId,
			messageThreadId: route?.messageThreadId,
			routeCreatedAtMs: route?.createdAtMs,
		};
	}
	async function writeDisconnectRequest(request: PendingDisconnectRequest): Promise<void> {
		await ensurePrivateDir(DISCONNECT_REQUESTS_DIR);
		await writeJson(disconnectRequestPath(request.sessionId), { schemaVersion: 1, ...request });
	}
	function validateBrokerLease(path: string, value: unknown): BrokerLease | undefined {
		if (value === undefined) return undefined;
		if (!isRecord(value)) invalidDurableJson(path, "root value must be an object");
		if (value.schemaVersion !== 1) invalidDurableJson(path, "schemaVersion must be 1");
		if (typeof value.ownerId !== "string") invalidDurableJson(path, "ownerId must be a string");
		if (typeof value.pid !== "number" || !Number.isFinite(value.pid)) invalidDurableJson(path, "pid must be a finite number");
		if (typeof value.startedAtMs !== "number" || !Number.isFinite(value.startedAtMs)) invalidDurableJson(path, "startedAtMs must be a finite number");
		if (typeof value.leaseEpoch !== "number" || !Number.isFinite(value.leaseEpoch)) invalidDurableJson(path, "leaseEpoch must be a finite number");
		if (typeof value.socketPath !== "string") invalidDurableJson(path, "socketPath must be a string");
		if (typeof value.leaseUntilMs !== "number" || !Number.isFinite(value.leaseUntilMs)) invalidDurableJson(path, "leaseUntilMs must be a finite number");
		if (typeof value.updatedAtMs !== "number" || !Number.isFinite(value.updatedAtMs)) invalidDurableJson(path, "updatedAtMs must be a finite number");
		if (value.botId !== undefined && (typeof value.botId !== "number" || !Number.isFinite(value.botId))) invalidDurableJson(path, "botId must be a finite number when present");
		return value as unknown as BrokerLease;
	}

	function validateFiniteNumber(path: string, value: unknown, field: string): number {
		if (typeof value !== "number" || !Number.isFinite(value)) invalidDurableJson(path, `${field} must be a finite number`);
		return value;
	}

	function validateOptionalFiniteNumber(path: string, value: unknown, field: string): number | undefined {
		if (value === undefined) return undefined;
		return validateFiniteNumber(path, value, field);
	}

	function validateOptionalString(path: string, value: unknown, field: string): string | undefined {
		if (value === undefined) return undefined;
		if (typeof value !== "string") invalidDurableJson(path, `${field} must be a string when present`);
		return value;
	}

	function validateChatId(path: string, value: unknown, field: string): number | string {
		if (typeof value !== "number" && typeof value !== "string") invalidDurableJson(path, `${field} must be a number or string`);
		if (typeof value === "number" && !Number.isFinite(value)) invalidDurableJson(path, `${field} must be finite when numeric`);
		return value;
	}

	function validateQueuedAttachment(path: string, value: unknown, field: string): { path: string; fileName: string } {
		if (!isRecord(value)) invalidDurableJson(path, `${field} must be an object`);
		if (typeof value.path !== "string") invalidDurableJson(path, `${field}.path must be a string`);
		if (typeof value.fileName !== "string") invalidDurableJson(path, `${field}.fileName must be a string`);
		return { path: value.path, fileName: value.fileName };
	}

	function validatePendingTurn(path: string, value: unknown, field: string): PendingTelegramTurn {
		if (!isRecord(value)) invalidDurableJson(path, `${field} must be an object`);
		if (typeof value.turnId !== "string") invalidDurableJson(path, `${field}.turnId must be a string`);
		if (typeof value.sessionId !== "string") invalidDurableJson(path, `${field}.sessionId must be a string`);
		const chatId = validateChatId(path, value.chatId, `${field}.chatId`);
		const messageThreadId = validateOptionalFiniteNumber(path, value.messageThreadId, `${field}.messageThreadId`);
		const replyToMessageId = validateFiniteNumber(path, value.replyToMessageId, `${field}.replyToMessageId`);
		if (!Array.isArray(value.queuedAttachments)) invalidDurableJson(path, `${field}.queuedAttachments must be an array`);
		if (!Array.isArray(value.content)) invalidDurableJson(path, `${field}.content must be an array`);
		if (typeof value.historyText !== "string") invalidDurableJson(path, `${field}.historyText must be a string`);
		const routeId = validateOptionalString(path, value.routeId, `${field}.routeId`);
		const deliveryMode = value.deliveryMode;
		if (deliveryMode !== undefined && deliveryMode !== "steer" && deliveryMode !== "followUp") invalidDurableJson(path, `${field}.deliveryMode must be steer or followUp when present`);
		const blockedByManualCompactionOperationId = validateOptionalString(path, value.blockedByManualCompactionOperationId, `${field}.blockedByManualCompactionOperationId`);
		return {
			turnId: value.turnId,
			sessionId: value.sessionId,
			routeId,
			chatId,
			messageThreadId,
			replyToMessageId,
			queuedAttachments: value.queuedAttachments.map((attachment, index) => validateQueuedAttachment(path, attachment, `${field}.queuedAttachments[${index}]`)),
			content: value.content as PendingTelegramTurn["content"],
			historyText: value.historyText,
			deliveryMode,
			blockedByManualCompactionOperationId,
		};
	}

	function validateBrokerRoute(path: string, value: unknown, field: string): TelegramRoute {
		if (!isRecord(value)) invalidDurableJson(path, `${field} must be an object`);
		if (typeof value.routeId !== "string") invalidDurableJson(path, `${field}.routeId must be a string`);
		if (typeof value.sessionId !== "string") invalidDurableJson(path, `${field}.sessionId must be a string`);
		const chatId = validateChatId(path, value.chatId, `${field}.chatId`);
		const messageThreadId = validateOptionalFiniteNumber(path, value.messageThreadId, `${field}.messageThreadId`);
		if (value.routeMode !== "private_topic" && value.routeMode !== "forum_supergroup_topic" && value.routeMode !== "single_chat_selector") invalidDurableJson(path, `${field}.routeMode must be a known route mode`);
		if (typeof value.topicName !== "string") invalidDurableJson(path, `${field}.topicName must be a string`);
		const createdAtMs = validateFiniteNumber(path, value.createdAtMs, `${field}.createdAtMs`);
		const updatedAtMs = validateFiniteNumber(path, value.updatedAtMs, `${field}.updatedAtMs`);
		return { routeId: value.routeId, sessionId: value.sessionId, chatId, messageThreadId, routeMode: value.routeMode, topicName: value.topicName, createdAtMs, updatedAtMs };
	}

	function validateNumberArray(path: string, value: unknown, field: string): void {
		if (value === undefined) return;
		if (!Array.isArray(value)) invalidDurableJson(path, `${field} must be an array when present`);
		value.forEach((entry, index) => validateFiniteNumber(path, entry, `${field}[${index}]`));
	}

	function validateStringArray(path: string, value: unknown, field: string): void {
		if (value === undefined) return;
		if (!Array.isArray(value)) invalidDurableJson(path, `${field} must be an array when present`);
		value.forEach((entry, index) => {
			if (typeof entry !== "string") invalidDurableJson(path, `${field}[${index}] must be a string`);
		});
	}

	function validateOptionalBoolean(path: string, value: unknown, field: string): void {
		if (value !== undefined && typeof value !== "boolean") invalidDurableJson(path, `${field} must be a boolean when present`);
	}

	function validateTelegramUpdate(path: string, value: unknown, field: string): void {
		if (!isRecord(value)) invalidDurableJson(path, `${field} must be an object`);
		validateFiniteNumber(path, value.update_id, `${field}.update_id`);
		for (const messageField of ["message", "edited_message"]) {
			const message = value[messageField];
			if (message === undefined) continue;
			if (!isRecord(message)) invalidDurableJson(path, `${field}.${messageField} must be an object when present`);
			validateFiniteNumber(path, message.message_id, `${field}.${messageField}.message_id`);
			if (!isRecord(message.chat)) invalidDurableJson(path, `${field}.${messageField}.chat must be an object`);
			validateChatId(path, message.chat.id, `${field}.${messageField}.chat.id`);
			if (typeof message.chat.type !== "string") invalidDurableJson(path, `${field}.${messageField}.chat.type must be a string`);
		}
		if (value.callback_query !== undefined && !isRecord(value.callback_query)) invalidDurableJson(path, `${field}.callback_query must be an object when present`);
	}

	function validateControlResultDeliveryProgress(path: string, value: unknown, field: string): void {
		if (!isRecord(value)) invalidDurableJson(path, `${field} must be an object`);
		validateStringArray(path, value.chunks, `${field}.chunks`);
		if (value.mode !== undefined && value.mode !== "edited" && value.mode !== "sent") invalidDurableJson(path, `${field}.mode must be edited or sent when present`);
		validateNumberArray(path, value.deliveredChunkIndexes, `${field}.deliveredChunkIndexes`);
		if (value.deliveredMessageIds !== undefined) {
			if (!isRecord(value.deliveredMessageIds)) invalidDurableJson(path, `${field}.deliveredMessageIds must be an object when present`);
			for (const [key, messageId] of Object.entries(value.deliveredMessageIds)) validateFiniteNumber(path, messageId, `${field}.deliveredMessageIds.${key}`);
		}
	}

	function validateFinalProgress(path: string, value: unknown, field: string): void {
		if (!isRecord(value)) invalidDurableJson(path, `${field} must be an object`);
		for (const key of ["activityCompleted", "typingStopped", "previewDetached", "previewCleared", "previewCleanupDone", "legacyPreviewEditedFinalReset"]) validateOptionalBoolean(path, value[key], `${field}.${key}`);
		if (value.previewCleanupTerminalReason !== undefined && typeof value.previewCleanupTerminalReason !== "string") invalidDurableJson(path, `${field}.previewCleanupTerminalReason must be a string when present`);
		if (value.previewMode !== undefined && value.previewMode !== "draft" && value.previewMode !== "message") invalidDurableJson(path, `${field}.previewMode must be draft or message when present`);
		validateOptionalFiniteNumber(path, value.previewMessageId, `${field}.previewMessageId`);
		if (value.textHash !== undefined && typeof value.textHash !== "string") invalidDurableJson(path, `${field}.textHash must be a string when present`);
		validateStringArray(path, value.chunks, `${field}.chunks`);
		validateNumberArray(path, value.sentChunkIndexes, `${field}.sentChunkIndexes`);
		if (value.sentChunkMessageIds !== undefined) {
			if (!isRecord(value.sentChunkMessageIds)) invalidDurableJson(path, `${field}.sentChunkMessageIds must be an object when present`);
			for (const [key, messageId] of Object.entries(value.sentChunkMessageIds)) validateFiniteNumber(path, messageId, `${field}.sentChunkMessageIds.${key}`);
		}
		validateNumberArray(path, value.sentAttachmentIndexes, `${field}.sentAttachmentIndexes`);
	}

	function validateBrokerSession(path: string, value: unknown, field: string): void {
		if (!isRecord(value)) invalidDurableJson(path, `${field} must be an object`);
		for (const key of ["sessionId", "ownerId", "cwd", "projectName", "connectionNonce", "clientSocketPath", "topicName"]) validateOptionalString(path, value[key], `${field}.${key}`) ?? invalidDurableJson(path, `${field}.${key} must be a string`);
		validateFiniteNumber(path, value.pid, `${field}.pid`);
		if (value.status !== "connecting" && value.status !== "idle" && value.status !== "busy" && value.status !== "offline" && value.status !== "error") invalidDurableJson(path, `${field}.status must be a known session status`);
		for (const key of ["queuedTurnCount", "lastHeartbeatMs", "connectedAtMs", "connectionStartedAtMs"]) validateFiniteNumber(path, value[key], `${field}.${key}`);
		for (const key of ["activeTurnId", "gitBranch", "gitRoot", "gitHead", "piSessionName", "model", "staleStandDownConnectionNonce"]) validateOptionalString(path, value[key], `${field}.${key}`);
		for (const key of ["staleStandDownRequestedAtMs", "reconnectGraceStartedAtMs"]) validateOptionalFiniteNumber(path, value[key], `${field}.${key}`);
	}

	function validateBrokerState(path: string, value: unknown): BrokerState | undefined {
		if (value === undefined) return undefined;
		if (!isRecord(value)) invalidDurableJson(path, "root value must be an object");
		if (value.schemaVersion !== 1) invalidDurableJson(path, "schemaVersion must be 1");
		validateOptionalFiniteNumber(path, value.lastProcessedUpdateId, "lastProcessedUpdateId");
		if (!Array.isArray(value.recentUpdateIds)) invalidDurableJson(path, "recentUpdateIds must be an array");
		value.recentUpdateIds.forEach((updateId, index) => validateFiniteNumber(path, updateId, `recentUpdateIds[${index}]`));
		if (!isRecord(value.sessions)) invalidDurableJson(path, "sessions must be an object");
		if (!isRecord(value.routes)) invalidDurableJson(path, "routes must be an object");
		for (const [key, session] of Object.entries(value.sessions)) validateBrokerSession(path, session, `sessions.${key}`);
		for (const [key, route] of Object.entries(value.routes)) validateBrokerRoute(path, route, `routes.${key}`);
		if (typeof value.createdAtMs !== "number" || !Number.isFinite(value.createdAtMs)) invalidDurableJson(path, "createdAtMs must be a finite number");
		if (typeof value.updatedAtMs !== "number" || !Number.isFinite(value.updatedAtMs)) invalidDurableJson(path, "updatedAtMs must be a finite number");
		for (const [key, field] of Object.entries({ pendingMediaGroups: value.pendingMediaGroups, pendingTurns: value.pendingTurns, pendingAssistantFinals: value.pendingAssistantFinals, pendingRouteCleanups: value.pendingRouteCleanups, telegramOutbox: value.telegramOutbox, assistantPreviewMessages: value.assistantPreviewMessages, activeActivityMessages: value.activeActivityMessages, selectorSelections: value.selectorSelections, modelPickers: value.modelPickers, gitControls: value.gitControls, queuedTurnControls: value.queuedTurnControls, pendingManualCompactions: value.pendingManualCompactions })) {
			if (field !== undefined && !isRecord(field)) invalidDurableJson(path, `${key} must be an object when present`);
		}
		if (isRecord(value.pendingTurns)) {
			for (const [key, entry] of Object.entries(value.pendingTurns)) {
				if (!isRecord(entry)) invalidDurableJson(path, `pendingTurns.${key} must be an object`);
				validatePendingTurn(path, entry.turn, `pendingTurns.${key}.turn`);
				validateFiniteNumber(path, entry.updatedAtMs, `pendingTurns.${key}.updatedAtMs`);
			}
		}
		if (isRecord(value.pendingAssistantFinals)) {
			for (const [key, final] of Object.entries(value.pendingAssistantFinals)) {
				if (!isRecord(final)) invalidDurableJson(path, `pendingAssistantFinals.${key} must be an object`);
				validatePendingTurn(path, final.turn, `pendingAssistantFinals.${key}.turn`);
				if (final.text !== undefined && typeof final.text !== "string") invalidDurableJson(path, `pendingAssistantFinals.${key}.text must be a string when present`);
				if (final.stopReason !== undefined && typeof final.stopReason !== "string") invalidDurableJson(path, `pendingAssistantFinals.${key}.stopReason must be a string when present`);
				if (final.errorMessage !== undefined && typeof final.errorMessage !== "string") invalidDurableJson(path, `pendingAssistantFinals.${key}.errorMessage must be a string when present`);
				if (!Array.isArray(final.attachments)) invalidDurableJson(path, `pendingAssistantFinals.${key}.attachments must be an array`);
				final.attachments.forEach((attachment, index) => validateQueuedAttachment(path, attachment, `pendingAssistantFinals.${key}.attachments[${index}]`));
				if (final.status !== "pending" && final.status !== "delivering" && final.status !== "terminal") invalidDurableJson(path, `pendingAssistantFinals.${key}.status must be a known final status`);
				validateFiniteNumber(path, final.createdAtMs, `pendingAssistantFinals.${key}.createdAtMs`);
				validateFiniteNumber(path, final.updatedAtMs, `pendingAssistantFinals.${key}.updatedAtMs`);
				validateOptionalFiniteNumber(path, final.retryAtMs, `pendingAssistantFinals.${key}.retryAtMs`);
				if (final.terminalReason !== undefined && typeof final.terminalReason !== "string") invalidDurableJson(path, `pendingAssistantFinals.${key}.terminalReason must be a string when present`);
				validateFinalProgress(path, final.progress, `pendingAssistantFinals.${key}.progress`);
			}
		}
		if (isRecord(value.pendingRouteCleanups)) {
			for (const [key, cleanup] of Object.entries(value.pendingRouteCleanups)) {
				if (!isRecord(cleanup)) invalidDurableJson(path, `pendingRouteCleanups.${key} must be an object`);
				validateBrokerRoute(path, cleanup.route, `pendingRouteCleanups.${key}.route`);
				validateFiniteNumber(path, cleanup.createdAtMs, `pendingRouteCleanups.${key}.createdAtMs`);
				validateFiniteNumber(path, cleanup.updatedAtMs, `pendingRouteCleanups.${key}.updatedAtMs`);
				validateOptionalFiniteNumber(path, cleanup.retryAtMs, `pendingRouteCleanups.${key}.retryAtMs`);
			}
		}
		if (isRecord(value.pendingMediaGroups)) {
			for (const [key, group] of Object.entries(value.pendingMediaGroups)) {
				if (!isRecord(group)) invalidDurableJson(path, `pendingMediaGroups.${key} must be an object`);
				if (!Array.isArray(group.updates)) invalidDurableJson(path, `pendingMediaGroups.${key}.updates must be an array`);
				group.updates.forEach((update, index) => validateTelegramUpdate(path, update, `pendingMediaGroups.${key}.updates[${index}]`));
				validateFiniteNumber(path, group.updatedAtMs, `pendingMediaGroups.${key}.updatedAtMs`);
			}
		}
		if (isRecord(value.assistantPreviewMessages)) {
			for (const [key, preview] of Object.entries(value.assistantPreviewMessages)) {
				if (!isRecord(preview)) invalidDurableJson(path, `assistantPreviewMessages.${key} must be an object`);
				validateChatId(path, preview.chatId, `assistantPreviewMessages.${key}.chatId`);
				validateOptionalFiniteNumber(path, preview.messageThreadId, `assistantPreviewMessages.${key}.messageThreadId`);
				validateFiniteNumber(path, preview.messageId, `assistantPreviewMessages.${key}.messageId`);
				validateFiniteNumber(path, preview.updatedAtMs, `assistantPreviewMessages.${key}.updatedAtMs`);
			}
		}
		if (isRecord(value.activeActivityMessages)) {
			for (const [key, message] of Object.entries(value.activeActivityMessages)) {
				if (!isRecord(message)) invalidDurableJson(path, `activeActivityMessages.${key} must be an object`);
				for (const required of ["turnId", "activityId"]) if (typeof message[required] !== "string") invalidDurableJson(path, `activeActivityMessages.${key}.${required} must be a string`);
				validateOptionalString(path, message.sessionId, `activeActivityMessages.${key}.sessionId`);
				validateChatId(path, message.chatId, `activeActivityMessages.${key}.chatId`);
				validateOptionalFiniteNumber(path, message.messageThreadId, `activeActivityMessages.${key}.messageThreadId`);
				validateOptionalFiniteNumber(path, message.messageId, `activeActivityMessages.${key}.messageId`);
				validateOptionalBoolean(path, message.messageIdUnavailable, `activeActivityMessages.${key}.messageIdUnavailable`);
				validateOptionalFiniteNumber(path, message.retryAtMs, `activeActivityMessages.${key}.retryAtMs`);
				validateOptionalBoolean(path, message.deleteWhenEmpty, `activeActivityMessages.${key}.deleteWhenEmpty`);
				if (!Array.isArray(message.lines)) invalidDurableJson(path, `activeActivityMessages.${key}.lines must be an array`);
				validateStringArray(path, message.lines, `activeActivityMessages.${key}.lines`);
				validateFiniteNumber(path, message.createdAtMs, `activeActivityMessages.${key}.createdAtMs`);
				validateFiniteNumber(path, message.updatedAtMs, `activeActivityMessages.${key}.updatedAtMs`);
			}
		}
		if (isRecord(value.selectorSelections)) {
			for (const [key, selection] of Object.entries(value.selectorSelections)) {
				if (!isRecord(selection)) invalidDurableJson(path, `selectorSelections.${key} must be an object`);
				validateChatId(path, selection.chatId, `selectorSelections.${key}.chatId`);
				if (typeof selection.sessionId !== "string") invalidDurableJson(path, `selectorSelections.${key}.sessionId must be a string`);
				validateFiniteNumber(path, selection.expiresAtMs, `selectorSelections.${key}.expiresAtMs`);
				validateFiniteNumber(path, selection.updatedAtMs, `selectorSelections.${key}.updatedAtMs`);
			}
		}
		if (isRecord(value.telegramOutbox)) {
			for (const [key, job] of Object.entries(value.telegramOutbox)) {
				if (!isRecord(job)) invalidDurableJson(path, `telegramOutbox.${key} must be an object`);
				if (typeof job.id !== "string") invalidDurableJson(path, `telegramOutbox.${key}.id must be a string`);
				if (job.kind !== "queued_control_status_edit" && job.kind !== "route_topic_delete") invalidDurableJson(path, `telegramOutbox.${key}.kind must be a known outbox kind`);
				if (job.status !== "pending" && job.status !== "delivering" && job.status !== "completed" && job.status !== "terminal") invalidDurableJson(path, `telegramOutbox.${key}.status must be a known outbox status`);
				validateFiniteNumber(path, job.createdAtMs, `telegramOutbox.${key}.createdAtMs`);
				validateFiniteNumber(path, job.updatedAtMs, `telegramOutbox.${key}.updatedAtMs`);
				validateOptionalFiniteNumber(path, job.retryAtMs, `telegramOutbox.${key}.retryAtMs`);
				validateFiniteNumber(path, job.attempts, `telegramOutbox.${key}.attempts`);
				validateOptionalString(path, job.terminalReason, `telegramOutbox.${key}.terminalReason`);
				validateOptionalFiniteNumber(path, job.completedAtMs, `telegramOutbox.${key}.completedAtMs`);
				if (job.kind === "queued_control_status_edit") {
					if (typeof job.controlToken !== "string") invalidDurableJson(path, `telegramOutbox.${key}.controlToken must be a string`);
					validateChatId(path, job.chatId, `telegramOutbox.${key}.chatId`);
					validateOptionalFiniteNumber(path, job.messageThreadId, `telegramOutbox.${key}.messageThreadId`);
					validateFiniteNumber(path, job.messageId, `telegramOutbox.${key}.messageId`);
					if (typeof job.text !== "string") invalidDurableJson(path, `telegramOutbox.${key}.text must be a string`);
				} else {
					if (typeof job.cleanupId !== "string") invalidDurableJson(path, `telegramOutbox.${key}.cleanupId must be a string`);
					validateBrokerRoute(path, job.route, `telegramOutbox.${key}.route`);
				}
			}
		}
		if (isRecord(value.pendingManualCompactions)) {
			for (const [key, operation] of Object.entries(value.pendingManualCompactions)) {
				if (!isRecord(operation)) invalidDurableJson(path, `pendingManualCompactions.${key} must be an object`);
				for (const required of ["operationId", "sessionId"]) if (typeof operation[required] !== "string") invalidDurableJson(path, `pendingManualCompactions.${key}.${required} must be a string`);
				validateOptionalString(path, operation.routeId, `pendingManualCompactions.${key}.routeId`);
				validateChatId(path, operation.chatId, `pendingManualCompactions.${key}.chatId`);
				validateOptionalFiniteNumber(path, operation.messageThreadId, `pendingManualCompactions.${key}.messageThreadId`);
				validateOptionalFiniteNumber(path, operation.commandMessageId, `pendingManualCompactions.${key}.commandMessageId`);
				if (operation.status !== "queued" && operation.status !== "running") invalidDurableJson(path, `pendingManualCompactions.${key}.status must be queued or running`);
				validateFiniteNumber(path, operation.createdAtMs, `pendingManualCompactions.${key}.createdAtMs`);
				validateFiniteNumber(path, operation.updatedAtMs, `pendingManualCompactions.${key}.updatedAtMs`);
			}
		}
		if (isRecord(value.queuedTurnControls)) {
			for (const [key, control] of Object.entries(value.queuedTurnControls)) {
				if (!isRecord(control)) invalidDurableJson(path, `queuedTurnControls.${key} must be an object`);
				for (const required of ["token", "turnId", "sessionId"]) if (typeof control[required] !== "string") invalidDurableJson(path, `queuedTurnControls.${key}.${required} must be a string`);
				validateOptionalString(path, control.routeId, `queuedTurnControls.${key}.routeId`);
				validateChatId(path, control.chatId, `queuedTurnControls.${key}.chatId`);
				validateOptionalFiniteNumber(path, control.messageThreadId, `queuedTurnControls.${key}.messageThreadId`);
				validateOptionalFiniteNumber(path, control.statusMessageId, `queuedTurnControls.${key}.statusMessageId`);
				if (control.status !== "offered" && control.status !== "converting" && control.status !== "cancelling" && control.status !== "converted" && control.status !== "cancelled" && control.status !== "expired") invalidDurableJson(path, `queuedTurnControls.${key}.status must be a known queued-control status`);
				validateFiniteNumber(path, control.createdAtMs, `queuedTurnControls.${key}.createdAtMs`);
				validateFiniteNumber(path, control.updatedAtMs, `queuedTurnControls.${key}.updatedAtMs`);
				validateFiniteNumber(path, control.expiresAtMs, `queuedTurnControls.${key}.expiresAtMs`);
			}
		}
		for (const [sectionName, section] of Object.entries({ modelPickers: value.modelPickers, gitControls: value.gitControls })) {
			if (!isRecord(section)) continue;
			for (const [key, record] of Object.entries(section)) {
				if (!isRecord(record)) invalidDurableJson(path, `${sectionName}.${key} must be an object`);
				for (const required of ["token", "sessionId", "routeId"]) if (typeof record[required] !== "string") invalidDurableJson(path, `${sectionName}.${key}.${required} must be a string`);
				validateChatId(path, record.chatId, `${sectionName}.${key}.chatId`);
				validateOptionalFiniteNumber(path, record.messageThreadId, `${sectionName}.${key}.messageThreadId`);
				validateOptionalFiniteNumber(path, record.messageId, `${sectionName}.${key}.messageId`);
				validateOptionalFiniteNumber(path, record.selectorSelectionUpdatedAtMs, `${sectionName}.${key}.selectorSelectionUpdatedAtMs`);
				validateOptionalFiniteNumber(path, record.selectorSelectionExpiresAtMs, `${sectionName}.${key}.selectorSelectionExpiresAtMs`);
				validateOptionalString(path, record.completedText, `${sectionName}.${key}.completedText`);
				if (record.resultDeliveryProgress !== undefined) validateControlResultDeliveryProgress(path, record.resultDeliveryProgress, `${sectionName}.${key}.resultDeliveryProgress`);
				validateFiniteNumber(path, record.createdAtMs, `${sectionName}.${key}.createdAtMs`);
				validateFiniteNumber(path, record.updatedAtMs, `${sectionName}.${key}.updatedAtMs`);
				validateFiniteNumber(path, record.expiresAtMs, `${sectionName}.${key}.expiresAtMs`);
				if (sectionName === "modelPickers") {
					validateOptionalString(path, record.current, `${sectionName}.${key}.current`);
					validateOptionalFiniteNumber(path, record.selectedAtMs, `${sectionName}.${key}.selectedAtMs`);
					if (!Array.isArray(record.models)) invalidDurableJson(path, `${sectionName}.${key}.models must be an array`);
					record.models.forEach((model, index) => {
						if (!isRecord(model)) invalidDurableJson(path, `${sectionName}.${key}.models[${index}] must be an object`);
						for (const required of ["provider", "id", "name", "label"]) if (typeof model[required] !== "string") invalidDurableJson(path, `${sectionName}.${key}.models[${index}].${required} must be a string`);
						if (!Array.isArray(model.input)) invalidDurableJson(path, `${sectionName}.${key}.models[${index}].input must be an array`);
						model.input.forEach((entry, inputIndex) => {
							if (typeof entry !== "string") invalidDurableJson(path, `${sectionName}.${key}.models[${index}].input[${inputIndex}] must be a string`);
						});
						if (typeof model.reasoning !== "boolean") invalidDurableJson(path, `${sectionName}.${key}.models[${index}].reasoning must be a boolean`);
					});
					if (!Array.isArray(record.groups)) invalidDurableJson(path, `${sectionName}.${key}.groups must be an array`);
					record.groups.forEach((group, index) => {
						if (!isRecord(group)) invalidDurableJson(path, `${sectionName}.${key}.groups[${index}] must be an object`);
						for (const required of ["provider", "label"]) if (typeof group[required] !== "string") invalidDurableJson(path, `${sectionName}.${key}.groups[${index}].${required} must be a string`);
						if (!Array.isArray(group.modelIndexes)) invalidDurableJson(path, `${sectionName}.${key}.groups[${index}].modelIndexes must be an array`);
						validateNumberArray(path, group.modelIndexes, `${sectionName}.${key}.groups[${index}].modelIndexes`);
					});
				} else {
					if (record.completedAction !== undefined && record.completedAction !== "status" && record.completedAction !== "diffstat") invalidDurableJson(path, `${sectionName}.${key}.completedAction must be status or diffstat when present`);
					validateOptionalFiniteNumber(path, record.resultDeliveredAtMs, `${sectionName}.${key}.resultDeliveredAtMs`);
				}
			}
		}
		if (value.telegramOutboxRetryAtMs !== undefined) validateFiniteNumber(path, value.telegramOutboxRetryAtMs, "telegramOutboxRetryAtMs");
		if (value.queuedTurnControlCleanupRetryAtMs !== undefined) validateFiniteNumber(path, value.queuedTurnControlCleanupRetryAtMs, "queuedTurnControlCleanupRetryAtMs");
		if (value.completedTurnIds !== undefined && !Array.isArray(value.completedTurnIds)) invalidDurableJson(path, "completedTurnIds must be an array when present");
		if (Array.isArray(value.completedTurnIds)) value.completedTurnIds.forEach((turnId, index) => {
			if (typeof turnId !== "string") invalidDurableJson(path, `completedTurnIds[${index}] must be a string`);
		});
		return value as unknown as BrokerState;
	}

	function reportInvalidDurableState(path: string, error: unknown): void {
		const message = `Invalid durable Telegram state at ${path}: ${errorMessage(error)}`;
		reportPiDiagnosticOnce(`invalid-durable-state:${path}:${errorMessage(error)}`, { message, severity: "warning", notify: true });
	}

	async function readDisconnectRequest(targetSessionId: string): Promise<PendingDisconnectRequest | undefined> {
		return readPendingDisconnectRequestFromPath(disconnectRequestPath(targetSessionId));
	}
	async function clearDisconnectRequest(targetSessionId: string): Promise<void> {
		await rm(disconnectRequestPath(targetSessionId), { force: true }).catch(() => undefined);
	}
	async function honorDisconnectRequest(request: PendingDisconnectRequest): Promise<{ ok: true; honored: boolean }> {
		if (!isRouteScopedDisconnectRequest(request)) return { ok: true, honored: false };
		return await honorExplicitDisconnectRequestInBroker({
			targetSessionId: request.sessionId,
			request,
			getBrokerState: () => brokerState,
			loadBrokerState,
			setBrokerState: (state) => { brokerState = state; },
			persistBrokerState,
			refreshTelegramStatus,
			stopTypingLoop,
			callTelegram: callTelegramOnce,
			assertCanDeleteRoute: assertCurrentBrokerLeaseForPersist,
			telegramOutbox: telegramOutboxRunner,
			cancelPendingFinalDeliveries: (targetSessionId, turnIds) => turnIds ? assistantFinalLedger.cancelTurns(turnIds) : assistantFinalLedger.cancelSession(targetSessionId),
			cleanupSessionTempDir,
			logTerminalCleanupFailure: logTerminalRouteCleanupFailure,
		});
	}
	async function honorPendingDisconnectRequest(targetSessionId: string): Promise<void> {
		let request: PendingDisconnectRequest | undefined;
		try {
			request = await readDisconnectRequest(targetSessionId);
		} catch (error) {
			reportInvalidDurableState(disconnectRequestPath(targetSessionId), error);
			return;
		}
		if (!request) return;
		if (!isRouteScopedDisconnectRequest(request)) {
			await clearDisconnectRequest(targetSessionId);
			return;
		}
		const result = await honorDisconnectRequest(request);
		if (result.honored || !Object.values(brokerState?.routes ?? {}).some((route) => route.sessionId === request.sessionId && route.routeId === request.routeId)) await clearDisconnectRequest(targetSessionId);
	}
	async function processPendingDisconnectRequests(): Promise<void> {
		if (!brokerState) return;
		const requests = await readPendingDisconnectRequestsFromDir({ dir: DISCONNECT_REQUESTS_DIR, onInvalidRequest: reportInvalidDurableState });
		await processDisconnectRequestsInBroker({
			brokerState,
			requests,
			unregisterSession: (targetSessionId) => unregisterSession(targetSessionId),
			honorRouteScopedDisconnect: honorDisconnectRequest,
			clearRequest: clearDisconnectRequest,
		});
	}
	async function prepareSessionReplacementHandoff(event: { reason: "new" | "resume" | "fork"; targetSessionFile?: string }, ctx: ExtensionContext): Promise<boolean> {
		const route = clientHost.getConnectedRoute();
		if (!route) return false;
		await ensurePrivateDir(SESSION_REPLACEMENT_HANDOFFS_DIR);
		await writeSessionReplacementHandoff({
			dir: SESSION_REPLACEMENT_HANDOFFS_DIR,
			reason: event.reason,
			oldSessionId: sessionId,
			oldSessionFile: ctx.sessionManager.getSessionFile(),
			targetSessionFile: event.targetSessionFile,
			route,
			connectionNonce: clientHost.getConnectionNonce(),
			connectionStartedAtMs: clientHost.getConnectionStartedAtMs(),
		});
		return true;
	}
	async function disconnectSessionRoute(mode: "explicit" | "shutdown" = "explicit"): Promise<void> {
		const hadConnectedRoute = clientHost.getConnectedRoute();
		const request = makeDisconnectRequest(sessionId, mode === "explicit" ? hadConnectedRoute : undefined);
		const brokerActive = isBroker && await isBrokerActive();
		if (mode === "explicit" && !brokerActive && hadConnectedRoute) {
			await writeDisconnectRequest(request);
			try {
				await postBrokerControl("disconnect_session_route", request);
			} catch {
				// The route-scoped disconnect intent is durable; broker heartbeat or failover
				// processing can honor it after this client tears down its local view.
			} finally {
				clientHost.discardTelegramClientRouteState();
				await clientHost.stopClientServer();
			}
			return;
		}
		let shutdownError: unknown;
		try {
			try {
				if (mode === "explicit") clientHost.discardTelegramClientRouteState();
				else await clientHost.shutdownClientRoute();
			} catch (error) {
				shutdownError = error;
			}
			if (shutdownError) throw shutdownError;
			if (brokerActive) {
				if (mode === "shutdown") {
					await assistantFinalLedger.drainReady();
					if (Object.values(brokerState?.pendingAssistantFinals ?? {}).some((entry) => entry.turn.sessionId === sessionId)) {
						throw new Error("Waiting for pending Telegram final delivery before disconnecting");
					}
				}
				if (isRouteScopedDisconnectRequest(request)) await honorDisconnectRequest(request);
				else await unregisterSession(sessionId);
			} else if (hadConnectedRoute) {
				await writeDisconnectRequest(request);
			}
		} finally {
			if (!shutdownError) await clientHost.stopClientServer();
		}
	}
	function createIpcServer(socketPath: string, handler: (envelope: IpcEnvelope) => Promise<unknown>): Promise<Server> {
		return createIpcServerBase(socketPath, () => brokerToken, handler);
	}
	function usesForumSupergroupRouting(): boolean { return routeUsesForumSupergroupRouting(config); }
	function targetChatIdForRoutes(): number | string | undefined { return routeTargetChatIdForRoutes(config); }
	function selectedChatIdForSession(targetSessionId: string): number | string | undefined { return Object.values(brokerState?.selectorSelections ?? {}).find((selection) => selection.sessionId === targetSessionId && selection.expiresAtMs > now())?.chatId; }
	async function readLease(): Promise<BrokerLease | undefined> { return validateBrokerLease(LOCK_PATH, await readJson<unknown>(LOCK_PATH)); }
	async function isBrokerActive(): Promise<boolean> {
		const lease = await readLease();
		return Boolean(isBroker && lease && lease.ownerId === ownerId && lease.leaseEpoch === brokerLeaseEpoch && lease.leaseUntilMs > now());
	}
	async function isLeaseLive(lease: BrokerLease | undefined): Promise<boolean> {
		if (!lease) return false;
		if (config.botId !== undefined && lease.botId !== undefined && lease.botId !== config.botId) return false;
		return lease.leaseUntilMs > now() && processExists(lease.pid);
	}
	async function loadBrokerState(): Promise<BrokerState> {
		const existing = validateBrokerState(STATE_PATH, await readJson<unknown>(STATE_PATH));
		if (existing) {
			delete (existing as BrokerState & { reloadIntents?: unknown }).reloadIntents;
			existing.telegramOutbox ??= {};
			existing.activeActivityMessages ??= {};
			existing.pendingManualCompactions ??= {};
			return existing;
		}
		return { schemaVersion: 1, lastProcessedUpdateId: config.lastUpdateId, recentUpdateIds: [], sessions: {}, routes: {}, pendingMediaGroups: {}, pendingTurns: {}, pendingAssistantFinals: {}, pendingRouteCleanups: {}, telegramOutbox: {}, assistantPreviewMessages: {}, activeActivityMessages: {}, queuedTurnControls: {}, pendingManualCompactions: {}, completedTurnIds: [], createdAtMs: now(), updatedAtMs: now() };
	}
	async function assertCurrentBrokerLeaseForPersist(): Promise<void> {
		const lease = await readLease();
		if (!isBroker || !lease || lease.ownerId !== ownerId || lease.leaseEpoch !== brokerLeaseEpoch || lease.leaseUntilMs <= now()) throw new StaleBrokerError();
	}
	function persistBrokerState(): Promise<void> {
		brokerStatePersistQueue = brokerStatePersistQueue.catch(() => undefined).then(async () => {
			if (!brokerState) return;
			await assertCurrentBrokerLeaseForPersist();
			brokerState.updatedAtMs = now();
			await writeJson(STATE_PATH, brokerState);
		});
		return brokerStatePersistQueue;
	}
	function brokerLeaseDeps() {
		return {
			ownerId,
			startedAtMs,
			getConfig: () => config,
			getLocalBrokerSocketPath: () => localBrokerSocketPath,
			getBrokerLeaseEpoch: () => brokerLeaseEpoch,
			setBrokerLeaseEpoch: (epoch: number) => { brokerLeaseEpoch = epoch; },
			setBrokerToken: (token: string) => { brokerToken = token; },
			makeBrokerToken: () => randomBytes(32).toString("hex"),
			readLease,
			isLeaseLive,
			stopBroker,
		};
	}
	async function tryAcquireBroker(): Promise<boolean> {
		await ensurePrivateDir(BROKER_DIR);
		return await tryAcquireBrokerLease(brokerLeaseDeps());
	}
	function renewBrokerLease(): Promise<void> {
		return renewBrokerLeaseFile(brokerLeaseDeps());
	}
	async function ensureBrokerStarted(ctx: ExtensionContext): Promise<void> {
		if (isBroker) return;
		brokerState = await loadBrokerState();
		assistantFinalLedger.start();
		brokerServer = await createIpcServer(localBrokerSocketPath, handleBrokerIpc);
		isBroker = true;
		activityRenderer.recoverDurableMessages();
		brokerHeartbeatState.failures = 0;
		brokerHeartbeatState.renewalContentions = 0;
		brokerHeartbeatState.renewalContentionReported = false;
		brokerHeartbeatState.inFlight = false;
		brokerHeartbeatTimer = setInterval(() => {
			void runBrokerHeartbeatCycle(brokerHeartbeatState, {
				renewBrokerLease,
				isBrokerActive,
				runMaintenance: async () => {
					await assistantFinalHandoff.processPendingClientFinalFiles();
					await processPendingDisconnectRequests();
					await updateHandlers.markOfflineSessions();
					await retryQueuedTurnControlFinalizations();
					await retryPendingManualCompactions();
					await retryPendingRouteCleanups();
					await retryTelegramOutbox();
					await sweepOrphanedTelegramTempDirs();
					assistantFinalLedger.kick();
				},
				handleStaleBrokerError: (error) => handleBrokerBackgroundError("broker heartbeat", error, brokerBackgroundDeps()),
				stopBroker,
				reportDiagnostic: reportPiDiagnostic,
			});
		}, BROKER_HEARTBEAT_MS);
		brokerPollAbort = new AbortController();
		runDetachedBrokerTask("broker poll loop", () => pollLoop(ctx, brokerPollAbort!.signal));
		schedulePendingMediaGroups(ctx);
		runDetachedBrokerTask("broker startup maintenance", async () => {
			await assistantFinalHandoff.processPendingClientFinalFiles();
			await processPendingDisconnectRequests();
			await retryPendingTurns();
			await retryQueuedTurnControlFinalizations();
			await retryPendingManualCompactions();
			await retryPendingRouteCleanups();
			await retryTelegramOutbox();
			await sweepOrphanedTelegramTempDirs();
			assistantFinalLedger.kick();
		});
		updateStatus(ctx);
	}
	async function stopBroker(): Promise<void> {
		if (!isBroker && !brokerServer) return;
		isBroker = false;
		brokerPollAbort?.abort();
		brokerPollAbort = undefined;
		if (brokerHeartbeatTimer) clearInterval(brokerHeartbeatTimer);
		brokerHeartbeatTimer = undefined;
		typingLoops.stopAll();
		activityRenderer.clearAllTimers();
		for (const state of mediaGroups.values()) if (state.flushTimer) clearTimeout(state.flushTimer);
		mediaGroups.clear();
		assistantFinalLedger.stop();
		previewManager.clearAllTimers();
		await new Promise<void>((resolveValue) => brokerServer?.close(() => resolveValue()) ?? resolveValue());
		brokerServer = undefined;
		const lease = await readLease();
		if (lease?.ownerId === ownerId && lease.leaseEpoch === brokerLeaseEpoch) {
			await rm(localBrokerSocketPath, { force: true }).catch(() => undefined);
			await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
		}
	}
	function connectTelegram(ctx: ExtensionContext, notify = true): Promise<void> {
		return clientHost.connectTelegram(ctx, notify);
	}
	function promptForConfig(ctx: ExtensionContext): Promise<boolean> {
		return promptForTelegramConfig(ctx, config, {
			setupInProgress,
			configureBrokerScope,
			writeConfig,
			showTelegramStatus,
			showPairingInstructions,
			setSetupInProgress: (value) => { setupInProgress = value; },
			setConfig: (nextConfig) => { config = nextConfig; },
		});
	}
	async function assertCurrentSessionConnection(envelope: IpcEnvelope): Promise<void> {
		const guardedTypes = new Set(["unregister_session", "mark_session_offline", "turn_started", "manual_compaction_started", "manual_compaction_settled", "assistant_message_start", "assistant_preview", "assistant_preview_clear", "activity_update", "activity_complete", "assistant_final", "turn_consumed", "local_user_message"]);
		if (!guardedTypes.has(envelope.type) || !envelope.session_id) return;
		brokerState ??= await loadBrokerState();
		const session = brokerState.sessions[envelope.session_id];
		if (!session) {
			if (envelope.type === "assistant_final") return;
			throw new Error("missing_session_connection");
		}
		if (!envelope.connection_nonce || envelope.connection_nonce !== session.connectionNonce) throw new Error("stale_session_connection");
	}
	async function clearStaleStandDownFence(targetSessionId: string, connectionNonce?: string): Promise<{ ok: true }> {
		const session = brokerState?.sessions[targetSessionId];
		if (!session?.staleStandDownConnectionNonce) return { ok: true };
		if (connectionNonce && session.staleStandDownConnectionNonce !== connectionNonce) return { ok: true };
		await assistantFinalHandoff.processPendingClientFinalFiles();
		delete session.staleStandDownConnectionNonce;
		delete session.staleStandDownRequestedAtMs;
		if (session.status === "connecting") session.status = session.activeTurnId || session.queuedTurnCount > 0 ? "busy" : "idle";
		await persistBrokerState();
		refreshTelegramStatus();
		runDetachedBrokerTask("pending turn retry after stale-client fence clear", retryPendingTurns);
		assistantFinalLedger.kick();
		return { ok: true };
	}
	async function handleBrokerIpc(envelope: IpcEnvelope): Promise<unknown> {
		const lease = await readLease();
		if (!isBroker || !lease || lease.ownerId !== ownerId || lease.leaseEpoch !== brokerLeaseEpoch || lease.leaseUntilMs <= now()) throw new StaleBrokerError();
		if (envelope.type === "reload_config") {
			config = await readConfig();
			applyBrokerScope();
			return { ok: true };
		}
		if (envelope.type === "register_session") return await registerSession(envelope.payload as SessionRegistration);
		if (envelope.type === "heartbeat_session") return await heartbeatSession(envelope.payload as SessionRegistration);
		if (envelope.type === "stale_client_connection_ack") {
			const payload = envelope.payload as { sessionId?: string; connectionNonce?: string };
			return await clearStaleStandDownFence(payload.sessionId ?? envelope.session_id ?? "", payload.connectionNonce);
		}
		await assertCurrentSessionConnection(envelope);
		if (envelope.type === "unregister_session") return await unregisterSession(envelope.session_id ?? (envelope.payload as { sessionId?: string }).sessionId ?? "");
		if (envelope.type === "disconnect_session_route") {
			const request = envelope.payload as PendingDisconnectRequest;
			const result = await honorDisconnectRequest({ ...request, sessionId: request.sessionId ?? envelope.session_id ?? "", requestedAtMs: request.requestedAtMs ?? now() });
			await clearDisconnectRequest(request.sessionId ?? envelope.session_id ?? "");
			return result;
		}
		if (envelope.type === "mark_session_offline") return await markSessionOffline(envelope.session_id ?? (envelope.payload as { sessionId?: string }).sessionId ?? "");
		if (envelope.type === "turn_started") return await handleTurnStarted(envelope.payload as { turnId: string });
		if (envelope.type === "assistant_message_start") return await handleAssistantMessageStart(envelope.payload as { turnId: string; chatId: number; messageThreadId?: number });
		if (envelope.type === "assistant_preview") return await handleAssistantPreview(envelope.payload as { turnId: string; chatId: number; messageThreadId?: number; text: string });
		if (envelope.type === "assistant_preview_clear") return await handleAssistantPreviewClear(envelope.payload as { turnId: string; chatId: number | string; messageThreadId?: number; stopTyping?: boolean });
		if (envelope.type === "activity_update") return await activityRenderer.handleUpdate(envelope.payload as ActivityUpdatePayload, envelope.session_id);
		if (envelope.type === "activity_complete") return await handleActivityComplete(envelope.payload as { turnId: string; activityId?: string });
		if (envelope.type === "assistant_final") return await assistantFinalLedger.accept(envelope.payload as AssistantFinalPayload);
		if (envelope.type === "turn_consumed") return await handleTurnConsumed(envelope.payload as { turnId: string; finalizeQueuedControlText?: string });
		if (envelope.type === "manual_compaction_started") return await handleManualCompactionStarted(envelope.payload as { operationId: string });
		if (envelope.type === "manual_compaction_settled") return await handleManualCompactionSettled(envelope.payload as { operationId: string });
		if (envelope.type === "local_user_message") return await handleLocalUserMessage(envelope.session_id, envelope.payload as { text: string; imagesCount?: number; routeId?: string; chatId?: number | string; messageThreadId?: number });
		throw new Error(`Unsupported broker IPC message: ${envelope.type}`);
	}
	function handleLocalUserMessage(sourceSessionId: string | undefined, payload: { text: string; imagesCount?: number; routeId?: string; chatId?: number | string; messageThreadId?: number }): Promise<{ ok: true }> {
		return handleLocalUserMirrorMessage({ brokerState, sourceSessionId, payload, sendTextReply });
	}
	function registerSession(registration: SessionRegistration): Promise<TelegramRoute> {
		return brokerSessions.registerSession(registration);
	}
	function heartbeatSession(registration: SessionRegistration): Promise<{ ok: true; route?: TelegramRoute }> {
		return brokerSessions.heartbeatSession(registration);
	}
	function markSessionOffline(targetSessionId: string): Promise<{ ok: true }> {
		return markSessionOfflineInBroker({
			targetSessionId,
			getBrokerState: () => brokerState,
			loadBrokerState,
			setBrokerState: (state) => { brokerState = state; },
			persistBrokerState,
			refreshTelegramStatus,
			stopTypingLoop,
			callTelegram: callTelegramOnce,
			assertCanDeleteRoute: assertCurrentBrokerLeaseForPersist,
			telegramOutbox: telegramOutboxRunner,
			cleanupSessionTempDir,
			logTerminalCleanupFailure: logTerminalRouteCleanupFailure,
		});
	}
	function unregisterSession(targetSessionId: string): Promise<{ ok: true }> {
		return unregisterSessionFromBroker({
			targetSessionId,
			getBrokerState: () => brokerState,
			loadBrokerState,
			setBrokerState: (state) => { brokerState = state; },
			persistBrokerState,
			refreshTelegramStatus,
			stopTypingLoop,
			callTelegram: callTelegramOnce,
			assertCanDeleteRoute: assertCurrentBrokerLeaseForPersist,
			telegramOutbox: telegramOutboxRunner,
			cancelPendingFinalDeliveries: (targetSessionId, turnIds) => turnIds ? assistantFinalLedger.cancelTurns(turnIds) : assistantFinalLedger.cancelSession(targetSessionId),
			cleanupSessionTempDir,
			logTerminalCleanupFailure: logTerminalRouteCleanupFailure,
		});
	}
	function ensureRoutesAfterPairing(): Promise<void> {
		return brokerSessions.ensureRoutesAfterPairing();
	}
	function createTelegramTurnForSession(messages: TelegramMessage[], sessionIdForTurn: string): Promise<PendingTelegramTurn> {
		return brokerSessions.createTelegramTurnForSession(messages, sessionIdForTurn);
	}
	async function sendTextReply(chatId: number | string, messageThreadId: number | undefined, text: string, options?: SendTextReplyOptions): Promise<number | undefined> {
		return await sendTelegramTextReply(callTelegram, chatId, messageThreadId, text, options);
	}
	async function sendMarkdownReply(chatId: number | string, messageThreadId: number | undefined, text: string, options?: SendTextReplyOptions): Promise<number | undefined> {
		return await sendTelegramMarkdownReply(callTelegram, chatId, messageThreadId, text, options);
	}
	function startTypingLoopFor(turnId: string, chatId: number | string, messageThreadId?: number): void {
		typingLoops.start(turnId, chatId, messageThreadId);
	}
	async function startTypingLoop(turn: PendingTelegramTurn): Promise<void> {
		startTypingLoopFor(turn.turnId, turn.chatId, turn.messageThreadId);
	}
	function stopTypingLoop(turnId: string): void {
		typingLoops.stop(turnId);
	}
	async function handleTurnStarted(payload: { turnId: string }): Promise<{ ok: true }> {
		const pending = brokerState?.pendingTurns?.[payload.turnId];
		if (pending) await startTypingLoop(pending.turn);
		await commandRouter.finalizeQueuedTurnControls([payload.turnId], QUEUED_CONTROL_TEXT.started);
		return { ok: true };
	}
	function activeActivityDurableRefMatches(current: ActiveActivityMessageRef, expected: ActiveActivityMessageRef): boolean {
		return current.turnId === expected.turnId
			&& current.activityId === expected.activityId
			&& current.sessionId === expected.sessionId
			&& String(current.chatId) === String(expected.chatId)
			&& current.messageThreadId === expected.messageThreadId
			&& current.messageId === expected.messageId
			&& current.messageIdUnavailable === expected.messageIdUnavailable;
	}
	function activeActivityRenderStillValid(message: ActiveActivityMessageRef): boolean {
		const state = brokerState;
		if (!state) return false;
		if (state.completedTurnIds?.includes(message.turnId)) return false;
		const turnMatchesActivity = (turn: { sessionId: string; chatId: number | string; messageThreadId?: number }) => {
			if (message.sessionId !== undefined && turn.sessionId !== message.sessionId) return false;
			return String(turn.chatId) === String(message.chatId) && turn.messageThreadId === message.messageThreadId;
		};
		const pendingTurn = state.pendingTurns?.[message.turnId];
		if (pendingTurn) return turnMatchesActivity(pendingTurn.turn);
		const pendingFinal = state.pendingAssistantFinals?.[message.turnId];
		if (pendingFinal) return !pendingFinal.progress.activityCompleted && turnMatchesActivity(pendingFinal.turn);
		if (message.sessionId !== undefined) {
			const session = state.sessions[message.sessionId];
			if (!session) return false;
			if (session.activeTurnId !== undefined && session.activeTurnId !== message.turnId) return false;
			return Object.values(state.routes).some((route) => route.sessionId === message.sessionId && String(route.chatId) === String(message.chatId) && route.messageThreadId === message.messageThreadId);
		}
		return Object.values(state.sessions).some((session) => session.activeTurnId === message.turnId)
			&& Object.values(state.routes).some((route) => String(route.chatId) === String(message.chatId) && route.messageThreadId === message.messageThreadId);
	}
	function matchingDurablePreview(turnId: string, chatId: number | string, messageThreadId?: number): number | undefined {
		const preview = brokerState?.assistantPreviewMessages?.[turnId];
		if (!preview) return undefined;
		if (preview.chatId !== chatId || preview.messageThreadId !== messageThreadId) return undefined;
		return preview.messageId;
	}
	async function handleAssistantMessageStart(payload: { turnId: string; chatId: number | string; messageThreadId?: number }): Promise<{ ok: true }> {
		startTypingLoopFor(payload.turnId, payload.chatId, payload.messageThreadId);
		await previewManager.messageStart(payload.turnId, payload.chatId, payload.messageThreadId, matchingDurablePreview(payload.turnId, payload.chatId, payload.messageThreadId));
		return { ok: true };
	}
	async function handleAssistantPreview(payload: { turnId: string; chatId: number | string; messageThreadId?: number; text: string }): Promise<{ ok: true }> {
		previewManager.preview(payload.turnId, payload.chatId, payload.messageThreadId, payload.text, matchingDurablePreview(payload.turnId, payload.chatId, payload.messageThreadId));
		return { ok: true };
	}
	async function handleAssistantPreviewClear(payload: { turnId: string; chatId: number | string; messageThreadId?: number; stopTyping?: boolean; preserveOnFailure?: boolean }): Promise<{ ok: true }> {
		if (payload.stopTyping) stopTypingLoop(payload.turnId);
		await previewManager.clear(payload.turnId, payload.chatId, payload.messageThreadId, payload.preserveOnFailure ? { preserveOnFailure: true } : undefined);
		return { ok: true };
	}
	async function handleActivityComplete(payload: { turnId: string; activityId?: string }): Promise<{ ok: true }> {
		await activityRenderer.completeActivity(payload.turnId, payload.activityId);
		return { ok: true };
	}
	async function rememberCompletedBrokerTurn(turnId: string): Promise<void> {
		brokerState ??= await loadBrokerState();
		brokerState.completedTurnIds ??= [];
		if (!brokerState.completedTurnIds.includes(turnId)) brokerState.completedTurnIds.push(turnId);
		if (brokerState.completedTurnIds.length > 1000) brokerState.completedTurnIds.splice(0, brokerState.completedTurnIds.length - 1000);
	}
	async function handleManualCompactionStarted(payload: { operationId: string }): Promise<{ ok: true }> {
		await commandRouter.markManualCompactionStarted(payload.operationId);
		return { ok: true };
	}
	async function handleManualCompactionSettled(payload: { operationId: string }): Promise<{ ok: true }> {
		await commandRouter.markManualCompactionSettled(payload.operationId);
		runDetachedBrokerTask("pending turn retry after compaction settle", retryPendingTurns);
		return { ok: true };
	}
	async function handleTurnConsumed(payload: { turnId: string; finalizeQueuedControlText?: string }): Promise<{ ok: true }> {
		const finalizeQueuedControlText = payload.finalizeQueuedControlText ?? QUEUED_CONTROL_TEXT.noLongerWaiting;
		commandRouter.markQueuedTurnControlsConsumed([payload.turnId], finalizeQueuedControlText);
		if (brokerState?.pendingAssistantFinals?.[payload.turnId]) {
			if (brokerState.pendingTurns?.[payload.turnId]) delete brokerState.pendingTurns[payload.turnId];
			stopTypingLoop(payload.turnId);
			await persistBrokerState();
			await commandRouter.retryQueuedTurnControlFinalizations();
			return { ok: true };
		}
		await rememberCompletedBrokerTurn(payload.turnId);
		if (brokerState?.pendingTurns?.[payload.turnId]) delete brokerState.pendingTurns[payload.turnId];
		stopTypingLoop(payload.turnId);
		await persistBrokerState();
		await commandRouter.retryQueuedTurnControlFinalizations();
		return { ok: true };
	}
	function isAllowedTelegramChat(message: TelegramMessage): boolean {
		if (message.chat.type === "private") return true;
		if (!usesForumSupergroupRouting() || config.fallbackSupergroupChatId === undefined) return false;
		if (String(config.fallbackSupergroupChatId) === String(message.chat.id)) return true;
		if (typeof config.fallbackSupergroupChatId === "string" && config.fallbackSupergroupChatId.startsWith("@")) {
			return message.chat.username === config.fallbackSupergroupChatId.slice(1);
		}
		return false;
	}
	function isRoutableRoute(route: TelegramRoute | undefined): route is TelegramRoute { return route !== undefined && route.chatId !== 0 && String(route.chatId) !== "0"; }
	function resolveAllowedAttachmentPath(inputPath: string): Promise<string | undefined> {
		return resolveSafeAttachmentPath(inputPath, latestCtx?.cwd);
	}
	function handoffAssistantFinalToBrokerConfirmed(payload: AssistantFinalPayload): Promise<boolean> {
		return assistantFinalHandoff.handoffConfirmed(payload);
	}
	function sendAssistantFinalToBroker(payload: AssistantFinalPayload, fromRetryQueue = false): Promise<boolean> {
		return assistantFinalHandoff.send(payload, fromRetryQueue);
	}
	const hooks: RuntimePiHooksDeps = {
		getConfig: () => config,
		setLatestCtx: setLatestContext,
		getConnectedRoute: () => clientHost.getConnectedRoute(),
		getActiveTelegramTurn: () => clientHost.getActiveTelegramTurn(),
		hasDeferredTelegramTurn: () => activeTurnFinalizer.hasDeferredTurn(),
		hasAwaitingTelegramFinalTurn: () => clientHost.hasAwaitingTelegramFinalTurn(),
		hasLiveAgentRun: () => clientHost.hasLiveAgentRun(),
		flushDeferredTelegramTurn: (options) => activeTurnFinalizer.flushDeferredTurn(options),
		queueActiveTelegramAttachments: (attachments, maxAttachments) => { clientHost.queueActiveTelegramAttachments(attachments, maxAttachments); },
		beginLocalInteractiveTurn: (route, historyText) => { clientHost.beginLocalInteractiveTurn(route, historyText); },
		setCurrentAbort: (abort) => { clientHost.setCurrentAbort(abort); },
		getSessionId: () => sessionId,
		getOwnerId: () => ownerId,
		getIsBroker: () => isBroker,
		getBrokerState: () => brokerState,
		getConnectedBrokerSocketPath: () => connectedBrokerSocketPath,
		activityReporter,
		isRoutableRoute,
		resolveAllowedAttachmentPath,
		postIpc,
		promptForConfig,
		connectTelegram,
		disconnectSessionRoute,
		prepareSessionReplacementHandoff,
		stopClientServer: () => clientHost.stopClientServer(),
		shutdownClientRoute: () => clientHost.shutdownClientRoute(),
		stopBroker,
		hideTelegramStatus,
		updateStatus,
		readLease,
		prepareAssistantFinalForHandoff: (payload) => assistantFinalHandoff.prepareForHandoff(payload),
		finalizeActiveTelegramTurn: (payload) => activeTurnFinalizer.finalizeActiveTurn(payload),
		onAgentRetryStart: () => activeTurnFinalizer.onAgentStart(),
		onRetryMessageStart: () => activeTurnFinalizer.onRetryMessageStart(),
		startNextTelegramTurn: () => clientHost.startNextTelegramTurn(),
		drainDeferredCompactionTurns: () => clientHost.getManualCompactionQueue().drainDeferredIntoActiveTurn(),
		onSessionStart: async (ctx, event) => {
			setLatestContext(ctx);
			config = await readConfig();
			applyBrokerScope();
			await ensurePrivateDir(BROKER_DIR);
			await ensurePrivateDir(DISCONNECT_REQUESTS_DIR);
			await ensurePrivateDir(SESSION_REPLACEMENT_HANDOFFS_DIR);
			await ensurePrivateDir(assistantFinalHandoff.pendingFinalsDir());
			await ensurePrivateDir(TEMP_DIR);
			const replacementContext = isSessionReplacementReason(event.reason)
				? { reason: event.reason, previousSessionFile: event.previousSessionFile, sessionFile: ctx.sessionManager.getSessionFile() }
				: undefined;
			sessionReplacementContext = replacementContext;
			if (replacementContext && config.botToken && await hasMatchingSessionReplacementHandoff({ dir: SESSION_REPLACEMENT_HANDOFFS_DIR, context: replacementContext, onInvalidHandoff: reportInvalidDurableState })) {
				await connectTelegram(ctx, false);
			}
		},
		clearMediaGroups: () => {
			for (const state of mediaGroups.values()) if (state.flushTimer) clearTimeout(state.flushTimer);
			mediaGroups.clear();
		},
	};
	return {
		hooks,
		isConnected: () => clientHost.getConnectedRoute() !== undefined,
	};
}

export function registerTelegramExtension(pi: ExtensionAPI) {
	const runtime = createTelegramRuntime(pi);
	registerRuntimePiHooks(pi, runtime.hooks);
}
