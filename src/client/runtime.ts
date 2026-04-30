import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { QUEUED_CONTROL_TEXT } from "../shared/queued-control-text.js";
import type { ActiveTelegramTurn, AssistantFinalPayload, BrokerLease, CancelQueuedTurnRequest, CancelQueuedTurnResult, ClientGitRepositoryQueryRequest, ClientGitRepositoryQueryResult, ConvertQueuedTurnToSteerRequest, ConvertQueuedTurnToSteerResult, ClientDeliverTurnResult, ModelSummary, PendingTelegramTurn, TelegramRoute } from "../shared/types.js";
import { errorMessage, randomId } from "../shared/utils.js";
import { clientAbortTelegramTurn } from "./abort-turn.js";
import { clientCompactSession } from "./compact.js";
import { clientQueryGitRepository as buildClientQueryGitRepository } from "./git-status.js";
import { clientQueryModels as buildClientQueryModels, clientSetModel as setClientModel, clientStatusText as buildClientStatusText } from "./info.js";
import { clientDeliverTelegramTurn } from "./turn-delivery.js";
import { ClientTelegramTurnLifecycle } from "./turn-lifecycle.js";

export interface ClientRuntimeDeps {
	pi: ExtensionAPI;
	turnLifecycle?: ClientTelegramTurnLifecycle;
	completedTurnIds?: Set<string>;
	getActiveTelegramTurn?: () => ActiveTelegramTurn | undefined;
	setActiveTelegramTurn?: (turn: ActiveTelegramTurn | undefined) => void;
	getQueuedTelegramTurns?: () => PendingTelegramTurn[];
	getCurrentAbort?: () => (() => void) | undefined;
	setCurrentAbort?: (abort: (() => void) | undefined) => void;
	getManualCompactionQueue?: () => {
		isActive(): boolean;
		hasDeferredTurn(turnId: string): boolean;
		enqueueDeferredTurn(turn: PendingTelegramTurn): boolean;
		peekPendingRemainder(): PendingTelegramTurn[];
		clearPendingRemainder(): PendingTelegramTurn[];
		removeDeferredTurn(turnId: string): PendingTelegramTurn | undefined;
		cancelDeferredStart(): void;
		start(): void;
		finish(): void;
	};
	getSessionId: () => string;
	getLatestCtx: () => ExtensionContext | undefined;
	getConnectedRoute: () => TelegramRoute | undefined;
	isRoutableRoute: (route: TelegramRoute | undefined) => route is TelegramRoute;
	activeTurnFinalizer: {
		hasDeferredTurn(turnId?: string): boolean;
		releaseDeferredTurn(options?: { markCompleted?: boolean; startNext?: boolean; deliverAbortedFinal?: boolean; requireDelivery?: boolean }): Promise<string | undefined>;
		restoreDeferredPayload(payload: AssistantFinalPayload): void;
	};
	findPendingFinal: (turnId: string) => AssistantFinalPayload | undefined;
	sendAssistantFinalToBroker: (payload: AssistantFinalPayload) => Promise<boolean>;
	acknowledgeConsumedTurn: (turnId: string, finalizeQueuedControlText?: string) => Promise<void>;
	ensureCurrentTurnMirroredToTelegram: (ctx: ExtensionContext | undefined, historyText: string) => void;
	startNextTelegramTurn: () => void;
	readLease: () => Promise<BrokerLease | undefined>;
	updateStatus: (ctx: ExtensionContext, detail?: string) => void;
}

export class ClientRuntime {
	private readonly turnLifecycle: ClientTelegramTurnLifecycle;

	constructor(private readonly deps: ClientRuntimeDeps) {
		this.turnLifecycle = deps.turnLifecycle ?? this.createLegacyLifecycle(deps);
	}

	rememberCompletedLocalTurn(turnId: string): void {
		this.turnLifecycle.rememberCompletedTurn(turnId);
		this.deps.completedTurnIds?.add(turnId);
	}

	private syncLegacyLifecycleFromDeps(): void {
		if (this.deps.turnLifecycle) return;
		if (this.deps.getQueuedTelegramTurns) this.turnLifecycle.replaceQueuedTurns(this.deps.getQueuedTelegramTurns());
		if (this.deps.completedTurnIds) this.turnLifecycle.replaceCompletedTurns(this.deps.completedTurnIds);
		this.turnLifecycle.restoreActiveTurn(this.deps.getActiveTelegramTurn?.());
		this.turnLifecycle.setCurrentAbort(this.deps.getCurrentAbort?.());
	}

