import type { Server } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { CLIENT_HEARTBEAT_MS, BROKER_DIR } from "../shared/config.js";
import { QUEUED_CONTROL_TEXT } from "../shared/queued-control-text.js";
import type {
	ActiveTelegramTurn,
	AssistantFinalPayload,
	BrokerLease,
	CancelQueuedTurnRequest,
	CancelQueuedTurnResult,
	ClientDeliverTurnResult,
	ClientGitRepositoryQueryRequest,
	ClientGitRepositoryQueryResult,
	ConvertQueuedTurnToSteerRequest,
	ConvertQueuedTurnToSteerResult,
	IpcEnvelope,
	ModelSummary,
	PendingTelegramTurn,
	SessionRegistration,
	TelegramConfig,
	TelegramRoute,
} from "../shared/types.js";
import { ensurePrivateDir, errorMessage, now, randomId } from "../shared/utils.js";
import { connectTelegramClient } from "./connection.js";
import { ClientRuntime } from "./runtime.js";
import { collectSessionRegistration as buildSessionRegistration } from "./session-registration.js";
import { ManualCompactionTurnQueue } from "./manual-compaction.js";
import { shutdownTelegramClientRoute } from "./route-shutdown.js";

export interface ClientRuntimeHostFinalizer {
	cancel(): void;
	consumeDeferredPayload(): AssistantFinalPayload | undefined;
	flushDeferredTurn(options?: { startNext?: boolean }): Promise<string | undefined>;
	finalizeActiveTurn(payload: AssistantFinalPayload): Promise<"completed" | "deferred">;
	hasDeferredTurn(turnId?: string): boolean;
	releaseDeferredTurn(options?: { markCompleted?: boolean; startNext?: boolean; deliverAbortedFinal?: boolean; requireDelivery?: boolean }): Promise<string | undefined>;
	restoreDeferredPayload(payload: AssistantFinalPayload): void;
	onAgentStart(): void;
	onRetryMessageStart(): void;
}

export interface ClientRuntimeHostFinalHandoff {
	clearPersistedDeferredPayload(): void;
	clearQueue(): void;
	deferNewFinals(): boolean;
	enqueueAbortedFinal(turn: PendingTelegramTurn): Promise<void>;
	find(turnId: string): AssistantFinalPayload | undefined;
	handoffPendingForShutdown(): Promise<void>;
	persistPending(sessionId: string): Promise<void>;
	persistRestoredDeferredStateWhileBrokerHoldsLock(sessionId: string): Promise<void>;
	retryPending(): Promise<void>;
	setPersistedDeferredPayload(payload: AssistantFinalPayload | undefined): void;
}

