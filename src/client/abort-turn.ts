import type { ActiveTelegramTurn, PendingTelegramTurn } from "../shared/types.js";

export interface ClientAbortTurnOptions {
	queuedTelegramTurns: PendingTelegramTurn[];
	peekManualCompactionRemainder: () => PendingTelegramTurn[];
	clearManualCompactionRemainder: () => PendingTelegramTurn[];
	cancelDeferredCompactionStart: () => void;
	getActiveTelegramTurn: () => ActiveTelegramTurn | undefined;
	getAbortActiveTurn: () => (() => void) | undefined;
	releaseDeferredTurn: (options?: { markCompleted?: boolean; startNext?: boolean; deliverAbortedFinal?: boolean; requireDelivery?: boolean }) => Promise<string | undefined>;
	rememberCompletedLocalTurn: (turnId: string) => void;
}

export async function clientAbortTelegramTurn(options: ClientAbortTurnOptions): Promise<{ text: string; clearedTurnIds: string[] }> {
	const queuedTurnIds = [
		...options.queuedTelegramTurns.map((turn) => turn.turnId),
		...options.peekManualCompactionRemainder().map((turn) => turn.turnId),
	];
	const queuedCount = queuedTurnIds.length;

	const activeTurnId = options.getActiveTelegramTurn()?.turnId;
	const releasedDeferredTurnId = await options.releaseDeferredTurn({ markCompleted: true, startNext: false, deliverAbortedFinal: true });
	const clearedTurnIds = [...queuedTurnIds];
	if (releasedDeferredTurnId) clearedTurnIds.push(releasedDeferredTurnId);
	options.queuedTelegramTurns.length = 0;
	options.clearManualCompactionRemainder();
	options.cancelDeferredCompactionStart();
	for (const turnId of queuedTurnIds) options.rememberCompletedLocalTurn(turnId);

	const abortActiveTurn = activeTurnId || releasedDeferredTurnId ? options.getAbortActiveTurn() : undefined;
	if (abortActiveTurn) {
		if (activeTurnId && activeTurnId !== releasedDeferredTurnId) {
			options.rememberCompletedLocalTurn(activeTurnId);
			clearedTurnIds.push(activeTurnId);
		}
		abortActiveTurn();
		return {
			text: queuedCount > 0 ? `Aborted current turn and suppressed ${queuedCount} queued turn(s).` : "Aborted current turn.",
			clearedTurnIds,
		};
	}

	if (releasedDeferredTurnId) {
		return {
			text: queuedCount > 0 ? `Stopped waiting for retry and suppressed ${queuedCount} queued turn(s).` : "Stopped waiting for retry.",
			clearedTurnIds,
		};
	}

	return {
		text: queuedCount > 0 ? `Suppressed ${queuedCount} queued turn(s).` : "No active turn.",
		clearedTurnIds,
	};
}