	private createLegacyLifecycle(deps: ClientRuntimeDeps): ClientTelegramTurnLifecycle {
		const lifecycle = new ClientTelegramTurnLifecycle({

			getSessionId: deps.getSessionId,
			getLatestCtx: deps.getLatestCtx,
			getConnectedRoute: deps.getConnectedRoute,
			hasClientServer: () => true,
			postTurnStarted: () => undefined,
			sendUserMessage: (content, options) => { void deps.pi.sendUserMessage(content, options); },
			acknowledgeConsumedTurn: (turnId, text) => { void deps.acknowledgeConsumedTurn(turnId, text); },
		});
		lifecycle.replaceQueuedTurns(deps.getQueuedTelegramTurns?.() ?? []);
		const activeTurn = deps.getActiveTelegramTurn?.();
		if (activeTurn) lifecycle.restoreActiveTurn(activeTurn);
		for (const turnId of deps.completedTurnIds ?? []) lifecycle.rememberCompletedTurn(turnId);
		const manualQueue = deps.getManualCompactionQueue?.();
		if (manualQueue) {
			const lifecycleManualQueue = lifecycle.getManualCompactionQueue();
			lifecycleManualQueue.isActive = manualQueue.isActive.bind(manualQueue);
			lifecycleManualQueue.removeDeferredTurn = manualQueue.removeDeferredTurn.bind(manualQueue);
			lifecycleManualQueue.hasDeferredTurn = manualQueue.hasDeferredTurn.bind(manualQueue);
			lifecycleManualQueue.enqueueDeferredTurn = manualQueue.enqueueDeferredTurn.bind(manualQueue);
			lifecycleManualQueue.peekPendingRemainder = manualQueue.peekPendingRemainder.bind(manualQueue);
			lifecycleManualQueue.clearPendingRemainder = manualQueue.clearPendingRemainder.bind(manualQueue);
			lifecycleManualQueue.cancelDeferredStart = manualQueue.cancelDeferredStart.bind(manualQueue);
			lifecycleManualQueue.start = manualQueue.start.bind(manualQueue);
			lifecycleManualQueue.finish = manualQueue.finish.bind(manualQueue);
		}
		const originalRestoreActive = lifecycle.restoreActiveTurn.bind(lifecycle);
		lifecycle.restoreActiveTurn = (turn) => {
			originalRestoreActive(turn);
			deps.setActiveTelegramTurn?.(turn);
		};
		const originalSetAbort = lifecycle.setCurrentAbort.bind(lifecycle);
		lifecycle.setCurrentAbort = (abort) => {
			originalSetAbort(abort);
			deps.setCurrentAbort?.(abort);
		};
		return lifecycle;
	}

	deliverTurn(turn: PendingTelegramTurn): Promise<ClientDeliverTurnResult> {
		this.syncLegacyLifecycleFromDeps();
		return clientDeliverTelegramTurn({
			turn,
			turnLifecycle: this.turnLifecycle,
			getCtx: this.deps.getLatestCtx,
			findPendingFinal: this.deps.findPendingFinal,
			sendAssistantFinalToBroker: this.deps.sendAssistantFinalToBroker,
			acknowledgeConsumedTurn: this.deps.acknowledgeConsumedTurn,
			ensureCurrentTurnMirroredToTelegram: (ctx, historyText) => {
				this.deps.ensureCurrentTurnMirroredToTelegram(ctx, historyText);
				if (!this.deps.turnLifecycle) {
					const activeTurn = this.deps.getActiveTelegramTurn?.();
					if (activeTurn) this.turnLifecycle.restoreActiveTurn(activeTurn);
				}
			},
			sendUserMessage: (content, options) => { void this.deps.pi.sendUserMessage(content, options); },
			startNextTelegramTurn: this.deps.startNextTelegramTurn,
		});
	}

	async convertQueuedTurnToSteer(request: ConvertQueuedTurnToSteerRequest): Promise<ConvertQueuedTurnToSteerResult> {
		this.syncLegacyLifecycleFromDeps();
		if (this.turnLifecycle.hasCompletedTurn(request.turnId)) return { status: "already_handled", text: "This queued follow-up was already handled.", turnId: request.turnId };
		const activeTurn = this.turnLifecycle.getActiveTurn();
		const ctx = this.deps.getLatestCtx();
		if (!activeTurn || !ctx || ctx.isIdle()) return { status: "stale", text: "There is no active turn to steer anymore.", turnId: request.turnId };
		if (request.targetActiveTurnId && activeTurn.turnId !== request.targetActiveTurnId) return { status: "stale", text: "That queued follow-up no longer targets the active turn.", turnId: request.turnId };
		const taken = this.turnLifecycle.takeQueuedOrDeferredTurn(request.turnId);
		if (!taken) return { status: "not_found", text: "That queued follow-up is no longer waiting.", turnId: request.turnId };
		try {
			this.deps.pi.sendUserMessage(taken.turn.content, { deliverAs: "steer" });
		} catch (error) {
			this.turnLifecycle.restoreTakenQueuedOrDeferredTurn(taken);
			throw error;
		}
		await this.deps.acknowledgeConsumedTurn(taken.turn.turnId, QUEUED_CONTROL_TEXT.steered);
		this.turnLifecycle.rememberCompletedTurn(taken.turn.turnId);
		return { status: "converted", text: QUEUED_CONTROL_TEXT.steered, turnId: taken.turn.turnId };
	}