export interface ClientRuntimeHostDeps {
	pi: ExtensionAPI;
	ownerId: string;
	startedAtMs: number;
	getSessionId: () => string;
	getLatestCtx: () => ExtensionContext | undefined;
	setLatestContext: (ctx: ExtensionContext) => string;
	getSessionReplacementContext: () => { reason: "new" | "resume" | "fork"; previousSessionFile?: string; sessionFile?: string } | undefined;
	getConfig: () => TelegramConfig;
	setConfig: (config: TelegramConfig) => void;
	readConfig: () => Promise<TelegramConfig>;
	writeConfig: (config: TelegramConfig) => Promise<void>;
	showTelegramStatus: (ctx: ExtensionContext) => void;
	promptForConfig: (ctx: ExtensionContext) => Promise<boolean>;
	applyBrokerScope: () => void;
	callTelegram: <TResponse>(method: string, body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<TResponse>;
	readLease: () => Promise<BrokerLease | undefined>;
	isLeaseLive: (lease: BrokerLease | undefined) => Promise<boolean>;
	tryAcquireBroker: () => Promise<boolean>;
	ensureBrokerStarted: (ctx: ExtensionContext) => Promise<void>;
	getLocalBrokerSocketPath: () => string;
	getConnectedBrokerSocketPath: () => string;
	setConnectedBrokerSocketPath: (socketPath: string) => void;
	createIpcServer: (socketPath: string, handler: (envelope: IpcEnvelope) => Promise<unknown>) => Promise<Server>;
	postIpc: <TResponse>(socketPath: string, type: string, payload: unknown, targetSessionId?: string) => Promise<TResponse>;
	acknowledgeStaleClientConnection: (connectionNonce: string) => Promise<void>;
	isStaleSessionConnectionError: (error: unknown) => boolean;
	activeTurnFinalizer: ClientRuntimeHostFinalizer;
	assistantFinalHandoff: ClientRuntimeHostFinalHandoff;
	clearAssistantPreviewInBroker: (turnId: string, chatId: number | string, messageThreadId: number | undefined, preserveOnFailure: boolean) => Promise<void>;
	isRoutableRoute: (route: TelegramRoute | undefined) => route is TelegramRoute;
	sendAssistantFinalToBroker: (payload: AssistantFinalPayload) => Promise<boolean>;
	updateStatus: (ctx: ExtensionContext, detail?: string) => void;
}

export class ClientRuntimeHost {
	private clientServer: Server | undefined;
	private clientHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private clientConnectionNonce = randomId("conn");
	private clientConnectionStartedAtMs = now();
	private clientReconnectInFlight = false;
	private clientSocketPath: string;
	private activeClientSocketPath: string | undefined;
	private connectedRoute: TelegramRoute | undefined;
	private queuedTelegramTurns: PendingTelegramTurn[] = [];
	private activeTelegramTurn: ActiveTelegramTurn | undefined;
	private currentAbort: (() => void) | undefined;
	private awaitingTelegramFinalTurnId: string | undefined;
	private readonly completedTurnIds = new Set<string>();
	private readonly disconnectedTurnIds = new Set<string>();
	private readonly manualCompactionQueue: ManualCompactionTurnQueue;
	private readonly clientRuntime: ClientRuntime;

	constructor(private readonly deps: ClientRuntimeHostDeps) {
		this.clientSocketPath = join(BROKER_DIR, `client-${this.deps.ownerId}.sock`);
		this.manualCompactionQueue = new ManualCompactionTurnQueue({
			getQueuedTelegramTurns: () => this.queuedTelegramTurns,
			setQueuedTelegramTurns: (turns) => { this.queuedTelegramTurns = turns; },
			getActiveTelegramTurn: () => this.activeTelegramTurn,
			hasAwaitingTelegramFinalTurn: () => this.awaitingTelegramFinalTurnId !== undefined,
			setActiveTelegramTurn: (turn) => { this.activeTelegramTurn = turn; },
			prepareTurnAbort: () => {
				const ctx = this.deps.getLatestCtx();
				if (ctx) this.currentAbort = () => ctx.abort();
			},
			postTurnStarted: (turnId) => {
				void this.deps.postIpc(this.deps.getConnectedBrokerSocketPath(), "turn_started", { turnId }, this.deps.getSessionId()).catch(() => undefined);
			},
			sendUserMessage: (content, options) => { void this.deps.pi.sendUserMessage(content, options); },
			acknowledgeConsumedTurn: (turnId, finalizeQueuedControlText) => {
				void this.acknowledgeConsumedTurn(turnId, finalizeQueuedControlText);
			},
		});
		this.clientRuntime = new ClientRuntime({
			pi: this.deps.pi,
			completedTurnIds: this.completedTurnIds,
			getSessionId: this.deps.getSessionId,
			getLatestCtx: this.deps.getLatestCtx,
			getConnectedRoute: () => this.connectedRoute,
			isRoutableRoute: this.deps.isRoutableRoute,
			getActiveTelegramTurn: () => this.activeTelegramTurn,
			setActiveTelegramTurn: (turn) => { this.activeTelegramTurn = turn; },
			getQueuedTelegramTurns: () => this.queuedTelegramTurns,
			getCurrentAbort: () => this.currentAbort,
			setCurrentAbort: (abort) => { this.currentAbort = abort; },
			getManualCompactionQueue: () => this.manualCompactionQueue,
			activeTurnFinalizer: this.deps.activeTurnFinalizer,
			findPendingFinal: (turnId) => this.deps.assistantFinalHandoff.find(turnId),
			sendAssistantFinalToBroker: this.deps.sendAssistantFinalToBroker,
			acknowledgeConsumedTurn: (turnId, finalizeQueuedControlText) => this.acknowledgeConsumedTurn(turnId, finalizeQueuedControlText),
			ensureCurrentTurnMirroredToTelegram: (ctx, historyText) => this.ensureCurrentTurnMirroredToTelegram(ctx, historyText),
			startNextTelegramTurn: () => this.startNextTelegramTurn(),
			readLease: this.deps.readLease,
			updateStatus: this.deps.updateStatus,
		});
	}

