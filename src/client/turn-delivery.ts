import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { ActiveTelegramTurn, AssistantFinalPayload, ClientDeliverTurnResult, PendingTelegramTurn } from "../shared/types.js";

export interface ClientDeliverTurnOptions {
	turn: PendingTelegramTurn;
	completedTurnIds: ReadonlySet<string>;
	queuedTelegramTurns: PendingTelegramTurn[];
	getActiveTelegramTurn: () => ActiveTelegramTurn | undefined;
	getCtx: () => ExtensionContext | undefined;
	isManualCompactionInProgress: () => boolean;
	hasDeferredCompactionTurn: (turnId: string) => boolean;
	enqueueDeferredCompactionTurn: (turn: PendingTelegramTurn) => boolean;
	findPendingFinal: (turnId: string) => AssistantFinalPayload | undefined;
	sendAssistantFinalToBroker: (payload: AssistantFinalPayload) => Promise<boolean>;
	acknowledgeConsumedTurn: (turnId: string) => Promise<void>;
	ensureCurrentTurnMirroredToTelegram: (ctx: ExtensionContext | undefined, historyText: string) => void;
	sendUserMessage: (content: PendingTelegramTurn["content"], options?: { deliverAs: "steer" }) => void;
	startNextTelegramTurn: () => void;
}

export async function clientDeliverTelegramTurn(options: ClientDeliverTurnOptions): Promise<ClientDeliverTurnResult> {
	const { turn } = options;
	if (options.completedTurnIds.has(turn.turnId)) {
		const pendingFinal = options.findPendingFinal(turn.turnId);
		if (pendingFinal) {
			await options.sendAssistantFinalToBroker(pendingFinal);
			return { accepted: true, disposition: "completed" };
		}
		await options.acknowledgeConsumedTurn(turn.turnId);
		return { accepted: true, disposition: "completed" };
	}
	if (
		options.getActiveTelegramTurn()?.turnId === turn.turnId ||
		options.queuedTelegramTurns.some((candidate) => candidate.turnId === turn.turnId) ||
		options.hasDeferredCompactionTurn(turn.turnId)
	) return { accepted: true, disposition: "duplicate" };
	const ctx = options.getCtx();
	const manualCompactionInProgress = options.isManualCompactionInProgress();
	const activePiTurnInProgress = ctx ? !ctx.isIdle() : false;
	if (!manualCompactionInProgress && activePiTurnInProgress && !options.getActiveTelegramTurn()) {
		options.ensureCurrentTurnMirroredToTelegram(ctx, "Telegram follow-up message received during an active pi turn; mirroring from this point on.");
	}
	const activeTurn = options.getActiveTelegramTurn();
	const canSteerNow = Boolean(!manualCompactionInProgress && activePiTurnInProgress && activeTurn);
	if (!manualCompactionInProgress && turn.deliveryMode === "steer" && canSteerNow) {
		options.ensureCurrentTurnMirroredToTelegram(ctx, "Telegram steering message received during an active pi turn; mirroring from this point on.");
		options.sendUserMessage(turn.content, { deliverAs: "steer" });
		await options.acknowledgeConsumedTurn(turn.turnId);
		return { accepted: true, disposition: "steered" };
	}
	if (options.enqueueDeferredCompactionTurn(turn)) {
		const targetActiveTurn = options.getActiveTelegramTurn();
		return { accepted: true, disposition: "queued", queuedControl: { canSteer: Boolean(!manualCompactionInProgress && activePiTurnInProgress && targetActiveTurn), targetActiveTurnId: targetActiveTurn?.turnId } };
	}
	options.queuedTelegramTurns.push(turn);
	if (!manualCompactionInProgress && ctx?.isIdle() && !options.getActiveTelegramTurn()) {
		options.startNextTelegramTurn();
		return { accepted: true, disposition: "started" };
	}
	const queuedBehindActiveTurn = options.getActiveTelegramTurn();
	return { accepted: true, disposition: "queued", queuedControl: { canSteer: Boolean(!manualCompactionInProgress && activePiTurnInProgress && queuedBehindActiveTurn), targetActiveTurnId: queuedBehindActiveTurn?.turnId } };
}
