import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { ActiveTelegramTurn, AssistantFinalPayload, PendingTelegramTurn } from "../shared/types.js";

export interface ClientDeliverTurnOptions {
	turn: PendingTelegramTurn;
	completedTurnIds: ReadonlySet<string>;
	queuedTelegramTurns: PendingTelegramTurn[];
	getActiveTelegramTurn: () => ActiveTelegramTurn | undefined;
	getCtx: () => ExtensionContext | undefined;
	findPendingFinal: (turnId: string) => AssistantFinalPayload | undefined;
	sendAssistantFinalToBroker: (payload: AssistantFinalPayload) => Promise<boolean>;
	acknowledgeConsumedTurn: (turnId: string) => Promise<void>;
	ensureCurrentTurnMirroredToTelegram: (ctx: ExtensionContext | undefined, historyText: string) => void;
	sendUserMessage: (content: PendingTelegramTurn["content"], options?: { deliverAs: "steer" }) => void;
	startNextTelegramTurn: () => void;
}

export async function clientDeliverTelegramTurn(options: ClientDeliverTurnOptions): Promise<{ accepted: true }> {
	const { turn } = options;
	if (options.completedTurnIds.has(turn.turnId)) {
		const pendingFinal = options.findPendingFinal(turn.turnId);
		if (pendingFinal) {
			await options.sendAssistantFinalToBroker(pendingFinal);
			return { accepted: true };
		}
		await options.acknowledgeConsumedTurn(turn.turnId);
		return { accepted: true };
	}
	if (options.getActiveTelegramTurn()?.turnId === turn.turnId || options.queuedTelegramTurns.some((candidate) => candidate.turnId === turn.turnId)) return { accepted: true };
	const ctx = options.getCtx();
	const isBusy = ctx ? !ctx.isIdle() : Boolean(options.getActiveTelegramTurn());
	if (isBusy && turn.deliveryMode !== "followUp") {
		options.ensureCurrentTurnMirroredToTelegram(ctx, "Telegram steering message received during an active pi turn; mirroring from this point on.");
		options.sendUserMessage(turn.content, { deliverAs: "steer" });
		await options.acknowledgeConsumedTurn(turn.turnId);
		return { accepted: true };
	}
	options.queuedTelegramTurns.push(turn);
	if (ctx?.isIdle()) options.startNextTelegramTurn();
	return { accepted: true };
}