	refreshBrokerScope(): void {
		this.clientSocketPath = join(BROKER_DIR, `client-${this.deps.ownerId}.sock`);
	}

	getClientSocketPath(): string { return this.clientSocketPath; }
	getConnectionNonce(): string { return this.clientConnectionNonce; }
	getConnectionStartedAtMs(): number { return this.clientConnectionStartedAtMs; }
	getConnectedRoute(): TelegramRoute | undefined { return this.connectedRoute; }
	setConnectedRoute(route: TelegramRoute | undefined): void { this.connectedRoute = route; }
	getActiveTelegramTurn(): ActiveTelegramTurn | undefined { return this.activeTelegramTurn; }
	setActiveTelegramTurn(turn: ActiveTelegramTurn | undefined): void { this.activeTelegramTurn = turn; }
	getQueuedTelegramTurns(): PendingTelegramTurn[] { return this.queuedTelegramTurns; }
	setQueuedTelegramTurns(turns: PendingTelegramTurn[]): void { this.queuedTelegramTurns = turns; }
	getCurrentAbort(): (() => void) | undefined { return this.currentAbort; }
	setCurrentAbort(abort: (() => void) | undefined): void { this.currentAbort = abort; }
	hasAwaitingTelegramFinalTurn(): boolean { return this.awaitingTelegramFinalTurnId !== undefined; }
	setAwaitingTelegramFinalTurn(turnId: string | undefined): void { this.awaitingTelegramFinalTurnId = turnId; }
	clearAwaitingTelegramFinalTurn(turnId: string): void { if (this.awaitingTelegramFinalTurnId === turnId) this.awaitingTelegramFinalTurnId = undefined; }
	getAwaitingTelegramFinalTurnId(): string | undefined { return this.awaitingTelegramFinalTurnId; }
	getManualCompactionQueue(): ManualCompactionTurnQueue { return this.manualCompactionQueue; }
	isTurnDisconnected(turnId: string): boolean { return this.disconnectedTurnIds.has(turnId); }
	hasClientServer(): boolean { return this.clientServer !== undefined; }
	hasLiveAgentRun(): boolean { return this.currentAbort !== undefined; }

	collectSessionRegistration(ctx: ExtensionContext): Promise<SessionRegistration> {
		return buildSessionRegistration({
			ctx,
			sessionId: this.deps.getSessionId(),
			ownerId: this.deps.ownerId,
			startedAtMs: this.deps.startedAtMs,
			connectionStartedAtMs: this.clientConnectionStartedAtMs,
			connectionNonce: this.clientConnectionNonce,
			clientSocketPath: this.clientSocketPath,
			piSessionName: this.deps.pi.getSessionName(),
			activeTelegramTurn: this.activeTelegramTurn,
			queuedTelegramTurns: this.queuedTelegramTurns,
			manualCompactionInProgress: this.manualCompactionQueue.isActive(),
			replacement: this.deps.getSessionReplacementContext(),
		});
	}

	async startClientServer(): Promise<void> {
		if (this.clientServer && this.activeClientSocketPath === this.clientSocketPath) return;
		if (this.clientServer) await this.stopClientServer();
		await ensurePrivateDir(BROKER_DIR);
		this.clientSocketPath = join(BROKER_DIR, `client-${this.deps.ownerId}.sock`);
		this.clientConnectionNonce = randomId("conn");
		this.clientConnectionStartedAtMs = now();
		this.clientServer = await this.deps.createIpcServer(this.clientSocketPath, (envelope) => this.handleClientIpc(envelope));
		this.activeClientSocketPath = this.clientSocketPath;
	}

