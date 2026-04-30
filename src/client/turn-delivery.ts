import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { ActiveTelegramTurn, AssistantFinalPayload, ClientDeliverTurnResult, PendingTelegramTurn } from "../shared/types.js";
import { ClientTelegramTurnLifecycle } from "./turn-lifecycle.js";

export interface ClientDeliverTurnOptions {
	turn: PendingTelegramTurn;
	turnLifecycle?: ClientTelegramTurnLifecycle;
	completedTurnIds?: ReadonlySet<string>;
	queuedTelegramTurns?: PendingTelegramTurn[];
	getActiveTelegramTurn?: () => ActiveTelegramTurn | undefined;
	isManualCompactionInProgress?: () => boolean;
	hasDeferredCompactionTurn?: (turnId: string) => boolean;
	enqueueDeferredCompactionTurn?: (turn: PendingTelegramTurn) => boolean;
	getCtx: () => ExtensionContext | undefined;
	findPendingFinal: (turnId: string) => AssistantFinalPayload | undefined;
	sendAssistantFinalToBroker: (payload: AssistantFinalPayload) => Promise<boolean>;
	acknowledgeConsumedTurn: (turnId: string) => Promise<void>;
	ensureCurrentTurnMirroredToTelegram: (ctx: ExtensionContext | undefined, historyText: string) => void;
	sendUserMessage: (content: PendingTelegramTurn["content"], options?: { deliverAs: "steer" }) => void;
	startNextTelegramTurn: () => void;
}

function syncLegacyActiveTurn(options: ClientDeliverTurnOptions, lifecycle: ClientTelegramTurnLifecycle): void {
	if (options.turnLifecycle) return;
	const activeTurn = options.getActiveTelegramTurn?.();
	if (activeTurn) lifecycle.restoreActiveTurn(activeTurn);
}

function lifecycleFromOptions(options: ClientDeliverTurnOptions): ClientTelegramTurnLifecycle {
	if (options.turnLifecycle) return options.turnLifecycle;
	const lifecycle = new ClientTelegramTurnLifecycle({
		getSessionId: () => options.turn.sessionId,
		getLatestCtx: options.getCtx,
		getConnectedRoute: () => undefined,
		hasClientServer: () => true,
		postTurnStarted: () => undefined,
		sendUserMessage: (content, sendOptions) => options.sendUserMessage(content, sendOptions?.deliverAs === "steer" ? { deliverAs: "steer" } : undefined),
		acknowledgeConsumedTurn: (turnId) => { void options.acknowledgeConsumedTurn(turnId); },
	});
	lifecycle.replaceQueuedTurns(options.queuedTelegramTurns ?? []);
	const activeTurn = options.getActiveTelegramTurn?.();
	if (activeTurn) lifecycle.restoreActiveTurn(activeTurn);
	for (const turnId of options.completedTurnIds ?? []) lifecycle.rememberCompletedTurn(turnId);
	if (options.isManualCompactionInProgress?.()) lifecycle.getManualCompactionQueue().start();
	if (options.hasDeferredCompactionTurn?.(options.turn.turnId)) lifecycle.getManualCompactionQueue().enqueueDeferredTurn(options.turn);
	const originalEnqueueDeferred = options.enqueueDeferredCompactionTurn;
	if (originalEnqueueDeferred) {
		const queue = lifecycle.getManualCompactionQueue();
		const original = queue.enqueueDeferredTurn.bind(queue);
		queue.enqueueDeferredTurn = (turn) => originalEnqueueDeferred(turn) || original(turn);
	}
	return lifecycle;
}

export async function clientDeliverTelegramTurn(options: ClientDeliverTurnOptions): Promise<ClientDeliverTurnResult> {
	const { turn } = options;
	const turnLifecycle = lifecycleFromOptions(options);
	if (turnLifecycle.hasCompletedTurn(turn.turnId)) {
		const pendingFinal = options.findPendingFinal(turn.turnId);
		if (pendingFinal) {
			await options.sendAssistantFinalToBroker(pendingFinal);
			return { accepted: true, disposition: "completed" };
		}
		await options.acknowledgeConsumedTurn(turn.turnId);
		return { accepted: true, disposition: "completed" };
	}
	if (turnLifecycle.hasPendingTurn(turn.turnId) || (!options.turnLifecycle && options.hasDeferredCompactionTurn?.(turn.turnId))) return { accepted: true, disposition: "duplicate" };
	const ctx = options.getCtx();
	const manualCompactionInProgress = turnLifecycle.getManualCompactionQueue().isActive();
	const activePiTurnInProgress = ctx ? !ctx.isIdle() : false;
	if (!manualCompactionInProgress && activePiTurnInProgress && !turnLifecycle.getActiveTurn()) {
		options.ensureCurrentTurnMirroredToTelegram(ctx, "Telegram follow-up message received during an active pi turn; mirroring from this point on.");
		syncLegacyActiveTurn(options, turnLifecycle);
	}
	const activeTurn = turnLifecycle.getActiveTurn();
	const canSteerNow = Boolean(!manualCompactionInProgress && activePiTurnInProgress && activeTurn);
	if (!manualCompactionInProgress && turn.deliveryMode === "steer" && canSteerNow) {
		options.ensureCurrentTurnMirroredToTelegram(ctx, "Telegram steering message received during an active pi turn; mirroring from this point on.");
		syncLegacyActiveTurn(options, turnLifecycle);
		options.sendUserMessage(turn.content, { deliverAs: "steer" });
		await options.acknowledgeConsumedTurn(turn.turnId);
		return { accepted: true, disposition: "steered" };
	}
	if (turnLifecycle.getManualCompactionQueue().enqueueDeferredTurn(turn)) {
		const targetActiveTurn = turnLifecycle.getActiveTurn();
		return { accepted: true, disposition: "queued", queuedControl: { canSteer: Boolean(!manualCompactionInProgress && activePiTurnInProgress && targetActiveTurn), targetActiveTurnId: targetActiveTurn?.turnId } };
	}
	turnLifecycle.queueTurn(turn);
	if (!manualCompactionInProgress && ctx?.isIdle() && !turnLifecycle.getActiveTurn()) {
		options.startNextTelegramTurn();
		return { accepted: true, disposition: "started" };
	}
	const queuedBehindActiveTurn = turnLifecycle.getActiveTurn();
	return { accepted: true, disposition: "queued", queuedControl: { canSteer: Boolean(!manualCompactionInProgress && activePiTurnInProgress && queuedBehindActiveTurn), targetActiveTurnId: queuedBehindActiveTurn?.turnId } };
}
