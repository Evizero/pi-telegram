import assert from "node:assert/strict";

import { clientAbortTelegramTurn } from "../src/client/abort-turn.js";
import type { ActiveTelegramTurn, PendingTelegramTurn } from "../src/client/types.js";

function turn(id: string): PendingTelegramTurn {
	return {
		turnId: id,
		sessionId: "session-1",
		chatId: 123,
		messageThreadId: 9,
		replyToMessageId: 0,
		queuedAttachments: [],
		content: [],
		historyText: "",
	};
}

function activeTurn(id = "active"): ActiveTelegramTurn {
	return { ...turn(id), queuedAttachments: [] };
}

async function checkStopReleasesDeferredRetryWithoutAbortCallback(): Promise<void> {
	const queued = [turn("queued-1")];
	const completed: string[] = [];
	let releasedOptions: { markCompleted?: boolean; startNext?: boolean; deliverAbortedFinal?: boolean } | undefined;
	const result = await clientAbortTelegramTurn({
		queuedTelegramTurns: queued,
		peekManualCompactionRemainder: () => [turn("queued-2")],
		clearManualCompactionRemainder: () => [turn("queued-2")],
		cancelDeferredCompactionStart: () => undefined,
		getActiveTelegramTurn: () => activeTurn("retrying"),
		getAbortActiveTurn: () => undefined,
		releaseDeferredTurn: async (options) => {
			releasedOptions = options;
			completed.push("retrying");
			return "retrying";
		},
		rememberCompletedLocalTurn: (turnId) => { completed.push(turnId); },
	});

	assert.equal(queued.length, 0);
	assert.deepEqual(result, {
		text: "Stopped waiting for retry and suppressed 2 queued turn(s).",
		clearedTurnIds: ["queued-1", "queued-2", "retrying"],
	});
	assert.deepEqual(completed, ["retrying", "queued-1", "queued-2"]);
	assert.deepEqual(releasedOptions, { markCompleted: true, startNext: false, deliverAbortedFinal: true });
}

async function checkStopUsesAbortCallbackForActiveTurn(): Promise<void> {
	const queued: PendingTelegramTurn[] = [];
	const completed: string[] = [];
	let aborted = 0;
	const result = await clientAbortTelegramTurn({
		queuedTelegramTurns: queued,
		peekManualCompactionRemainder: () => [],
		clearManualCompactionRemainder: () => [],
		cancelDeferredCompactionStart: () => undefined,
		getActiveTelegramTurn: () => activeTurn("live-turn"),
		getAbortActiveTurn: () => () => { aborted += 1; },
		releaseDeferredTurn: async () => undefined,
		rememberCompletedLocalTurn: (turnId) => { completed.push(turnId); },
	});

	assert.equal(aborted, 1);
	assert.deepEqual(result, { text: "Aborted current turn.", clearedTurnIds: ["live-turn"] });
	assert.deepEqual(completed, ["live-turn"]);
}

async function checkNoActiveTurnDoesNotInvokeFallbackAbort(): Promise<void> {
	const queued: PendingTelegramTurn[] = [];
	let aborted = 0;
	const result = await clientAbortTelegramTurn({
		queuedTelegramTurns: queued,
		peekManualCompactionRemainder: () => [],
		clearManualCompactionRemainder: () => [],
		cancelDeferredCompactionStart: () => undefined,
		getActiveTelegramTurn: () => undefined,
		getAbortActiveTurn: () => () => { aborted += 1; },
		releaseDeferredTurn: async () => undefined,
		rememberCompletedLocalTurn: () => undefined,
	});

	assert.equal(aborted, 0);
	assert.deepEqual(result, { text: "No active turn.", clearedTurnIds: [] });
}

await checkStopReleasesDeferredRetryWithoutAbortCallback();
await checkStopUsesAbortCallbackForActiveTurn();
await checkNoActiveTurnDoesNotInvokeFallbackAbort();
console.log("Client abort turn checks passed");