	stopClientHeartbeat(): void {
		if (this.clientHeartbeatTimer) clearInterval(this.clientHeartbeatTimer);
		this.clientHeartbeatTimer = undefined;
	}

	async stopClientServer(): Promise<void> {
		this.stopClientHeartbeat();
		await new Promise<void>((resolveValue) => this.clientServer?.close(() => resolveValue()) ?? resolveValue());
		this.clientServer = undefined;
		await rm(this.activeClientSocketPath ?? this.clientSocketPath, { force: true }).catch(() => undefined);
		this.activeClientSocketPath = undefined;
		this.connectedRoute = undefined;
	}

	scheduleClientReconnect(ctx: ExtensionContext): void {
		if (this.clientReconnectInFlight) return;
		this.clientReconnectInFlight = true;
		void (async () => {
			if (!this.clientServer) return;
			const lease = await this.deps.readLease();
			const leaseLive = await this.deps.isLeaseLive(lease);
			if (!this.clientServer) return;
			if (leaseLive) await this.registerWithBroker(ctx, lease!.socketPath);
			else await this.connectTelegram(ctx, false);
		})().catch((error) => {
			if (this.clientServer) this.deps.updateStatus(ctx, errorMessage(error));
		}).finally(() => {
			this.clientReconnectInFlight = false;
		});
	}

	async registerWithBroker(ctx: ExtensionContext, socketPath: string): Promise<TelegramRoute> {
		this.deps.setConnectedBrokerSocketPath(socketPath);
		let route: TelegramRoute | undefined;
		let lastError: unknown;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			try {
				const registration = await this.collectSessionRegistration(ctx);
				route = await this.deps.postIpc<TelegramRoute>(socketPath, "register_session", registration, this.deps.getSessionId());
				break;
			} catch (error) {
				lastError = error;
				if (this.deps.isStaleSessionConnectionError(error)) {
					await this.stopClientServer();
					throw error;
				}
				if (attempt < 4) await new Promise((resolveValue) => setTimeout(resolveValue, 150 * (attempt + 1)));
			}
		}
		if (!route) throw lastError instanceof Error ? lastError : new Error("Failed to register with Telegram broker");
		this.connectedRoute = route;
		if (this.clientHeartbeatTimer) clearInterval(this.clientHeartbeatTimer);
		this.clientHeartbeatTimer = setInterval(() => {
			void this.heartbeatClientSession(ctx);
		}, CLIENT_HEARTBEAT_MS);
		this.ensureCurrentTurnMirroredToTelegram(ctx, "Telegram connected during an active pi turn; mirroring from this point on.");
		this.deps.updateStatus(ctx);
		return route;
	}

	async heartbeatClientSession(ctx: ExtensionContext): Promise<void> {
		try {
			const heartbeat = await this.collectSessionRegistration(ctx);
			const result = await this.deps.postIpc<{ route?: TelegramRoute }>(this.deps.getConnectedBrokerSocketPath(), "heartbeat_session", heartbeat, this.deps.getSessionId());
			if (result.route) this.connectedRoute = result.route;
			await this.deps.assistantFinalHandoff.retryPending();
			if (!this.deps.assistantFinalHandoff.deferNewFinals()) this.startNextTelegramTurn();
		} catch (error) {
			if (this.deps.isStaleSessionConnectionError(error)) {
				await this.stopClientServer();
				return;
			}
			this.scheduleClientReconnect(ctx);
		}
	}

	ensureCurrentTurnMirroredToTelegram(ctx: ExtensionContext | undefined, historyText: string): void {
		if (!ctx || ctx.isIdle() || this.activeTelegramTurn || !this.deps.isRoutableRoute(this.connectedRoute)) return;
		this.activeTelegramTurn = {
			turnId: randomId("local"),
			sessionId: this.deps.getSessionId(),
			routeId: this.connectedRoute.routeId,
			chatId: this.connectedRoute.chatId,
			messageThreadId: this.connectedRoute.messageThreadId,
			replyToMessageId: 0,
			queuedAttachments: [],
			content: [],
			historyText,
		};
	}

