import type { ActiveTelegramTurn, PendingTelegramTurn } from "./types.js";
import { ClientTelegramTurnLifecycle } from "./turn-lifecycle.js";

export interface ClientAbortTurnOptions {
	turnLifecycle?: ClientTelegramTurnLifecycle;
	queuedTelegramTurns?: PendingTelegramTurn[];
	peekManualCompactionRemainder?: () => PendingTelegramTurn[];
	clearManualCompactionRemainder?: () => PendingTelegramTurn[];
	cancelDeferredCompactionStart?: () => void;
	getActiveTelegramTurn?: () => ActiveTelegramTurn | undefined;
	getAbortActiveTurn: () => (() => void) | undefined;
	releaseDeferredTurn: (options?: { markCompleted?: boolean; startNext?: boolean; deliverAbortedFinal?: boolean; requireDelivery?: boolean }) => Promise<string | undefined>;
	rememberCompletedLocalTurn?: (turnId: string) => void;
}

function lifecycleFromOptions(options: ClientAbortTurnOptions): ClientTelegramTurnLifecycle {
	if (options.turnLifecycle) return options.turnLifecycle;
	const lifecycle = new ClientTelegramTurnLifecycle({
		getSessionId: () => "session",
		getLatestCtx: () => undefined,
		getConnectedRoute: () => undefined,
		hasClientServer: () => true,
		postTurnStarted: () => undefined,
		sendUserMessage: () => undefined,
		acknowledgeConsumedTurn: () => undefined,
	});
	lifecycle.replaceQueuedTurns(options.queuedTelegramTurns ?? []);
	const activeTurn = options.getActiveTelegramTurn?.();
	if (activeTurn) lifecycle.restoreActiveTurn(activeTurn);
	const originalRememberCompleted = lifecycle.rememberCompletedTurn.bind(lifecycle);
	lifecycle.rememberCompletedTurn = (turnId) => {
		originalRememberCompleted(turnId);
		options.rememberCompletedLocalTurn?.(turnId);
	};
	return lifecycle;
}

export async function clientAbortTelegramTurn(options: ClientAbortTurnOptions): Promise<{ text: string; clearedTurnIds: string[] }> {
	const turnLifecycle = lifecycleFromOptions(options);
	const queuedTurnIds = [
		...turnLifecycle.getQueuedTurnsSnapshot().map((turn) => turn.turnId),
		...(options.turnLifecycle ? turnLifecycle.getManualCompactionQueue().peekPendingRemainder() : options.peekManualCompactionRemainder?.() ?? []).map((turn) => turn.turnId),
	];
	const queuedCount = queuedTurnIds.length;

	const activeTurnId = turnLifecycle.getActiveTurn()?.turnId;
	const releasedDeferredTurnId = await options.releaseDeferredTurn({ markCompleted: true, startNext: false, deliverAbortedFinal: true });
	const clearedTurnIds = options.turnLifecycle
		? turnLifecycle.clearQueuedAndDeferredTurnsAsCompleted()
		: [...turnLifecycle.clearQueuedAndDeferredTurnsAsCompleted(), ...(options.clearManualCompactionRemainder?.() ?? []).map((turn) => {
			options.rememberCompletedLocalTurn?.(turn.turnId);
			return turn.turnId;
		})];
	if (!options.turnLifecycle) {
		if (options.queuedTelegramTurns) options.queuedTelegramTurns.length = 0;
		options.cancelDeferredCompactionStart?.();
	}
	if (releasedDeferredTurnId) clearedTurnIds.push(releasedDeferredTurnId);

	const abortActiveTurn = activeTurnId || releasedDeferredTurnId ? options.getAbortActiveTurn() : undefined;
	if (abortActiveTurn) {
		if (activeTurnId && activeTurnId !== releasedDeferredTurnId) {
			turnLifecycle.rememberCompletedTurn(activeTurnId);
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
