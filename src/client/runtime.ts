import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ActiveTelegramTurn, AssistantFinalPayload, BrokerLease, ModelSummary, PendingTelegramTurn, TelegramRoute } from "../shared/types.js";
import { errorMessage, randomId } from "../shared/utils.js";
import { clientAbortTelegramTurn } from "./abort-turn.js";
import { clientCompactSession } from "./compact.js";
import { clientQueryModels as buildClientQueryModels, clientSetModel as setClientModel, clientStatusText as buildClientStatusText } from "./info.js";
import { clientDeliverTelegramTurn } from "./turn-delivery.js";

export interface ClientRuntimeDeps {
	pi: ExtensionAPI;
	completedTurnIds: Set<string>;
	getSessionId: () => string;
	getLatestCtx: () => ExtensionContext | undefined;
	getConnectedRoute: () => TelegramRoute | undefined;
	isRoutableRoute: (route: TelegramRoute | undefined) => route is TelegramRoute;
	getActiveTelegramTurn: () => ActiveTelegramTurn | undefined;
	setActiveTelegramTurn: (turn: ActiveTelegramTurn | undefined) => void;
	getQueuedTelegramTurns: () => PendingTelegramTurn[];
	getCurrentAbort: () => (() => void) | undefined;
	setCurrentAbort: (abort: (() => void) | undefined) => void;
	getManualCompactionQueue: () => {
		isActive(): boolean;
		hasDeferredTurn(turnId: string): boolean;
		enqueueDeferredTurn(turn: PendingTelegramTurn): boolean;
		peekPendingRemainder(): PendingTelegramTurn[];
		clearPendingRemainder(): PendingTelegramTurn[];
		cancelDeferredStart(): void;
		start(): void;
		finish(): void;
	};
	activeTurnFinalizer: {
		hasDeferredTurn(turnId?: string): boolean;
		releaseDeferredTurn(options?: { markCompleted?: boolean; startNext?: boolean; deliverAbortedFinal?: boolean; requireDelivery?: boolean }): Promise<string | undefined>;
		restoreDeferredPayload(payload: AssistantFinalPayload): void;
	};
	findPendingFinal: (turnId: string) => AssistantFinalPayload | undefined;
	sendAssistantFinalToBroker: (payload: AssistantFinalPayload) => Promise<boolean>;
	acknowledgeConsumedTurn: (turnId: string) => Promise<void>;
	ensureCurrentTurnMirroredToTelegram: (ctx: ExtensionContext | undefined, historyText: string) => void;
	startNextTelegramTurn: () => void;
	readLease: () => Promise<BrokerLease | undefined>;
	updateStatus: (ctx: ExtensionContext, detail?: string) => void;
}

export class ClientRuntime {
	constructor(private readonly deps: ClientRuntimeDeps) {}

	rememberCompletedLocalTurn(turnId: string): void {
		this.deps.completedTurnIds.add(turnId);
		if (this.deps.completedTurnIds.size > 1000) {
			const oldestTurnId = this.deps.completedTurnIds.values().next().value;
			if (oldestTurnId) this.deps.completedTurnIds.delete(oldestTurnId);
		}
	}

	deliverTurn(turn: PendingTelegramTurn): Promise<{ accepted: true }> {
		return clientDeliverTelegramTurn({
			turn,
			completedTurnIds: this.deps.completedTurnIds,
			queuedTelegramTurns: this.deps.getQueuedTelegramTurns(),
			getActiveTelegramTurn: this.deps.getActiveTelegramTurn,
			getCtx: this.deps.getLatestCtx,
			isManualCompactionInProgress: () => this.deps.getManualCompactionQueue().isActive(),
			hasDeferredCompactionTurn: (turnId) => this.deps.getManualCompactionQueue().hasDeferredTurn(turnId),
			enqueueDeferredCompactionTurn: (deferredTurn) => this.deps.getManualCompactionQueue().enqueueDeferredTurn(deferredTurn),
			findPendingFinal: this.deps.findPendingFinal,
			sendAssistantFinalToBroker: this.deps.sendAssistantFinalToBroker,
			acknowledgeConsumedTurn: this.deps.acknowledgeConsumedTurn,
			ensureCurrentTurnMirroredToTelegram: this.deps.ensureCurrentTurnMirroredToTelegram,
			sendUserMessage: (content, options) => { void this.deps.pi.sendUserMessage(content, options); },
			startNextTelegramTurn: this.deps.startNextTelegramTurn,
		});
	}

	abortTurn(): Promise<{ text: string; clearedTurnIds: string[] }> {
		const ctx = this.deps.getLatestCtx();
		const activeTurn = this.deps.getActiveTelegramTurn();
		const fallbackAbort = ctx && activeTurn && !this.deps.activeTurnFinalizer.hasDeferredTurn(activeTurn.turnId) ? () => ctx.abort() : undefined;
		return clientAbortTelegramTurn({
			queuedTelegramTurns: this.deps.getQueuedTelegramTurns(),
			peekManualCompactionRemainder: () => this.deps.getManualCompactionQueue().peekPendingRemainder(),
			clearManualCompactionRemainder: () => this.deps.getManualCompactionQueue().clearPendingRemainder(),
			cancelDeferredCompactionStart: () => this.deps.getManualCompactionQueue().cancelDeferredStart(),
			getActiveTelegramTurn: this.deps.getActiveTelegramTurn,
			getAbortActiveTurn: () => this.deps.getCurrentAbort() ?? fallbackAbort,
			releaseDeferredTurn: (options) => this.deps.activeTurnFinalizer.releaseDeferredTurn(options),
			rememberCompletedLocalTurn: (turnId) => this.rememberCompletedLocalTurn(turnId),
		});
	}

	async statusText(sessionName: string): Promise<string> {
		return buildClientStatusText({
			ctx: this.deps.getLatestCtx(),
			connectedRoute: this.deps.getConnectedRoute(),
			sessionName,
			lease: await this.deps.readLease(),
			activeTelegramTurn: this.deps.getActiveTelegramTurn(),
			queuedTurnCount: this.deps.getQueuedTelegramTurns().length,
			manualCompactionInProgress: this.deps.getManualCompactionQueue().isActive(),
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
				this.deps.getManualCompactionQueue().start();
				const ctx = this.deps.getLatestCtx();
				if (ctx) this.deps.updateStatus(ctx);
			},
			onSettled: () => {
				this.deps.getManualCompactionQueue().finish();
				const ctx = onSettledStatus ?? this.deps.getLatestCtx();
				if (ctx) this.deps.updateStatus(ctx);
			},
		});
	}

	queryModels(filter?: string): { current?: string; models: ModelSummary[] } {
		return buildClientQueryModels(this.deps.getLatestCtx(), filter);
	}

	setModel(selector: string, exact?: boolean): Promise<{ text: string }> {
		return setClientModel(this.deps.getLatestCtx(), (model) => this.deps.pi.setModel(model), selector, { exact });
	}
}