	connectTelegram(ctx: ExtensionContext, notify = true): Promise<void> {
		return connectTelegramClient(ctx, {
			setLatestContext: this.deps.setLatestContext,
			showTelegramStatus: this.deps.showTelegramStatus,
			readConfig: this.deps.readConfig,
			setConfig: this.deps.setConfig,
			getConfig: this.deps.getConfig,
			applyBrokerScope: this.deps.applyBrokerScope,
			promptForConfig: this.deps.promptForConfig,
			callTelegram: this.deps.callTelegram,
			writeConfig: this.deps.writeConfig,
			startClientServer: () => this.startClientServer(),
			readLease: this.deps.readLease,
			isLeaseLive: this.deps.isLeaseLive,
			postReloadConfig: (socketPath) => this.deps.postIpc(socketPath, "reload_config", {}, this.deps.getSessionId()),
			registerWithBroker: (connectCtx, socketPath) => this.registerWithBroker(connectCtx, socketPath),
			tryAcquireBroker: async () => {
				const acquired = await this.deps.tryAcquireBroker();
				if (acquired) this.deps.setConnectedBrokerSocketPath(this.deps.getLocalBrokerSocketPath());
				return acquired;
			},
			ensureBrokerStarted: this.deps.ensureBrokerStarted,
			getLocalBrokerSocketPath: this.deps.getLocalBrokerSocketPath,
		}, notify);
	}

	async standDownStaleClientConnection(options?: { acknowledgeBroker?: boolean }): Promise<void> {
		try {
			this.currentAbort?.();
		} catch {
			// Best-effort abort during stale-connection stand-down.
		}
		const deferredPayload = this.deps.activeTurnFinalizer.consumeDeferredPayload();
		this.deps.assistantFinalHandoff.setPersistedDeferredPayload(deferredPayload);
		if (!deferredPayload) this.deps.activeTurnFinalizer.cancel();
		if (this.activeTelegramTurn && this.activeTelegramTurn.turnId !== deferredPayload?.turn.turnId) {
			await this.deps.assistantFinalHandoff.enqueueAbortedFinal(this.activeTelegramTurn);
			this.rememberDisconnectedTurn(this.activeTelegramTurn.turnId);
		}
		await this.deps.assistantFinalHandoff.persistPending(this.deps.getSessionId());
		this.queuedTelegramTurns = [];
		for (const turn of this.manualCompactionQueue.clearPendingRemainder()) this.rememberDisconnectedTurn(turn.turnId);
		this.manualCompactionQueue.reset();
		this.awaitingTelegramFinalTurnId = undefined;
		this.currentAbort = undefined;
		this.activeTelegramTurn = undefined;
		if (options?.acknowledgeBroker) await this.deps.acknowledgeStaleClientConnection(this.clientConnectionNonce);
		await this.stopClientServer();
	}

	discardTelegramClientRouteState(): void {
		this.deps.activeTurnFinalizer.cancel();
		this.currentAbort = undefined;
		this.awaitingTelegramFinalTurnId = undefined;
		if (this.activeTelegramTurn) this.rememberDisconnectedTurn(this.activeTelegramTurn.turnId);
		for (const turn of this.queuedTelegramTurns) this.rememberDisconnectedTurn(turn.turnId);
		for (const turn of this.manualCompactionQueue.clearPendingRemainder()) this.rememberDisconnectedTurn(turn.turnId);
		this.manualCompactionQueue.reset();
		shutdownTelegramClientRoute({
			setQueuedTelegramTurns: (turns) => { this.queuedTelegramTurns = turns; },
			setActiveTelegramTurn: (turn) => { this.activeTelegramTurn = turn; },
			setConnectedRoute: (route) => { this.connectedRoute = route; },
			clearAssistantFinalHandoff: () => this.deps.assistantFinalHandoff.clearQueue(),
		});
	}

