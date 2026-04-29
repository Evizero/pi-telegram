import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BROKER_DIR, BROKER_HEARTBEAT_MS, CLIENT_HEARTBEAT_MS, DISCONNECT_REQUESTS_DIR, LOCK_DIR, LOCK_PATH, SESSION_REPLACEMENT_HANDOFFS_DIR, STATE_PATH, TEMP_DIR } from "./shared/config.js";
import type { BrokerLease, BrokerState, IpcEnvelope, PendingTelegramTurn, AssistantFinalPayload, SessionRegistration, TelegramConfig, TelegramMediaGroupState, TelegramMessage, TelegramRoute } from "./shared/types.js";
import { configureBrokerScope, readConfig, writeConfig } from "./shared/config.js";
import { ActivityRenderer, ActivityReporter, type ActivityUpdatePayload } from "./broker/activity.js";
import { isRouteScopedDisconnectRequest, processDisconnectRequestsInBroker, type PendingDisconnectRequest } from "./broker/disconnect-requests.js";
import { handleBrokerBackgroundError, runBrokerBackgroundTask } from "./broker/background.js";
import { isStaleBrokerError, renewBrokerLease as renewBrokerLeaseFile, StaleBrokerError, tryAcquireBrokerLease } from "./broker/lease.js";
import { targetChatIdForRoutes as routeTargetChatIdForRoutes, usesForumSupergroupRouting as routeUsesForumSupergroupRouting } from "./broker/routes.js";
import { honorExplicitDisconnectRequestInBroker, unregisterSessionFromBroker, markSessionOfflineInBroker, retryPendingRouteCleanupsInBroker } from "./broker/sessions.js";
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
import { ensurePrivateDir, errorMessage, now, processExists, randomId, readJson, writeJson } from "./shared/utils.js";
import { createIpcServer as createIpcServerBase, postIpc as postIpcBase } from "./shared/ipc.js";
import { callTelegram as callTelegramBase, callTelegramMultipart as callTelegramMultipartBase, downloadTelegramFile as downloadTelegramFileBase, getTelegramRetryAfterMs } from "./telegram/api.js";
import { withTelegramRetry } from "./telegram/retry.js";
import { sendTelegramMarkdownReply, sendTelegramTextReply, type SendTextReplyOptions } from "./telegram/text.js";
import { createTelegramTurnForSession as buildTelegramTurnForSession, durableTelegramTurn } from "./telegram/turns.js";
import { PreviewManager } from "./telegram/previews.js";
import { cleanupDownloadedTelegramSessionTempDirIfUnused, sweepOrphanedDownloadedTelegramSessionTempDirs } from "./telegram/temp-files.js";
import { createTypingLoopController } from "./telegram/typing.js";
import { registerRuntimePiHooks } from "./pi/hooks.js";
import { promptForTelegramConfig } from "./telegram/setup.js";
import { pairingInstructions, telegramStatusText } from "./shared/ui-status.js";
export function registerTelegramExtension(pi: ExtensionAPI) {
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
	let brokerHeartbeatFailures = 0;
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
	const activityRenderer = new ActivityRenderer(callTelegram, startTypingLoopFor);
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
		logTerminalFailure: (turnId, reason) => console.warn(`[pi-telegram] Terminal Telegram final delivery failure for ${turnId}: ${reason}`),
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
		consumeReplacementHandoff: (state, registration) => consumeSessionReplacementHandoffInBroker({ dir: SESSION_REPLACEMENT_HANDOFFS_DIR, brokerState: state, registration }),
		staleStandDownGraceMs: CLIENT_HEARTBEAT_MS * 2 + 500,
	});
	let updateHandlers!: ReturnType<typeof createRuntimeUpdateHandlers>;
	const commandRouter = new TelegramCommandRouter({
		getBrokerState: () => brokerState,
		persistBrokerState,
		markOfflineSessions: () => updateHandlers.markOfflineSessions(),
		createTelegramTurnForSession,
		durableTelegramTurn,
		sendTextReply,
		callTelegram,
		callTelegramForQueuedControlCleanup: callTelegramOnce,
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
	function brokerBackgroundDeps() { return { stopBroker, log: (message: string) => console.warn(message) }; }
	function runDetachedBrokerTask(label: string, task: () => Promise<void>): void { runBrokerBackgroundTask(label, task, brokerBackgroundDeps()); }
	function logTerminalRouteCleanupFailure(route: TelegramRoute, reason: string): void {
		console.warn(`[pi-telegram] Terminal Telegram topic cleanup failure for ${route.routeId}: ${reason}`);
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
			if (getTelegramRetryAfterMs(error) === undefined) console.warn(`[pi-telegram] Failed to finalize queued Telegram controls: ${errorMessage(error)}`);
		}
	}
	function retryPendingRouteCleanups(): Promise<{ ok: true }> {
		return retryPendingRouteCleanupsInBroker({
			getBrokerState: () => brokerState,
			loadBrokerState,
			setBrokerState: (state) => { brokerState = state; },
			persistBrokerState,
			callTelegram: callTelegramOnce,
			assertCanDeleteRoute: assertCurrentBrokerLeaseForPersist,
			logTerminalCleanupFailure: logTerminalRouteCleanupFailure,
		});
	}
	function updateStatus(ctx: ExtensionContext, error?: string): void {
		const text = telegramStatusText({ theme: ctx.ui.theme, visible: telegramStatusVisible, config, isBroker, brokerState, connectedRoute: clientHost?.getConnectedRoute(), error });
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
	async function readDisconnectRequest(targetSessionId: string): Promise<PendingDisconnectRequest | undefined> {
		const request = await readJson<PendingDisconnectRequest & { schemaVersion?: number }>(disconnectRequestPath(targetSessionId));
		if (!request?.sessionId || request.requestedAtMs === undefined) return undefined;
		return {
			sessionId: request.sessionId,
			requestedAtMs: request.requestedAtMs,
			connectionNonce: request.connectionNonce,
			connectionStartedAtMs: request.connectionStartedAtMs,
			routeId: request.routeId,
			chatId: request.chatId,
			messageThreadId: request.messageThreadId,
			routeCreatedAtMs: request.routeCreatedAtMs,
		};
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
			cancelPendingFinalDeliveries: (targetSessionId, turnIds) => turnIds ? assistantFinalLedger.cancelTurns(turnIds) : assistantFinalLedger.cancelSession(targetSessionId),
			cleanupSessionTempDir,
			logTerminalCleanupFailure: logTerminalRouteCleanupFailure,
		});
	}
	async function honorPendingDisconnectRequest(targetSessionId: string): Promise<void> {
		const request = await readDisconnectRequest(targetSessionId);
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
		const names = await readdir(DISCONNECT_REQUESTS_DIR).catch(() => [] as string[]);
		const requests: PendingDisconnectRequest[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const request = await readJson<PendingDisconnectRequest & { schemaVersion?: number }>(join(DISCONNECT_REQUESTS_DIR, name));
			if (!request?.sessionId || request.requestedAtMs === undefined) continue;
			requests.push({ sessionId: request.sessionId, requestedAtMs: request.requestedAtMs, connectionNonce: request.connectionNonce, connectionStartedAtMs: request.connectionStartedAtMs, routeId: request.routeId, chatId: request.chatId, messageThreadId: request.messageThreadId, routeCreatedAtMs: request.routeCreatedAtMs });
		}
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
	async function readLease(): Promise<BrokerLease | undefined> { return await readJson<BrokerLease>(LOCK_PATH); }
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
		const existing = await readJson<BrokerState>(STATE_PATH);
		if (existing) {
			delete (existing as BrokerState & { reloadIntents?: unknown }).reloadIntents;
			return existing;
		}
		return { schemaVersion: 1, lastProcessedUpdateId: config.lastUpdateId, recentUpdateIds: [], sessions: {}, routes: {}, pendingMediaGroups: {}, pendingTurns: {}, pendingAssistantFinals: {}, pendingRouteCleanups: {}, assistantPreviewMessages: {}, queuedTurnControls: {}, completedTurnIds: [], createdAtMs: now(), updatedAtMs: now() };
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
		brokerHeartbeatFailures = 0;
		brokerHeartbeatTimer = setInterval(() => {
			void renewBrokerLease().then(async () => {
				if (!(await isBrokerActive())) return;
				brokerHeartbeatFailures = 0;
				await assistantFinalHandoff.processPendingClientFinalFiles();
				await processPendingDisconnectRequests();
				await updateHandlers.markOfflineSessions();
				await retryQueuedTurnControlFinalizations();
				await retryPendingRouteCleanups();
				await sweepOrphanedTelegramTempDirs();
				assistantFinalLedger.kick();
			}).catch((error) => {
				if (isStaleBrokerError(error)) {
					void handleBrokerBackgroundError("broker heartbeat", error, brokerBackgroundDeps());
					return;
				}
				brokerHeartbeatFailures += 1;
				console.warn(`[pi-telegram] Broker heartbeat failed: ${errorMessage(error)}`);
				if (brokerHeartbeatFailures >= 2) runDetachedBrokerTask("broker heartbeat failure stand-down", stopBroker);
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
			await retryPendingRouteCleanups();
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
		const guardedTypes = new Set(["unregister_session", "mark_session_offline", "turn_started", "assistant_message_start", "assistant_preview", "assistant_preview_clear", "activity_update", "activity_complete", "assistant_final", "turn_consumed", "local_user_message"]);
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
		if (envelope.type === "activity_update") return await activityRenderer.handleUpdate(envelope.payload as ActivityUpdatePayload);
		if (envelope.type === "activity_complete") return await handleActivityComplete(envelope.payload as { turnId: string; activityId?: string });
		if (envelope.type === "assistant_final") return await assistantFinalLedger.accept(envelope.payload as AssistantFinalPayload);
		if (envelope.type === "turn_consumed") return await handleTurnConsumed(envelope.payload as { turnId: string; finalizeQueuedControlText?: string });
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
	registerRuntimePiHooks(pi, {
		getConfig: () => config,
		setLatestCtx: setLatestContext,
		getConnectedRoute: () => clientHost.getConnectedRoute(),
		setConnectedRoute: (route) => { clientHost.setConnectedRoute(route); },
		getActiveTelegramTurn: () => clientHost.getActiveTelegramTurn(),
		hasDeferredTelegramTurn: () => activeTurnFinalizer.hasDeferredTurn(),
		hasAwaitingTelegramFinalTurn: () => clientHost.hasAwaitingTelegramFinalTurn(),
		hasLiveAgentRun: () => clientHost.hasLiveAgentRun(),
		flushDeferredTelegramTurn: (options) => activeTurnFinalizer.flushDeferredTurn(options),
		setActiveTelegramTurn: (turn) => { clientHost.setActiveTelegramTurn(turn); },
		setQueuedTelegramTurns: (turns) => { clientHost.setQueuedTelegramTurns(turns); },
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
		unregisterSession,
		markSessionOffline,
		disconnectSessionRoute,
		prepareSessionReplacementHandoff,
		stopClientServer: () => clientHost.stopClientServer(),
		shutdownClientRoute: () => clientHost.shutdownClientRoute(),
		stopBroker,
		hideTelegramStatus,
		updateStatus,
		readLease,
		sendAssistantFinalToBroker,
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
			if (replacementContext && config.botToken && await hasMatchingSessionReplacementHandoff({ dir: SESSION_REPLACEMENT_HANDOFFS_DIR, context: replacementContext })) {
				await connectTelegram(ctx, false);
			}
		},
		clearMediaGroups: () => {
			for (const state of mediaGroups.values()) if (state.flushTimer) clearTimeout(state.flushTimer);
			mediaGroups.clear();
		},
	});
}