	async cancelQueuedTurn(request: CancelQueuedTurnRequest): Promise<CancelQueuedTurnResult> {
		this.syncLegacyLifecycleFromDeps();
		if (this.turnLifecycle.hasCompletedTurn(request.turnId)) return { status: "already_handled", text: "This queued follow-up was already handled.", turnId: request.turnId };
		if (this.turnLifecycle.getActiveTurn()?.turnId === request.turnId) return { status: "stale", text: "That follow-up has already started.", turnId: request.turnId };
		const taken = this.turnLifecycle.takeQueuedOrDeferredTurn(request.turnId);
		if (!taken) return { status: "not_found", text: "That queued follow-up is no longer waiting.", turnId: request.turnId };
		await this.deps.acknowledgeConsumedTurn(taken.turn.turnId, QUEUED_CONTROL_TEXT.cancelled);
		this.turnLifecycle.rememberCompletedTurn(taken.turn.turnId);
		this.deps.startNextTelegramTurn();
		return { status: "cancelled", text: QUEUED_CONTROL_TEXT.cancelled, turnId: taken.turn.turnId };
	}

	abortTurn(): Promise<{ text: string; clearedTurnIds: string[] }> {
		this.syncLegacyLifecycleFromDeps();
		const ctx = this.deps.getLatestCtx();
		const activeTurn = this.turnLifecycle.getActiveTurn();
		const fallbackAbort = ctx && activeTurn && !this.deps.activeTurnFinalizer.hasDeferredTurn(activeTurn.turnId) ? () => ctx.abort() : undefined;
		return clientAbortTelegramTurn({
			turnLifecycle: this.turnLifecycle,
			getAbortActiveTurn: () => this.turnLifecycle.getCurrentAbort() ?? fallbackAbort,
			releaseDeferredTurn: (options) => this.deps.activeTurnFinalizer.releaseDeferredTurn(options),
		});
	}

	async statusText(sessionName: string): Promise<string> {
		this.syncLegacyLifecycleFromDeps();
		return buildClientStatusText({
			ctx: this.deps.getLatestCtx(),
			connectedRoute: this.deps.getConnectedRoute(),
			sessionName,
			lease: await this.deps.readLease(),
			activeTelegramTurn: this.turnLifecycle.getActiveTurn(),
			queuedTurnCount: this.turnLifecycle.queuedTurnCount(),
			manualCompactionInProgress: this.turnLifecycle.getManualCompactionQueue().isActive(),
		});
	}

	compact(onSettledStatus?: ExtensionContext): { text: string } {
		return clientCompactSession({
			ctx: this.deps.getLatestCtx(),
			sessionId: this.deps.getSessionId(),
			getConnectedRoute: this.deps.getConnectedRoute,
			isRoutableRoute: this.deps.isRoutableRoute,
			sendAssistantFinalToBroker: this.deps.sendAssistantFinalToBroker,
			createTurnId: () => randomId("cmd"),
			formatError: errorMessage,
			onStart: () => {
				this.turnLifecycle.getManualCompactionQueue().start();
				const ctx = this.deps.getLatestCtx();
				if (ctx) this.deps.updateStatus(ctx);
			},
			onSettled: () => {
				this.turnLifecycle.getManualCompactionQueue().finish();
				const ctx = onSettledStatus ?? this.deps.getLatestCtx();
				if (ctx) this.deps.updateStatus(ctx);
			},
		});
	}

	queryModels(filter?: string): { current?: string; models: ModelSummary[] } {
		return buildClientQueryModels(this.deps.getLatestCtx(), filter);
	}

	queryGitRepository(request: ClientGitRepositoryQueryRequest): Promise<ClientGitRepositoryQueryResult> {
		return buildClientQueryGitRepository(this.deps.getLatestCtx(), request);
	}

	setModel(selector: string, exact?: boolean): Promise<{ text: string }> {
		return setClientModel(this.deps.getLatestCtx(), (model) => this.deps.pi.setModel(model), selector, { exact });
	}
}