	async shutdownClientRoute(): Promise<void> {
		let clearAssistantFinalQueue = true;
		try {
			if (this.deps.activeTurnFinalizer.hasDeferredTurn()) await this.deps.activeTurnFinalizer.releaseDeferredTurn({ markCompleted: false, startNext: false, deliverAbortedFinal: true, requireDelivery: true });
			await this.deps.assistantFinalHandoff.handoffPendingForShutdown();
			if (this.activeTelegramTurn) {
				try {
					await this.deps.clearAssistantPreviewInBroker(this.activeTelegramTurn.turnId, this.activeTelegramTurn.chatId, this.activeTelegramTurn.messageThreadId, false);
				} catch {
					await this.deps.assistantFinalHandoff.enqueueAbortedFinal(this.activeTelegramTurn);
				}
			}
		} catch (error) {
			clearAssistantFinalQueue = false;
			throw error;
		} finally {
			this.deps.activeTurnFinalizer.cancel();
			this.currentAbort = undefined;
			this.awaitingTelegramFinalTurnId = undefined;
			if (this.activeTelegramTurn) this.rememberDisconnectedTurn(this.activeTelegramTurn.turnId);
			for (const turn of this.queuedTelegramTurns) this.rememberDisconnectedTurn(turn.turnId);
			for (const turn of this.manualCompactionQueue.clearPendingRemainder()) this.rememberDisconnectedTurn(turn.turnId);
			this.manualCompactionQueue.reset();
			shutdownTelegramClientRoute({
				setQueuedTelegramTurns: (turns) => { this.queuedTelegramTurns = turns; },
				setActiveTelegramTurn: (turn) => { this.activeTelegramTurn = turn; },
				setConnectedRoute: (route) => { this.connectedRoute = route; },
				clearAssistantFinalHandoff: () => this.deps.assistantFinalHandoff.clearQueue(),
				clearAssistantFinalQueue,
			});
		}
	}

	async handleClientIpc(envelope: IpcEnvelope): Promise<unknown> {
		if (envelope.type === "deliver_turn") return await this.clientDeliverTurn(envelope.payload as PendingTelegramTurn);
		if (envelope.type === "convert_queued_turn_to_steer") return await this.clientConvertQueuedTurnToSteer(envelope.payload as ConvertQueuedTurnToSteerRequest);
		if (envelope.type === "cancel_queued_turn") return await this.clientCancelQueuedTurn(envelope.payload as CancelQueuedTurnRequest);
		if (envelope.type === "abort_turn") return await this.clientAbortTurn();
		if (envelope.type === "stale_client_connection") {
			const payload = envelope.payload as { connectionNonce?: string };
			if (!payload.connectionNonce || payload.connectionNonce !== this.clientConnectionNonce) return { ok: true, ignored: true };
			setTimeout(() => {
				void this.standDownStaleClientConnection({ acknowledgeBroker: true }).catch((error) => {
					console.warn(`[pi-telegram] Failed to stand down stale client connection: ${errorMessage(error)}`);
				});
			}, 0);
			return { ok: true };
		}
		if (envelope.type === "restore_deferred_final") {
			this.deps.assistantFinalHandoff.clearPersistedDeferredPayload();
			this.deps.activeTurnFinalizer.restoreDeferredPayload(envelope.payload as AssistantFinalPayload);
			await this.deps.assistantFinalHandoff.persistRestoredDeferredStateWhileBrokerHoldsLock(this.deps.getSessionId());
			return { ok: true };
		}
		if (envelope.type === "query_status") return { text: await this.clientStatusText() };
		if (envelope.type === "compact_session") return this.clientCompact();
		if (envelope.type === "query_models") return this.clientQueryModels((envelope.payload as { filter?: string }).filter);
		if (envelope.type === "query_git_repository") return await this.clientQueryGitRepository(envelope.payload as ClientGitRepositoryQueryRequest);
		if (envelope.type === "set_model") {
			const payload = envelope.payload as { selector: string; exact?: boolean };
			return await this.clientSetModel(payload.selector, payload.exact);
		}
		if (envelope.type === "shutdown_client_route") {
			await this.shutdownClientRoute();
			setTimeout(() => {
				void this.stopClientServer().catch((error) => {
					console.warn(`[pi-telegram] Failed to stop client server after route shutdown: ${errorMessage(error)}`);
				});
			}, 0);
			return { ok: true };
		}
		throw new Error(`Unsupported client IPC message: ${envelope.type}`);
	}

