import type { Server } from "node:http";
import { randomBytes, randomInt } from "node:crypto";
import { mkdir, realpath, rm, stat, writeFile, chmod } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BROKER_DIR, BROKER_HEARTBEAT_MS, BROKER_LEASE_MS, CLIENT_HEARTBEAT_MS, LOCK_DIR, LOCK_PATH, STATE_PATH, TAKEOVER_LOCK_DIR, TEMP_DIR, TOKEN_PATH } from "./shared/config.js";
import type { ActiveTelegramTurn, BrokerLease, BrokerState, IpcEnvelope, ModelSummary, PendingTelegramTurn, QueuedAttachment, AssistantFinalPayload, SessionRegistration, TelegramApiResponse, TelegramConfig, TelegramForumTopic, TelegramMediaGroupState, TelegramMessage, TelegramRoute, TelegramSentMessage, TelegramUpdate, TelegramUser } from "./shared/types.js";
import { configureBrokerScope, readConfig, writeConfig } from "./shared/config.js";
import { ActivityRenderer, ActivityReporter, type ActivityUpdatePayload } from "./broker/activity.js";
import { unregisterSessionFromBroker, markSessionOfflineInBroker } from "./broker/sessions.js";
import { createRuntimeUpdateHandlers } from "./broker/updates.js";
import { clientQueryModels as buildClientQueryModels, clientSetModel as setClientModel, clientStatusText as buildClientStatusText } from "./client/info.js";
import { AssistantFinalRetryQueue } from "./client/final-delivery.js";
import { TelegramCommandRouter } from "./broker/commands.js";
import { AssistantFinalDeliveryLedger } from "./broker/finals.js";
import { chunkParagraphs, formatLocalUserMirrorMessage, routeId, topicNameFor } from "./shared/format.js";
import { ensurePrivateDir, errorMessage, hashSecret, now, processExists, randomId, readJson, writeJson } from "./shared/utils.js";
import { createIpcServer as createIpcServerBase, postIpc as postIpcBase } from "./shared/ipc.js";
import { callTelegram as callTelegramBase, callTelegramMultipart as callTelegramMultipartBase, downloadTelegramFile as downloadTelegramFileBase, getTelegramRetryAfterMs } from "./telegram/api.js";
import { withTelegramRetry } from "./telegram/retry.js";
import { createTelegramTurnForSession as buildTelegramTurnForSession, durableTelegramTurn } from "./telegram/turns.js";
import { collectSessionRegistration as buildSessionRegistration } from "./client/session-registration.js";
import { PreviewManager } from "./telegram/previews.js";
import { registerRuntimePiHooks } from "./pi/hooks.js";
import { formatPairingPin, PAIRING_PIN_TTL_MS } from "./shared/pairing.js";
import { pairingInstructions, telegramStatusText } from "./shared/ui-status.js";
export function registerTelegramExtension(pi: ExtensionAPI) {
	const ownerId = randomId("own");
	const startedAtMs = now();
	let sessionId = randomId("pis");
	let config: TelegramConfig = {};
	let latestCtx: ExtensionContext | undefined;
	let brokerServer: Server | undefined;
	let clientServer: Server | undefined;
	let isBroker = false;
	let brokerLeaseEpoch = 0;
	let brokerToken = "";
	let brokerState: BrokerState | undefined;
	let brokerPollAbort: AbortController | undefined;
	let brokerHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let brokerHeartbeatFailures = 0;
	let clientHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let clientReconnectInFlight = false;
	let clientSocketPath = join(BROKER_DIR, `client-${ownerId}.sock`);
	let activeClientSocketPath: string | undefined;
	let localBrokerSocketPath = join(BROKER_DIR, `broker-${ownerId}.sock`);
	let connectedBrokerSocketPath = localBrokerSocketPath;
	function applyBrokerScope(): void {
		configureBrokerScope(config.botId);
		clientSocketPath = join(BROKER_DIR, `client-${ownerId}.sock`);
		localBrokerSocketPath = join(BROKER_DIR, `broker-${ownerId}.sock`);
		if (!connectedRoute) connectedBrokerSocketPath = localBrokerSocketPath;
	}
	function setLatestContext(ctx: ExtensionContext): string {
		latestCtx = ctx;
		return (sessionId = ctx.sessionManager.getSessionId());
	}
	let connectedRoute: TelegramRoute | undefined;
	let queuedTelegramTurns: PendingTelegramTurn[] = [];
	let activeTelegramTurn: ActiveTelegramTurn | undefined;
	let currentAbort: (() => void) | undefined;
	let setupInProgress = false;
	let telegramStatusVisible = false;
	const mediaGroups = new Map<string, TelegramMediaGroupState>();
	const typingLoops = new Map<string, ReturnType<typeof setInterval> | undefined>();
	const assistantFinalQueue = new AssistantFinalRetryQueue();
	const completedTurnIds = new Set<string>();
	const routeEnsures = new Map<string, Promise<TelegramRoute>>();
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
	let updateHandlers!: ReturnType<typeof createRuntimeUpdateHandlers>;
	const commandRouter = new TelegramCommandRouter({
		getBrokerState: () => brokerState,
		persistBrokerState,
		markOfflineSessions: () => updateHandlers.markOfflineSessions(),
		createTelegramTurnForSession,
		durableTelegramTurn,
		sendTextReply,
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
		postIpc,
	});
	function pollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> { return updateHandlers.pollLoop(ctx, signal); }
	function schedulePendingMediaGroups(ctx: ExtensionContext): void { updateHandlers.schedulePendingMediaGroups(ctx); }
	function retryPendingTurns(): Promise<void> { return updateHandlers.retryPendingTurns(); }
	function updateStatus(ctx: ExtensionContext, error?: string): void {
		const text = telegramStatusText({ theme: ctx.ui.theme, visible: telegramStatusVisible, config, isBroker, brokerState, connectedRoute, error });
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
		void persistBrokerState();
	}
	function forgetVisiblePreviewMessage(turnId: string): void {
		if (!brokerState?.assistantPreviewMessages?.[turnId]) return;
		delete brokerState.assistantPreviewMessages[turnId];
		void persistBrokerState();
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
	function postIpc<TResponse>(socketPath: string, type: string, payload: unknown, targetSessionId?: string): Promise<TResponse> { return postIpcBase<TResponse>(socketPath, type, payload, targetSessionId, brokerToken); }
	async function postBrokerControl(type: string, payload: unknown): Promise<unknown> {
		try { return await postIpc(connectedBrokerSocketPath, type, payload, sessionId); } catch (error) { const lease = await readLease(); if (await isLeaseLive(lease)) { connectedBrokerSocketPath = lease!.socketPath; return await postIpc(connectedBrokerSocketPath, type, payload, sessionId); } throw error; }
	}
	function createIpcServer(socketPath: string, handler: (envelope: IpcEnvelope) => Promise<unknown>): Promise<Server> {
		return createIpcServerBase(socketPath, () => brokerToken, handler);
	}
	function usesForumSupergroupRouting(): boolean { return config.topicMode === "forum_supergroup" || ((config.topicMode ?? "auto") === "auto" && config.fallbackMode === "forum_supergroup"); }
	function targetChatIdForRoutes(): number | string | undefined { return usesForumSupergroupRouting() ? config.fallbackSupergroupChatId : config.allowedChatId; }
	function selectedChatIdForSession(targetSessionId: string): number | string | undefined { return Object.values(brokerState?.selectorSelections ?? {}).find((selection) => selection.sessionId === targetSessionId && selection.expiresAtMs > now())?.chatId; }
	async function collectSessionRegistration(ctx: ExtensionContext): Promise<SessionRegistration> {
		return buildSessionRegistration({ ctx, sessionId, ownerId, startedAtMs, clientSocketPath, piSessionName: pi.getSessionName(), activeTelegramTurn, queuedTelegramTurns });
	}
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
		return { schemaVersion: 1, lastProcessedUpdateId: config.lastUpdateId, recentUpdateIds: [], sessions: {}, routes: {}, pendingMediaGroups: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, completedTurnIds: [], createdAtMs: now(), updatedAtMs: now() };
	}
	function persistBrokerState(): Promise<void> {
		brokerStatePersistQueue = brokerStatePersistQueue.catch(() => undefined).then(async () => {
			if (!brokerState) return;
			brokerState.updatedAtMs = now();
			await writeJson(STATE_PATH, brokerState);
		});
		return brokerStatePersistQueue;
	}
	async function tryAcquireBroker(): Promise<boolean> {
		await ensurePrivateDir(BROKER_DIR);
		const previous = await readLease();
		if (await isLeaseLive(previous)) return false;
		try {
			await mkdir(TAKEOVER_LOCK_DIR);
			await writeJson(join(TAKEOVER_LOCK_DIR, "lock.json"), { ownerId, pid: process.pid, updatedAtMs: now() });
		} catch {
			const takeover = await readJson<{ pid?: number; updatedAtMs?: number }>(join(TAKEOVER_LOCK_DIR, "lock.json"));
			const takeoverStats = await stat(TAKEOVER_LOCK_DIR).catch(() => undefined);
			const staleEmptyTakeover = !takeover && takeoverStats && now() - takeoverStats.mtimeMs > BROKER_LEASE_MS;
			if (staleEmptyTakeover || (takeover && ((takeover.pid && !processExists(takeover.pid)) || (takeover.updatedAtMs && now() - takeover.updatedAtMs > BROKER_LEASE_MS)))) {
				await rm(TAKEOVER_LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
				try {
					await mkdir(TAKEOVER_LOCK_DIR);
					await writeJson(join(TAKEOVER_LOCK_DIR, "lock.json"), { ownerId, pid: process.pid, updatedAtMs: now() });
				} catch {
					return false;
				}
			} else {
				return false;
			}
		}
		try {
			const current = await readLease();
			if (await isLeaseLive(current)) return false;
			await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
			try {
				await mkdir(LOCK_DIR);
			} catch {
				return false;
			}
			brokerToken = randomBytes(32).toString("hex");
			await writeFile(TOKEN_PATH, brokerToken, "utf8");
			await chmod(TOKEN_PATH, 0o600).catch(() => undefined);
			brokerLeaseEpoch = (current?.leaseEpoch ?? previous?.leaseEpoch ?? 0) + 1;
			const lease: BrokerLease = {
				schemaVersion: 1,
				ownerId,
				pid: process.pid,
				startedAtMs,
				leaseEpoch: brokerLeaseEpoch,
				socketPath: localBrokerSocketPath,
				leaseUntilMs: now() + BROKER_LEASE_MS,
				updatedAtMs: now(),
				botId: config.botId,
			};
			await writeJson(LOCK_PATH, lease);
			return true;
		} finally {
			await rm(TAKEOVER_LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
		}
	}
	async function renewBrokerLease(): Promise<void> {
		let locked = false;
		try {
			await mkdir(TAKEOVER_LOCK_DIR);
			locked = true;
			await writeJson(join(TAKEOVER_LOCK_DIR, "lock.json"), { ownerId, pid: process.pid, updatedAtMs: now(), renew: true });
			const lease = await readLease();
			if (!lease || lease.ownerId !== ownerId || lease.leaseEpoch !== brokerLeaseEpoch || lease.leaseUntilMs <= now()) {
				await stopBroker();
				return;
			}
			lease.leaseUntilMs = now() + BROKER_LEASE_MS;
			lease.updatedAtMs = now();
			await writeJson(LOCK_PATH, lease);
		} catch (error) {
			throw error;
		} finally {
			if (locked) await rm(TAKEOVER_LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
		}
	}
	async function ensureBrokerStarted(ctx: ExtensionContext): Promise<void> {
		if (isBroker) return;
		brokerState = await loadBrokerState();
		assistantFinalLedger.start();
		brokerServer = await createIpcServer(localBrokerSocketPath, handleBrokerIpc);
		isBroker = true;
		brokerHeartbeatFailures = 0;
		brokerHeartbeatTimer = setInterval(() => {
			void renewBrokerLease().then(() => {
				brokerHeartbeatFailures = 0;
				assistantFinalLedger.kick();
			}).catch(() => {
				brokerHeartbeatFailures += 1;
				if (brokerHeartbeatFailures >= 2) void stopBroker();
			});
		}, BROKER_HEARTBEAT_MS);
		brokerPollAbort = new AbortController();
		void pollLoop(ctx, brokerPollAbort.signal);
		schedulePendingMediaGroups(ctx);
		void retryPendingTurns();
		assistantFinalLedger.kick();
		updateStatus(ctx);
	}
	async function stopBroker(): Promise<void> {
		if (!isBroker && !brokerServer) return;
		isBroker = false;
		brokerPollAbort?.abort();
		brokerPollAbort = undefined;
		if (brokerHeartbeatTimer) clearInterval(brokerHeartbeatTimer);
		brokerHeartbeatTimer = undefined;
		for (const timer of typingLoops.values()) if (timer) clearInterval(timer);
		typingLoops.clear();
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
	async function startClientServer(): Promise<void> {
		if (clientServer && activeClientSocketPath === clientSocketPath) return;
		if (clientServer) await stopClientServer();
		await ensurePrivateDir(BROKER_DIR);
		clientSocketPath = join(BROKER_DIR, `client-${ownerId}.sock`);
		clientServer = await createIpcServer(clientSocketPath, handleClientIpc);
		activeClientSocketPath = clientSocketPath;
	}
	async function stopClientServer(): Promise<void> {
		if (clientHeartbeatTimer) clearInterval(clientHeartbeatTimer);
		clientHeartbeatTimer = undefined;
		await new Promise<void>((resolveValue) => clientServer?.close(() => resolveValue()) ?? resolveValue());
		clientServer = undefined;
		await rm(activeClientSocketPath ?? clientSocketPath, { force: true }).catch(() => undefined);
		activeClientSocketPath = undefined;
		connectedRoute = undefined;
	}
	function scheduleClientReconnect(ctx: ExtensionContext): void {
		if (clientReconnectInFlight) return;
		clientReconnectInFlight = true;
		void (async () => {
			if (!clientServer) return;
			const lease = await readLease();
			const leaseLive = await isLeaseLive(lease);
			if (!clientServer) return;
			if (leaseLive) await registerWithBroker(ctx, lease!.socketPath);
			else await connectTelegram(ctx, false);
		})().catch((error) => {
			if (clientServer) updateStatus(ctx, errorMessage(error));
		}).finally(() => {
			clientReconnectInFlight = false;
		});
	}
	async function registerWithBroker(ctx: ExtensionContext, socketPath: string): Promise<TelegramRoute> {
		connectedBrokerSocketPath = socketPath;
		let route: TelegramRoute | undefined;
		let lastError: unknown;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			try {
				const registration = await collectSessionRegistration(ctx);
				route = await postIpc<TelegramRoute>(socketPath, "register_session", registration, sessionId);
				break;
			} catch (error) {
				lastError = error;
				if (attempt < 4) await new Promise((resolveValue) => setTimeout(resolveValue, 150 * (attempt + 1)));
			}
		}
		if (!route) throw lastError instanceof Error ? lastError : new Error("Failed to register with Telegram broker");
		connectedRoute = route;
		if (clientHeartbeatTimer) clearInterval(clientHeartbeatTimer);
		clientHeartbeatTimer = setInterval(() => {
			void (async () => {
				try {
					const heartbeat = await collectSessionRegistration(ctx);
					const result = await postIpc<{ route?: TelegramRoute }>(connectedBrokerSocketPath, "heartbeat_session", heartbeat, sessionId);
					if (result.route) connectedRoute = result.route;
					await retryPendingAssistantFinals(); if (!assistantFinalQueue.deferNewFinals()) startNextTelegramTurn();
				} catch {
					scheduleClientReconnect(ctx);
				}
			})();
		}, CLIENT_HEARTBEAT_MS);
		ensureCurrentTurnMirroredToTelegram(ctx, "Telegram connected during an active pi turn; mirroring from this point on.");
		updateStatus(ctx);
		return route;
	}
	function ensureCurrentTurnMirroredToTelegram(ctx: ExtensionContext | undefined, historyText: string): void {
		if (!ctx || ctx.isIdle() || activeTelegramTurn || !isRoutableRoute(connectedRoute)) return;
		activeTelegramTurn = {
			turnId: randomId("local"),
			sessionId,
			chatId: connectedRoute.chatId,
			messageThreadId: connectedRoute.messageThreadId,
			replyToMessageId: 0,
			queuedAttachments: [],
			content: [],
			historyText,
		};
	}
	async function connectTelegram(ctx: ExtensionContext, notify = true): Promise<void> {
		setLatestContext(ctx);
		showTelegramStatus(ctx);
		config = await readConfig();
		applyBrokerScope();
		if (!config.botToken) {
			const configured = await promptForConfig(ctx);
			if (!configured || !config.botToken) return;
			applyBrokerScope();
		}
		if (config.botToken && config.botId === undefined) {
			const user = await callTelegram<TelegramUser>("getMe", {});
			config.botId = user.id;
			config.botUsername = user.username;
			config.topicsEnabled = user.has_topics_enabled;
			await writeConfig(config);
			applyBrokerScope();
		}
		await startClientServer();
		const lease = await readLease();
		if (await isLeaseLive(lease)) {
			try {
				await postIpc(lease!.socketPath, "reload_config", {}, sessionId).catch(() => undefined);
				await registerWithBroker(ctx, lease!.socketPath);
				if (notify) ctx.ui.notify(`Telegram connected: ${connectedRoute?.topicName ?? "session"}`, "info");
				return;
			} catch {
				// Try election below.
			}
		}
		await new Promise((resolveValue) => setTimeout(resolveValue, Math.floor(Math.random() * 500)));
		if (await tryAcquireBroker()) {
			connectedBrokerSocketPath = localBrokerSocketPath;
			await ensureBrokerStarted(ctx);
			const route = await registerWithBroker(ctx, localBrokerSocketPath);
			if (notify) ctx.ui.notify(`Telegram broker started: ${route.topicName}`, "info");
			return;
		}
		const nextLease = await readLease();
		if (await isLeaseLive(nextLease)) {
			await registerWithBroker(ctx, nextLease!.socketPath);
			return;
		}
		throw new Error("Could not connect to or become Telegram broker");
	}
	async function promptForConfig(ctx: ExtensionContext): Promise<boolean> {
		showTelegramStatus(ctx);
		if (!ctx.hasUI || setupInProgress) return false;
		setupInProgress = true;
		try {
			const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
			if (!token) return false;
			const nextConfig: TelegramConfig = {
				...config,
				botToken: token.trim(),
				topicMode: config.topicMode ?? "auto",
				fallbackMode: config.fallbackMode ?? "single_chat_selector",
				allowedUserId: undefined,
				allowedChatId: undefined,
			};
			const response = await fetch(`https://api.telegram.org/bot${nextConfig.botToken}/getMe`);
			const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
			if (!data.ok || !data.result) {
				ctx.ui.notify(data.description || "Invalid Telegram bot token", "error");
				return false;
			}
			nextConfig.botId = data.result.id;
			nextConfig.botUsername = data.result.username;
			configureBrokerScope(nextConfig.botId);
			nextConfig.topicsEnabled = data.result.has_topics_enabled;
			const pairingPin = formatPairingPin(randomInt(10_000));
			const pairingStartedAtMs = now();
			nextConfig.pairingCodeHash = hashSecret(pairingPin);
			nextConfig.pairingCreatedAtMs = pairingStartedAtMs;
			nextConfig.pairingExpiresAtMs = pairingStartedAtMs + PAIRING_PIN_TTL_MS;
			nextConfig.pairingFailedAttempts = 0;
			config = nextConfig;
			await writeConfig(config);
			showPairingInstructions(ctx, pairingPin);
			return true;
		} finally {
			setupInProgress = false;
		}
	}
	async function handleBrokerIpc(envelope: IpcEnvelope): Promise<unknown> {
		const lease = await readLease();
		if (!isBroker || !lease || lease.ownerId !== ownerId || lease.leaseEpoch !== brokerLeaseEpoch || lease.leaseUntilMs <= now()) throw new Error("stale_broker");
		if (envelope.type === "reload_config") {
			config = await readConfig();
			applyBrokerScope();
			return { ok: true };
		}
		if (envelope.type === "register_session") return await registerSession(envelope.payload as SessionRegistration);
		if (envelope.type === "heartbeat_session") return await heartbeatSession(envelope.payload as SessionRegistration);
		if (envelope.type === "unregister_session") return await unregisterSession(envelope.session_id ?? (envelope.payload as { sessionId?: string }).sessionId ?? "");
		if (envelope.type === "mark_session_offline") return await markSessionOffline(envelope.session_id ?? (envelope.payload as { sessionId?: string }).sessionId ?? "");
		if (envelope.type === "turn_started") return await handleTurnStarted(envelope.payload as { turnId: string });
		if (envelope.type === "assistant_message_start") return await handleAssistantMessageStart(envelope.payload as { turnId: string; chatId: number; messageThreadId?: number });
		if (envelope.type === "assistant_preview") return await handleAssistantPreview(envelope.payload as { turnId: string; chatId: number; messageThreadId?: number; text: string });
		if (envelope.type === "activity_update") return await activityRenderer.handleUpdate(envelope.payload as ActivityUpdatePayload);
		if (envelope.type === "assistant_final") return await assistantFinalLedger.accept(envelope.payload as AssistantFinalPayload);
		if (envelope.type === "turn_consumed") return await handleTurnConsumed(envelope.payload as { turnId: string });
		if (envelope.type === "local_user_message") return await handleLocalUserMessage(envelope.session_id, envelope.payload as { text: string; imagesCount?: number });
		throw new Error(`Unsupported broker IPC message: ${envelope.type}`);
	}
	async function handleLocalUserMessage(sourceSessionId: string | undefined, payload: { text: string; imagesCount?: number }): Promise<{ ok: true }> {
		if (!brokerState || !sourceSessionId) return { ok: true };
		const route = Object.values(brokerState.routes).find((candidate) => candidate.sessionId === sourceSessionId && candidate.chatId !== 0);
		if (!route) return { ok: true };
		await sendTextReply(route.chatId, route.messageThreadId, formatLocalUserMirrorMessage(payload.text, payload.imagesCount));
		return { ok: true };
	}
	async function registerSession(registration: SessionRegistration): Promise<TelegramRoute> {
		if (!brokerState) brokerState = await loadBrokerState();
		registration.lastHeartbeatMs = now();
		registration.status = registration.status === "connecting" ? "idle" : registration.status;
		registration.topicName = topicNameFor(registration);
		brokerState.sessions[registration.sessionId] = registration;
		const route = await ensureRouteForSessionLocked(registration);
		await persistBrokerState();
		refreshTelegramStatus();
		return route;
	}
	async function heartbeatSession(registration: SessionRegistration): Promise<{ ok: true; route?: TelegramRoute }> {
		if (!brokerState) brokerState = await loadBrokerState();
		const previous = brokerState.sessions[registration.sessionId];
		if (!previous) throw new Error("Session is not registered");
		brokerState.sessions[registration.sessionId] = {
			...previous,
			...registration,
			lastHeartbeatMs: now(),
			topicName: topicNameFor(registration),
		};
		const route = await ensureRouteForSessionLocked(brokerState.sessions[registration.sessionId]);
		await persistBrokerState();
		refreshTelegramStatus();
		void retryPendingTurns();
		assistantFinalLedger.kick();
		return { ok: true, route };
	}
	function markSessionOffline(targetSessionId: string): Promise<{ ok: true }> { return markSessionOfflineInBroker({ targetSessionId, getBrokerState: () => brokerState, loadBrokerState, setBrokerState: (state) => { brokerState = state; }, persistBrokerState, refreshTelegramStatus, stopTypingLoop }); }
	function unregisterSession(targetSessionId: string): Promise<{ ok: true }> { return unregisterSessionFromBroker({ targetSessionId, getBrokerState: () => brokerState, loadBrokerState, setBrokerState: (state) => { brokerState = state; }, persistBrokerState, refreshTelegramStatus, stopTypingLoop, callTelegram }); }
	function ensureRouteForSessionLocked(registration: SessionRegistration): Promise<TelegramRoute> {
		const existing = routeEnsures.get(registration.sessionId);
		if (existing) return existing;
		const ensure = ensureRouteForSession(registration).finally(() => routeEnsures.delete(registration.sessionId));
		routeEnsures.set(registration.sessionId, ensure);
		return ensure;
	}
	async function ensureRouteForSession(registration: SessionRegistration): Promise<TelegramRoute> {
		if (!brokerState) throw new Error("Broker state is not loaded");
		const existing = Object.values(brokerState.routes).find((route) => route.sessionId === registration.sessionId);
		const expectedChatId = targetChatIdForRoutes();
		const selectedChatId = selectedChatIdForSession(registration.sessionId);
		if (existing && existing.chatId !== 0) {
			if (expectedChatId !== undefined && String(existing.chatId) === String(expectedChatId)) return existing;
			if (existing.routeMode === "single_chat_selector" && selectedChatId !== undefined && String(existing.chatId) === String(selectedChatId)) return existing;
			for (const [id, route] of Object.entries(brokerState.routes)) if (route.sessionId === registration.sessionId) delete brokerState.routes[id];
		}
		if (existing && existing.chatId === 0) {
			for (const [id, route] of Object.entries(brokerState.routes)) if (route.sessionId === registration.sessionId) delete brokerState.routes[id];
		}
		if (usesForumSupergroupRouting() && config.fallbackSupergroupChatId === undefined) {
			throw new Error("telegram.fallback_supergroup_chat_id is required for forum_supergroup fallback mode");
		}
		const targetChatId = targetChatIdForRoutes() ?? selectedChatId;
		if (!targetChatId) {
			return {
				routeId: `pending:${registration.sessionId}`,
				sessionId: registration.sessionId,
				chatId: 0,
				routeMode: "single_chat_selector",
				topicName: registration.topicName,
				createdAtMs: now(),
				updatedAtMs: now(),
			};
		}
		let route: TelegramRoute;
		if ((config.topicMode ?? "auto") !== "single_chat_selector" && config.topicMode !== "disabled") {
			try {
				const topic = await callTelegram<TelegramForumTopic>("createForumTopic", { chat_id: targetChatId, name: registration.topicName });
				route = {
					routeId: routeId(targetChatId, topic.message_thread_id),
					sessionId: registration.sessionId,
					chatId: targetChatId,
					messageThreadId: topic.message_thread_id,
					routeMode: usesForumSupergroupRouting() ? "forum_supergroup_topic" : "private_topic",
					topicName: registration.topicName,
					createdAtMs: now(),
					updatedAtMs: now(),
				};
				brokerState.routes[route.routeId] = route;
				await sendTextReply(route.chatId, route.messageThreadId, `Connected pi session: ${registration.topicName}`).catch(() => undefined);
				return route;
			} catch (error) {
				if (config.topicMode === "private_topics" || usesForumSupergroupRouting()) throw error;
				// Auto mode falls back to selector routing for this route only. Do not persistently downgrade config.
			}
		}
		if (config.topicMode === "disabled") throw new Error("Telegram routing is disabled by config");
		route = {
			routeId: routeId(targetChatId),
			sessionId: registration.sessionId,
			chatId: targetChatId,
			routeMode: "single_chat_selector",
			topicName: registration.topicName,
			createdAtMs: now(),
			updatedAtMs: now(),
		};
		brokerState.routes[`${route.routeId}:${registration.sessionId}`] = route;
		await sendTextReply(route.chatId, undefined, `Connected pi session: ${registration.topicName}\nUse /sessions and /use to select sessions.`);
		return route;
	}
	async function ensureRoutesAfterPairing(): Promise<void> {
		if (!brokerState) return;
		for (const session of Object.values(brokerState.sessions)) await ensureRouteForSessionLocked(session);
		await persistBrokerState();
	}
	function createTelegramTurnForSession(messages: TelegramMessage[], sessionIdForTurn: string): Promise<PendingTelegramTurn> {
		return buildTelegramTurnForSession(messages, sessionIdForTurn, downloadTelegramFile);
	}
	async function sendTextReply(chatId: number | string, messageThreadId: number | undefined, text: string): Promise<number | undefined> {
		const chunks = chunkParagraphs(text || " ");
		let lastMessageId: number | undefined;
		for (const chunk of chunks) {
			const body: Record<string, unknown> = { chat_id: chatId, text: chunk };
			if (messageThreadId !== undefined) body.message_thread_id = messageThreadId;
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", body);
			lastMessageId = sent.message_id;
		}
		return lastMessageId;
	}
	async function sendMarkdownReply(chatId: number | string, messageThreadId: number | undefined, text: string): Promise<number | undefined> {
		const chunks = chunkParagraphs(text || " ");
		let lastMessageId: number | undefined;
		for (const chunk of chunks) {
			const body: Record<string, unknown> = { chat_id: chatId, text: chunk, parse_mode: "Markdown" };
			if (messageThreadId !== undefined) body.message_thread_id = messageThreadId;
			try {
				const sent = await callTelegram<TelegramSentMessage>("sendMessage", body);
				lastMessageId = sent.message_id;
			} catch (error) {
				if (getTelegramRetryAfterMs(error) !== undefined) throw error;
				lastMessageId = await sendTextReply(chatId, messageThreadId, chunk);
			}
		}
		return lastMessageId;
	}
	async function startTypingLoopFor(turnId: string, chatId: number | string, messageThreadId?: number): Promise<void> {
		if (typingLoops.has(turnId)) return;
		typingLoops.set(turnId, undefined);
		const sendTyping = async (): Promise<void> => {
			const body: Record<string, unknown> = { chat_id: chatId, action: "typing" };
			if (messageThreadId !== undefined) body.message_thread_id = messageThreadId;
			await callTelegram("sendChatAction", body).catch(() => undefined);
		};
		await sendTyping();
		if (!typingLoops.has(turnId)) return;
		typingLoops.set(turnId, setInterval(() => void sendTyping(), 4000));
	}
	async function startTypingLoop(turn: PendingTelegramTurn): Promise<void> {
		await startTypingLoopFor(turn.turnId, turn.chatId, turn.messageThreadId);
	}
	function stopTypingLoop(turnId: string): void {
		const timer = typingLoops.get(turnId);
		if (timer) clearInterval(timer);
		typingLoops.delete(turnId);
	}
	async function handleTurnStarted(payload: { turnId: string }): Promise<{ ok: true }> {
		const pending = brokerState?.pendingTurns?.[payload.turnId];
		if (pending) await startTypingLoop(pending.turn);
		return { ok: true };
	}
	async function handleAssistantMessageStart(payload: { turnId: string; chatId: number | string; messageThreadId?: number }): Promise<{ ok: true }> {
		await startTypingLoopFor(payload.turnId, payload.chatId, payload.messageThreadId);
		await previewManager.messageStart(payload.turnId, payload.chatId, payload.messageThreadId);
		return { ok: true };
	}
	async function handleAssistantPreview(payload: { turnId: string; chatId: number | string; messageThreadId?: number; text: string }): Promise<{ ok: true }> {
		previewManager.preview(payload.turnId, payload.chatId, payload.messageThreadId, payload.text);
		return { ok: true };
	}
	async function rememberCompletedBrokerTurn(turnId: string): Promise<void> {
		brokerState ??= await loadBrokerState();
		brokerState.completedTurnIds ??= [];
		if (!brokerState.completedTurnIds.includes(turnId)) brokerState.completedTurnIds.push(turnId);
		if (brokerState.completedTurnIds.length > 1000) brokerState.completedTurnIds.splice(0, brokerState.completedTurnIds.length - 1000);
	}
	async function handleTurnConsumed(payload: { turnId: string }): Promise<{ ok: true }> {
		if (brokerState?.pendingAssistantFinals?.[payload.turnId]) {
			if (brokerState.pendingTurns?.[payload.turnId]) delete brokerState.pendingTurns[payload.turnId];
			stopTypingLoop(payload.turnId);
			await persistBrokerState();
			return { ok: true };
		}
		await rememberCompletedBrokerTurn(payload.turnId);
		if (brokerState?.pendingTurns?.[payload.turnId]) delete brokerState.pendingTurns[payload.turnId];
		stopTypingLoop(payload.turnId);
		await persistBrokerState();
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

	async function handleClientIpc(envelope: IpcEnvelope): Promise<unknown> {
		if (envelope.type === "deliver_turn") return await clientDeliverTurn(envelope.payload as PendingTelegramTurn);
		if (envelope.type === "abort_turn") return await clientAbortTurn();
		if (envelope.type === "query_status") return { text: await clientStatusText() };
		if (envelope.type === "compact_session") return clientCompact();
		if (envelope.type === "query_models") return clientQueryModels((envelope.payload as { filter?: string }).filter);
		if (envelope.type === "set_model") return await clientSetModel((envelope.payload as { selector: string }).selector);
		if (envelope.type === "shutdown_client_route") {
			queuedTelegramTurns = [];
			activeTelegramTurn = undefined;
			currentAbort?.();
			connectedRoute = undefined;
			setTimeout(() => void stopClientServer(), 0);
			return { ok: true };
		}
		throw new Error(`Unsupported client IPC message: ${envelope.type}`);
	}

	function rememberCompletedLocalTurn(turnId: string): void {
		completedTurnIds.add(turnId);
		if (completedTurnIds.size > 1000) {
			const oldestTurnId = completedTurnIds.values().next().value;
			if (oldestTurnId) completedTurnIds.delete(oldestTurnId);
		}
	}

	async function acknowledgeConsumedTurn(turnId: string): Promise<void> {
		rememberCompletedLocalTurn(turnId);
		await postIpc(connectedBrokerSocketPath, "turn_consumed", { turnId }, sessionId).catch(() => undefined);
	}

	async function clientDeliverTurn(turn: PendingTelegramTurn): Promise<{ accepted: true }> {
		if (completedTurnIds.has(turn.turnId)) {
			const pendingFinal = assistantFinalQueue.find(turn.turnId);
			if (pendingFinal) {
				await sendAssistantFinalToBroker(pendingFinal);
				return { accepted: true };
			}
			await acknowledgeConsumedTurn(turn.turnId);
			return { accepted: true };
		}
		if (activeTelegramTurn?.turnId === turn.turnId || queuedTelegramTurns.some((candidate) => candidate.turnId === turn.turnId)) return { accepted: true };
		const ctx = latestCtx;
		const isBusy = ctx ? !ctx.isIdle() : Boolean(activeTelegramTurn);
		if (isBusy && turn.deliveryMode !== "followUp") {
			ensureCurrentTurnMirroredToTelegram(ctx, "Telegram steering message received during an active pi turn; mirroring from this point on.");
			pi.sendUserMessage(turn.content, { deliverAs: "steer" });
			await acknowledgeConsumedTurn(turn.turnId);
			return { accepted: true };
		}
		queuedTelegramTurns.push(turn);
		if (ctx?.isIdle()) startNextTelegramTurn();
		return { accepted: true };
	}

	async function clientAbortTurn(): Promise<{ text: string; clearedTurnIds: string[] }> {
		const clearedTurnIds = queuedTelegramTurns.map((turn) => turn.turnId);
		const queuedCount = clearedTurnIds.length;
		queuedTelegramTurns = [];
		for (const turnId of clearedTurnIds) rememberCompletedLocalTurn(turnId);
		if (currentAbort) {
			if (activeTelegramTurn) {
				rememberCompletedLocalTurn(activeTelegramTurn.turnId);
				clearedTurnIds.push(activeTelegramTurn.turnId);
			}
			currentAbort();
			return { text: queuedCount > 0 ? `Aborted current turn and suppressed ${queuedCount} queued turn(s).` : "Aborted current turn.", clearedTurnIds };
		}
		return { text: queuedCount > 0 ? `Suppressed ${queuedCount} queued turn(s).` : "No active turn.", clearedTurnIds };
	}

	function startNextTelegramTurn(): void {
		if (activeTelegramTurn) return;
		const turn = queuedTelegramTurns.shift();
		if (!turn) return;
		activeTelegramTurn = { ...turn, queuedAttachments: [] };
		void postIpc(connectedBrokerSocketPath, "turn_started", { turnId: turn.turnId }, sessionId).catch(() => undefined);
		pi.sendUserMessage(turn.content);
	}

	async function clientStatusText(): Promise<string> {
		return buildClientStatusText({
			ctx: latestCtx,
			connectedRoute,
			sessionName: pi.getSessionName(),
			lease: await readLease(),
			activeTelegramTurn,
			queuedTurnCount: queuedTelegramTurns.length,
		});
	}

	function clientCompact(): { text: string } {
		const ctx = latestCtx;
		if (!ctx) return { text: "Session context unavailable." };
		if (!ctx.isIdle()) return { text: "Cannot compact while this session is busy. Send stop first." };
		ctx.compact({
			onComplete: () => {
				if (isRoutableRoute(connectedRoute)) void sendAssistantFinalToBroker({ turn: { turnId: randomId("cmd"), sessionId, chatId: connectedRoute.chatId, messageThreadId: connectedRoute.messageThreadId, replyToMessageId: 0, queuedAttachments: [], content: [], historyText: "" }, text: "Compaction completed.", attachments: [] });
			},
			onError: (error) => {
				if (isRoutableRoute(connectedRoute)) void sendAssistantFinalToBroker({ turn: { turnId: randomId("cmd"), sessionId, chatId: connectedRoute.chatId, messageThreadId: connectedRoute.messageThreadId, replyToMessageId: 0, queuedAttachments: [], content: [], historyText: "" }, text: `Compaction failed: ${errorMessage(error)}`, attachments: [] });
			},
		});
		return { text: "Compaction started." };
	}


	function clientQueryModels(filter?: string): { current?: string; models: ModelSummary[] } {
		return buildClientQueryModels(latestCtx, filter);
	}

	async function clientSetModel(selector: string): Promise<{ text: string }> {
		return setClientModel(latestCtx, (model) => pi.setModel(model), selector);
	}

	async function resolveAllowedAttachmentPath(inputPath: string): Promise<string | undefined> {
		const basePath = isAbsolute(inputPath) ? inputPath : resolve(latestCtx?.cwd ?? process.cwd(), inputPath);
		const abs = await realpath(basePath).catch(() => resolve(basePath));
		const cwd = latestCtx?.cwd ? await realpath(latestCtx.cwd).catch(() => resolve(latestCtx!.cwd)) : undefined;
		const tmp = await realpath(TEMP_DIR).catch(() => resolve(TEMP_DIR));
		const base = basename(abs);
		if (base === ".env" || base.startsWith(".env.") || base === "id_rsa" || base === "id_ed25519" || abs.includes("/.ssh/") || abs.includes("/.aws/")) return undefined;
		const allowed = (cwd !== undefined && (abs === cwd || abs.startsWith(`${cwd}/`))) || abs.startsWith(`${tmp}/`);
		return allowed ? abs : undefined;
	}
	async function sendAssistantFinalToBroker(payload: AssistantFinalPayload, fromRetryQueue = false): Promise<boolean> {
		if (!fromRetryQueue && assistantFinalQueue.deferNewFinals()) {
			assistantFinalQueue.enqueue(payload);
			return false;
		}
		try {
			await postIpc(connectedBrokerSocketPath, "assistant_final", payload, sessionId);
			assistantFinalQueue.markDelivered(payload.turn.turnId);
			return true;
		} catch (error) {
			if (getTelegramRetryAfterMs(error) !== undefined) {
				assistantFinalQueue.markRetryable(payload, error);
				return false;
			}
			const lease = await readLease();
			if (await isLeaseLive(lease)) {
				connectedBrokerSocketPath = lease!.socketPath;
				try {
					await postIpc(connectedBrokerSocketPath, "assistant_final", payload, sessionId);
					assistantFinalQueue.markDelivered(payload.turn.turnId);
					return true;
				} catch (retryError) {
					assistantFinalQueue.markRetryable(payload, retryError);
					return false;
				}
			}
		}
		assistantFinalQueue.markRetryable(payload);
		return false;
	}

	async function retryPendingAssistantFinals(): Promise<void> {
		while (true) {
			const pending = assistantFinalQueue.beginReadyAttempt();
			if (!pending) return;
			const delivered = await sendAssistantFinalToBroker(pending, true);
			if (!delivered) return;
		}
	}

	registerRuntimePiHooks(pi, {
		getConfig: () => config,
		setLatestCtx: setLatestContext,
		getConnectedRoute: () => connectedRoute,
		setConnectedRoute: (route) => { connectedRoute = route; },
		getActiveTelegramTurn: () => activeTelegramTurn,
		setActiveTelegramTurn: (turn) => { activeTelegramTurn = turn; },
		setQueuedTelegramTurns: (turns) => { queuedTelegramTurns = turns; },
		setCurrentAbort: (abort) => { currentAbort = abort; },
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
		stopClientServer,
		stopBroker,
		hideTelegramStatus,
		updateStatus,
		readLease,
		sendAssistantFinalToBroker,
		rememberCompletedLocalTurn,
		startNextTelegramTurn,
		onSessionStart: async (ctx) => {
			setLatestContext(ctx);
			config = await readConfig();
			applyBrokerScope();
			await ensurePrivateDir(BROKER_DIR);
			await mkdir(TEMP_DIR, { recursive: true });
		},
		clearMediaGroups: () => {
			for (const state of mediaGroups.values()) if (state.flushTimer) clearTimeout(state.flushTimer);
			mediaGroups.clear();
		},
	});

}
