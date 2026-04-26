import assert from "node:assert/strict";

import { RetryAwareTelegramTurnFinalizer } from "../src/client/retry-aware-finalization.js";
import type { ActiveTelegramTurn, AssistantFinalPayload } from "../src/shared/types.js";

function activeTurn(id = "turn-1"): ActiveTelegramTurn {
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

function payload(fields: Partial<AssistantFinalPayload> = {}): AssistantFinalPayload {
	return {
		turn: activeTurn(),
		attachments: [],
		...fields,
	};
}

function makeScheduler(): {
	setTimeoutFn: (callback: () => void, delayMs: number) => number;
	clearTimeoutFn: (handle: unknown) => void;
	runNext: () => Promise<void>;
} {
	let nextId = 1;
	const timers = new Map<number, () => void>();
	return {
		setTimeoutFn: (callback) => {
			const id = nextId++;
			timers.set(id, callback);
			return id;
		},
		clearTimeoutFn: (handle) => {
			if (typeof handle === "number") timers.delete(handle);
		},
		runNext: async () => {
			const next = timers.entries().next().value as [number, (() => void)] | undefined;
			if (!next) throw new Error("No timer scheduled");
			const [id, callback] = next;
			timers.delete(id);
			callback();
			await new Promise((resolveValue) => setTimeout(resolveValue, 0));
		},
	};
}

async function checkRetryableErrorDefersAndRetrySuccessWins(): Promise<void> {
	let active: ActiveTelegramTurn | undefined = activeTurn();
	const cleared: string[] = [];
	let sentCount = 0;
	let sentText: string | undefined;
	const completed: string[] = [];
	let started = 0;
	const scheduler = makeScheduler();
	const finalizer = new RetryAwareTelegramTurnFinalizer({
		getActiveTelegramTurn: () => active,
		setActiveTelegramTurn: (turn) => { active = turn; },
		rememberCompletedLocalTurn: (turnId) => { completed.push(turnId); },
		startNextTelegramTurn: () => { started += 1; },
		sendAssistantFinalToBroker: async (finalPayload) => {
			sentCount += 1;
			sentText = finalPayload.text;
			return true;
		},
		clearPreview: async (turnId) => { cleared.push(turnId); },
	}, scheduler);

	const first = await finalizer.finalizeActiveTurn(payload({ stopReason: "error", errorMessage: "fetch failed" }));
	assert.equal(first, "deferred");
	assert.equal(finalizer.hasDeferredTurn("turn-1"), true);
	assert.deepEqual(cleared, ["turn-1"]);
	assert.equal(sentCount, 0);
	assert.equal(active?.turnId, "turn-1");
	assert.equal(started, 0);
	assert.deepEqual(completed, []);

	finalizer.onAgentStart();
	assert.equal(finalizer.hasDeferredTurn("turn-1"), true);
	assert.equal(active?.turnId, "turn-1");
	finalizer.onRetryMessageStart();
	assert.equal(finalizer.hasDeferredTurn(), false);

	const second = await finalizer.finalizeActiveTurn(payload({ text: "real final", stopReason: "error", errorMessage: "terminated" }));
	assert.equal(second, "completed");
	assert.equal(sentCount, 1);
	assert.equal(sentText, "real final");
	assert.deepEqual(completed, ["turn-1"]);
	assert.equal(active, undefined);
	assert.equal(started, 1);
}

async function checkDeferredErrorFallsBackAfterGrace(): Promise<void> {
	let active: ActiveTelegramTurn | undefined = activeTurn("turn-2");
	let sentCount = 0;
	let sentErrorMessage: string | undefined;
	const scheduler = makeScheduler();
	let started = 0;
	const finalizer = new RetryAwareTelegramTurnFinalizer({
		getActiveTelegramTurn: () => active,
		setActiveTelegramTurn: (turn) => { active = turn; },
		rememberCompletedLocalTurn: () => undefined,
		startNextTelegramTurn: () => { started += 1; },
		sendAssistantFinalToBroker: async (finalPayload) => {
			sentCount += 1;
			sentErrorMessage = finalPayload.errorMessage;
			return true;
		},
		clearPreview: async () => undefined,
	}, scheduler);

	await finalizer.finalizeActiveTurn(payload({ turn: activeTurn("turn-2"), stopReason: "error", errorMessage: "terminated" }));
	assert.equal(sentCount, 0);
	assert.equal(finalizer.hasDeferredTurn("turn-2"), true);

	await scheduler.runNext();
	assert.equal(finalizer.hasDeferredTurn(), false);
	assert.equal(active, undefined);
	assert.equal(started, 1);
	assert.equal(sentCount, 1);
	assert.equal(sentErrorMessage, "terminated");
}

async function checkDeferredErrorCanBeFlushedBeforeRetryStarts(): Promise<void> {
	let active: ActiveTelegramTurn | undefined = activeTurn("turn-3");
	let sentCount = 0;
	let sentErrorMessage: string | undefined;
	const finalizer = new RetryAwareTelegramTurnFinalizer({
		getActiveTelegramTurn: () => active,
		setActiveTelegramTurn: (turn) => { active = turn; },
		rememberCompletedLocalTurn: () => undefined,
		startNextTelegramTurn: () => undefined,
		sendAssistantFinalToBroker: async (finalPayload) => {
			sentCount += 1;
			sentErrorMessage = finalPayload.errorMessage;
			return true;
		},
		clearPreview: async () => undefined,
	});

	await finalizer.finalizeActiveTurn(payload({ turn: activeTurn("turn-3"), stopReason: "error", errorMessage: "fetch failed" }));
	assert.equal(finalizer.hasDeferredTurn("turn-3"), true);

	const flushedTurnId = await finalizer.flushDeferredTurn();
	assert.equal(flushedTurnId, "turn-3");
	assert.equal(finalizer.hasDeferredTurn(), false);
	assert.equal(active, undefined);
	assert.equal(sentCount, 1);
	assert.equal(sentErrorMessage, "fetch failed");
}

async function checkReleaseDeferredTurnCanSendAbortedCleanupFinal(): Promise<void> {
	let active: ActiveTelegramTurn | undefined = activeTurn("turn-4");
	const sent: Array<{ stopReason?: string; attachments: unknown[] }> = [];
	const completed: string[] = [];
	const finalizer = new RetryAwareTelegramTurnFinalizer({
		getActiveTelegramTurn: () => active,
		setActiveTelegramTurn: (turn) => { active = turn; },
		rememberCompletedLocalTurn: (turnId) => { completed.push(turnId); },
		startNextTelegramTurn: () => undefined,
		sendAssistantFinalToBroker: async (finalPayload) => {
			sent.push({ stopReason: finalPayload.stopReason, attachments: finalPayload.attachments });
			return true;
		},
		clearPreview: async () => undefined,
	});

	await finalizer.finalizeActiveTurn(payload({ turn: activeTurn("turn-4"), stopReason: "error", errorMessage: "terminated" }));
	const releasedTurnId = await finalizer.releaseDeferredTurn({ markCompleted: true, startNext: false, deliverAbortedFinal: true });
	assert.equal(releasedTurnId, "turn-4");
	assert.deepEqual(sent, [{ stopReason: "aborted", attachments: [] }]);
	assert.deepEqual(completed, ["turn-4"]);
	assert.equal(active, undefined);
}

async function checkReleaseDeferredTurnFallsBackToRetryQueueWithoutThrowing(): Promise<void> {
	let active: ActiveTelegramTurn | undefined = activeTurn("turn-6a");
	let confirmedAttempts = 0;
	let queuedAttempts = 0;
	const finalizer = new RetryAwareTelegramTurnFinalizer({
		getActiveTelegramTurn: () => active,
		setActiveTelegramTurn: (turn) => { active = turn; },
		rememberCompletedLocalTurn: () => undefined,
		startNextTelegramTurn: () => undefined,
		handoffAssistantFinalToBroker: async () => {
			confirmedAttempts += 1;
			return false;
		},
		sendAssistantFinalToBroker: async () => {
			queuedAttempts += 1;
			return false;
		},
		clearPreview: async () => undefined,
	});

	await finalizer.finalizeActiveTurn(payload({ turn: activeTurn("turn-6a"), stopReason: "error", errorMessage: "fetch failed" }));
	const releasedTurnId = await finalizer.releaseDeferredTurn({ markCompleted: true, startNext: false, deliverAbortedFinal: true });
	assert.equal(releasedTurnId, "turn-6a");
	assert.equal(confirmedAttempts, 1);
	assert.equal(queuedAttempts, 1);
	assert.equal(active, undefined);
	assert.equal(finalizer.hasDeferredTurn(), false);
}

async function checkRepeatedDeferredRestoreDoesNotResetWatchdog(): Promise<void> {
	let active: ActiveTelegramTurn | undefined = activeTurn("turn-6b");
	let sentCount = 0;
	const scheduler = makeScheduler();
	const finalizer = new RetryAwareTelegramTurnFinalizer({
		getActiveTelegramTurn: () => active,
		setActiveTelegramTurn: (turn) => { active = turn; },
		rememberCompletedLocalTurn: () => undefined,
		startNextTelegramTurn: () => undefined,
		sendAssistantFinalToBroker: async () => {
			sentCount += 1;
			return true;
		},
		clearPreview: async () => undefined,
	}, scheduler);
	const deferredPayload = payload({ turn: activeTurn("turn-6b"), stopReason: "error", errorMessage: "terminated" });
	finalizer.restoreDeferredPayload(deferredPayload);
	finalizer.restoreDeferredPayload(deferredPayload);
	await scheduler.runNext();
	assert.equal(sentCount, 1);
	assert.equal(finalizer.hasDeferredTurn(), false);
}

async function checkBrokerHandoffFailureKeepsTurnActiveUntilRetryQueueSucceeds(): Promise<void> {
	let active: ActiveTelegramTurn | undefined = activeTurn("turn-6");
	let awaitingTurnId: string | undefined;
	let sendAttempts = 0;
	const finalizer = new RetryAwareTelegramTurnFinalizer({
		getActiveTelegramTurn: () => active,
		setActiveTelegramTurn: (turn) => { active = turn; },
		rememberCompletedLocalTurn: () => undefined,
		startNextTelegramTurn: () => undefined,
		sendAssistantFinalToBroker: async () => {
			sendAttempts += 1;
			return false;
		},
		setAwaitingTelegramFinalTurn: (turnId) => { awaitingTurnId = turnId; },
		clearPreview: async () => undefined,
	});

	await finalizer.finalizeActiveTurn(payload({ turn: activeTurn("turn-6"), text: "final text" }));
	assert.equal(sendAttempts, 1);
	assert.equal(active?.turnId, "turn-6");
	assert.equal(awaitingTurnId, "turn-6");
	assert.equal(finalizer.hasDeferredTurn(), false);
}

async function checkDeferredErrorStillDefersWhenPreviewClearFails(): Promise<void> {
	let active: ActiveTelegramTurn | undefined = activeTurn("turn-5");
	let sentCount = 0;
	const finalizer = new RetryAwareTelegramTurnFinalizer({
		getActiveTelegramTurn: () => active,
		setActiveTelegramTurn: (turn) => { active = turn; },
		rememberCompletedLocalTurn: () => undefined,
		startNextTelegramTurn: () => undefined,
		sendAssistantFinalToBroker: async () => {
			sentCount += 1;
			return true;
		},
		clearPreview: async () => { throw new Error("broker unavailable"); },
	});

	const result = await finalizer.finalizeActiveTurn(payload({ turn: activeTurn("turn-5"), stopReason: "error", errorMessage: "fetch failed" }));
	assert.equal(result, "deferred");
	assert.equal(finalizer.hasDeferredTurn("turn-5"), true);
	assert.equal(sentCount, 0);
	assert.equal(active?.turnId, "turn-5");
}

await checkRetryableErrorDefersAndRetrySuccessWins();
await checkDeferredErrorFallsBackAfterGrace();
await checkDeferredErrorCanBeFlushedBeforeRetryStarts();
await checkReleaseDeferredTurnCanSendAbortedCleanupFinal();
await checkReleaseDeferredTurnFallsBackToRetryQueueWithoutThrowing();
await checkRepeatedDeferredRestoreDoesNotResetWatchdog();
await checkBrokerHandoffFailureKeepsTurnActiveUntilRetryQueueSucceeds();
await checkDeferredErrorStillDefersWhenPreviewClearFails();
console.log("Retry-aware finalization checks passed");