	rememberCompletedLocalTurn(turnId: string): void {
		this.clientRuntime.rememberCompletedLocalTurn(turnId);
	}

	async acknowledgeConsumedTurn(turnId: string, finalizeQueuedControlText?: string): Promise<void> {
		this.rememberCompletedLocalTurn(turnId);
		await this.deps.postIpc(this.deps.getConnectedBrokerSocketPath(), "turn_consumed", { turnId, finalizeQueuedControlText }, this.deps.getSessionId()).catch(() => undefined);
	}

	clientDeliverTurn(turn: PendingTelegramTurn): Promise<ClientDeliverTurnResult> {
		return this.clientRuntime.deliverTurn(turn);
	}

	clientConvertQueuedTurnToSteer(request: ConvertQueuedTurnToSteerRequest): Promise<ConvertQueuedTurnToSteerResult> {
		return this.clientRuntime.convertQueuedTurnToSteer(request);
	}

	clientCancelQueuedTurn(request: CancelQueuedTurnRequest): Promise<CancelQueuedTurnResult> {
		return this.clientRuntime.cancelQueuedTurn(request);
	}

	clientAbortTurn(): Promise<{ text: string; clearedTurnIds: string[] }> {
		return this.clientRuntime.abortTurn();
	}

	startNextTelegramTurn(): void {
		if (this.manualCompactionQueue.isActive() || this.activeTelegramTurn || this.awaitingTelegramFinalTurnId || !this.connectedRoute || !this.clientServer) return;
		const turn = this.queuedTelegramTurns.shift();
		if (!turn) return;
		const activeTurn = { ...turn, queuedAttachments: [] };
		const previousAbort = this.currentAbort;
		this.activeTelegramTurn = activeTurn;
		const ctx = this.deps.getLatestCtx();
		if (ctx) this.currentAbort = () => ctx.abort();
		try {
			this.deps.pi.sendUserMessage(turn.content, turn.deliveryMode === "followUp" ? { deliverAs: "followUp" } : undefined);
		} catch (error) {
			if (this.activeTelegramTurn?.turnId === turn.turnId) this.activeTelegramTurn = undefined;
			this.currentAbort = previousAbort;
			this.queuedTelegramTurns.unshift(turn);
			throw error;
		}
		void this.deps.postIpc(this.deps.getConnectedBrokerSocketPath(), "turn_started", { turnId: turn.turnId }, this.deps.getSessionId()).catch(() => undefined);
	}

	clientStatusText(): Promise<string> {
		return this.clientRuntime.statusText(this.deps.pi.getSessionName() ?? "pi session");
	}

	clientCompact(): { text: string } {
		return this.clientRuntime.compact();
	}

	clientQueryModels(filter?: string): { current?: string; models: ModelSummary[] } {
		return this.clientRuntime.queryModels(filter);
	}

	clientQueryGitRepository(request: ClientGitRepositoryQueryRequest): Promise<ClientGitRepositoryQueryResult> {
		return this.clientRuntime.queryGitRepository(request);
	}

	clientSetModel(selector: string, exact?: boolean): Promise<{ text: string }> {
		return this.clientRuntime.setModel(selector, exact);
	}

	private rememberDisconnectedTurn(turnId: string): void {
		this.disconnectedTurnIds.add(turnId);
		if (this.disconnectedTurnIds.size > 1000) {
			const oldestTurnId = this.disconnectedTurnIds.values().next().value;
			if (oldestTurnId) this.disconnectedTurnIds.delete(oldestTurnId);
		}
	}
}
