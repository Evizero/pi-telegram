import assert from "node:assert/strict";

import { clientDeliverTelegramTurn } from "../src/client/turn-delivery.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ActiveTelegramTurn, AssistantFinalPayload, PendingTelegramTurn } from "../src/shared/types.js";

function turn(id: string, deliveryMode?: PendingTelegramTurn["deliveryMode"]): PendingTelegramTurn {
	return {
		turnId: id,
		sessionId: "session-1",
		chatId: 123,
		messageThreadId: 9,
		replyToMessageId: 0,
		queuedAttachments: [],
		content: [{ type: "text", text: `message ${id}` }],
		historyText: "",
		deliveryMode,
	};
}

function activeTurn(id = "active"): ActiveTelegramTurn {
	return { ...turn(id), queuedAttachments: [] };
}

function busyCtx(): ExtensionContext {
	return { isIdle: () => false } as unknown as ExtensionContext;
}

function idleCtx(): ExtensionContext {
	return { isIdle: () => true } as unknown as ExtensionContext;
}

async function checkBusyOrdinaryTurnSteersAndIsConsumed(): Promise<void> {
	const queued: PendingTelegramTurn[] = [];
	const sent: Array<{ content: PendingTelegramTurn["content"]; deliverAs?: string }> = [];
	const consumed: string[] = [];
	const mirrored: string[] = [];
	const result = await clientDeliverTelegramTurn({
		turn: turn("plain"),
		completedTurnIds: new Set(),
		queuedTelegramTurns: queued,
		getActiveTelegramTurn: () => activeTurn(),
		getCtx: busyCtx,
		isManualCompactionInProgress: () => false,
		hasDeferredCompactionTurn: () => false,
		enqueueDeferredCompactionTurn: () => false,
		findPendingFinal: () => undefined,
		sendAssistantFinalToBroker: async () => true,
		acknowledgeConsumedTurn: async (turnId) => { consumed.push(turnId); },
		ensureCurrentTurnMirroredToTelegram: (_ctx, historyText) => { mirrored.push(historyText); },
		sendUserMessage: (content, options) => { sent.push({ content, deliverAs: options?.deliverAs }); },
		startNextTelegramTurn: () => { throw new Error("busy steer should not start next turn"); },
	});

	assert.deepEqual(result, { accepted: true });
	assert.equal(queued.length, 0);
	assert.deepEqual(consumed, ["plain"]);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.deliverAs, "steer");
	assert.equal(mirrored.length, 1);
}

async function checkBusyFollowUpQueuesWithoutSteering(): Promise<void> {
	const queued: PendingTelegramTurn[] = [];
	const sent: Array<{ deliverAs?: string }> = [];
	const consumed: string[] = [];
	await clientDeliverTelegramTurn({
		turn: turn("follow", "followUp"),
		completedTurnIds: new Set(),
		queuedTelegramTurns: queued,
		getActiveTelegramTurn: () => activeTurn(),
		getCtx: busyCtx,
		isManualCompactionInProgress: () => false,
		hasDeferredCompactionTurn: () => false,
		enqueueDeferredCompactionTurn: () => false,
		findPendingFinal: () => undefined,
		sendAssistantFinalToBroker: async () => true,
		acknowledgeConsumedTurn: async (turnId) => { consumed.push(turnId); },
		ensureCurrentTurnMirroredToTelegram: () => { throw new Error("follow-up should not mirror active turn"); },
		sendUserMessage: (_content, options) => { sent.push({ deliverAs: options?.deliverAs }); },
		startNextTelegramTurn: () => { throw new Error("busy follow-up should not start next turn"); },
	});

	assert.deepEqual(queued.map((candidate) => candidate.turnId), ["follow"]);
	assert.deepEqual(consumed, []);
	assert.deepEqual(sent, []);
}

async function checkIdleTurnQueuesAndStartsNext(): Promise<void> {
	const queued: PendingTelegramTurn[] = [];
	let starts = 0;
	await clientDeliverTelegramTurn({
		turn: turn("idle"),
		completedTurnIds: new Set(),
		queuedTelegramTurns: queued,
		getActiveTelegramTurn: () => undefined,
		getCtx: idleCtx,
		isManualCompactionInProgress: () => false,
		hasDeferredCompactionTurn: () => false,
		enqueueDeferredCompactionTurn: () => false,
		findPendingFinal: () => undefined,
		sendAssistantFinalToBroker: async () => true,
		acknowledgeConsumedTurn: async () => { throw new Error("idle turn should not be consumed immediately"); },
		ensureCurrentTurnMirroredToTelegram: () => { throw new Error("idle turn should not mirror active turn"); },
		sendUserMessage: () => { throw new Error("idle turn should be started by startNextTelegramTurn"); },
		startNextTelegramTurn: () => { starts += 1; },
	});

	assert.deepEqual(queued.map((candidate) => candidate.turnId), ["idle"]);
	assert.equal(starts, 1);
}

async function checkCompletedTurnResendsPendingFinal(): Promise<void> {
	const final: AssistantFinalPayload = { turn: turn("done"), text: "already done", attachments: [] };
	const sentFinals: AssistantFinalPayload[] = [];
	const consumed: string[] = [];
	await clientDeliverTelegramTurn({
		turn: turn("done"),
		completedTurnIds: new Set(["done"]),
		queuedTelegramTurns: [],
		getActiveTelegramTurn: () => undefined,
		getCtx: idleCtx,
		isManualCompactionInProgress: () => false,
		hasDeferredCompactionTurn: () => false,
		enqueueDeferredCompactionTurn: () => false,
		findPendingFinal: () => final,
		sendAssistantFinalToBroker: async (payload) => { sentFinals.push(payload); return true; },
		acknowledgeConsumedTurn: async (turnId) => { consumed.push(turnId); },
		ensureCurrentTurnMirroredToTelegram: () => undefined,
		sendUserMessage: () => undefined,
		startNextTelegramTurn: () => undefined,
	});

	assert.deepEqual(sentFinals, [final]);
	assert.deepEqual(consumed, []);
}

async function checkManualCompactionQueuesOrdinaryMessagesWithoutSteering(): Promise<void> {
	const queued: PendingTelegramTurn[] = [];
	const sent: Array<{ deliverAs?: string }> = [];
	const consumed: string[] = [];
	let starts = 0;
	await clientDeliverTelegramTurn({
		turn: turn("compact-plain"),
		completedTurnIds: new Set(),
		queuedTelegramTurns: queued,
		getActiveTelegramTurn: () => undefined,
		getCtx: idleCtx,
		isManualCompactionInProgress: () => true,
		hasDeferredCompactionTurn: () => false,
		enqueueDeferredCompactionTurn: () => false,
		findPendingFinal: () => undefined,
		sendAssistantFinalToBroker: async () => true,
		acknowledgeConsumedTurn: async (turnId) => { consumed.push(turnId); },
		ensureCurrentTurnMirroredToTelegram: () => { throw new Error("manual compaction should defer instead of steering"); },
		sendUserMessage: (_content, options) => { sent.push({ deliverAs: options?.deliverAs }); },
		startNextTelegramTurn: () => { starts += 1; },
	});

	assert.deepEqual(queued.map((candidate) => candidate.turnId), ["compact-plain"]);
	assert.deepEqual(sent, []);
	assert.deepEqual(consumed, []);
	assert.equal(starts, 0);
}

async function checkManualCompactionQueuesFollowUpWithoutStartingTurn(): Promise<void> {
	const queued: PendingTelegramTurn[] = [];
	const sent: Array<{ deliverAs?: string }> = [];
	const consumed: string[] = [];
	let starts = 0;
	await clientDeliverTelegramTurn({
		turn: turn("compact-follow", "followUp"),
		completedTurnIds: new Set(),
		queuedTelegramTurns: queued,
		getActiveTelegramTurn: () => undefined,
		getCtx: idleCtx,
		isManualCompactionInProgress: () => true,
		hasDeferredCompactionTurn: () => false,
		enqueueDeferredCompactionTurn: () => false,
		findPendingFinal: () => undefined,
		sendAssistantFinalToBroker: async () => true,
		acknowledgeConsumedTurn: async (turnId) => { consumed.push(turnId); },
		ensureCurrentTurnMirroredToTelegram: () => { throw new Error("manual compaction follow-up should defer"); },
		sendUserMessage: (_content, options) => { sent.push({ deliverAs: options?.deliverAs }); },
		startNextTelegramTurn: () => { starts += 1; },
	});

	assert.deepEqual(queued.map((candidate) => candidate.turnId), ["compact-follow"]);
	assert.deepEqual(sent, []);
	assert.deepEqual(consumed, []);
	assert.equal(starts, 0);
}

async function checkActiveTurnPreventsImmediateRestartWhileCtxStillIdle(): Promise<void> {
	const queued: PendingTelegramTurn[] = [];
	let starts = 0;
	await clientDeliverTelegramTurn({
		turn: turn("queued-behind-active"),
		completedTurnIds: new Set(),
		queuedTelegramTurns: queued,
		getActiveTelegramTurn: () => activeTurn("already-starting"),
		getCtx: idleCtx,
		isManualCompactionInProgress: () => false,
		hasDeferredCompactionTurn: () => false,
		enqueueDeferredCompactionTurn: () => false,
		findPendingFinal: () => undefined,
		sendAssistantFinalToBroker: async () => true,
		acknowledgeConsumedTurn: async () => { throw new Error("queued turn should not be consumed immediately"); },
		ensureCurrentTurnMirroredToTelegram: () => { throw new Error("idle ctx window should not steer"); },
		sendUserMessage: () => { throw new Error("idle ctx window should not send immediately"); },
		startNextTelegramTurn: () => { starts += 1; },
	});

	assert.deepEqual(queued.map((candidate) => candidate.turnId), ["queued-behind-active"]);
	assert.equal(starts, 0);
}

async function checkDeferredCompactionDuplicateIsIgnored(): Promise<void> {
	const queued: PendingTelegramTurn[] = [];
	let starts = 0;
	await clientDeliverTelegramTurn({
		turn: turn("duplicate-deferred"),
		completedTurnIds: new Set(),
		queuedTelegramTurns: queued,
		getActiveTelegramTurn: () => undefined,
		getCtx: idleCtx,
		isManualCompactionInProgress: () => false,
		hasDeferredCompactionTurn: (turnId) => turnId === "duplicate-deferred",
		enqueueDeferredCompactionTurn: () => false,
		findPendingFinal: () => undefined,
		sendAssistantFinalToBroker: async () => true,
		acknowledgeConsumedTurn: async () => { throw new Error("duplicate deferred turn should be ignored"); },
		ensureCurrentTurnMirroredToTelegram: () => { throw new Error("duplicate deferred turn should be ignored"); },
		sendUserMessage: () => { throw new Error("duplicate deferred turn should be ignored"); },
		startNextTelegramTurn: () => { starts += 1; },
	});

	assert.deepEqual(queued, []);
	assert.equal(starts, 0);
}

async function checkCompactionBoundaryMessagesJoinDeferredRemainder(): Promise<void> {
	const queued: PendingTelegramTurn[] = [];
	const appended: PendingTelegramTurn[] = [];
	await clientDeliverTelegramTurn({
		turn: turn("boundary-plain"),
		completedTurnIds: new Set(),
		queuedTelegramTurns: queued,
		getActiveTelegramTurn: () => activeTurn("starting"),
		getCtx: idleCtx,
		isManualCompactionInProgress: () => false,
		hasDeferredCompactionTurn: () => false,
		enqueueDeferredCompactionTurn: (deferredTurn) => {
			appended.push(deferredTurn);
			return true;
		},
		findPendingFinal: () => undefined,
		sendAssistantFinalToBroker: async () => true,
		acknowledgeConsumedTurn: async () => { throw new Error("boundary message should wait for agent_start drain"); },
		ensureCurrentTurnMirroredToTelegram: () => { throw new Error("boundary message should join deferred remainder"); },
		sendUserMessage: () => { throw new Error("boundary message should not send immediately"); },
		startNextTelegramTurn: () => { throw new Error("boundary message should not start next turn"); },
	});

	assert.deepEqual(queued, []);
	assert.deepEqual(appended.map((candidate) => candidate.turnId), ["boundary-plain"]);
}

await checkBusyOrdinaryTurnSteersAndIsConsumed();
await checkBusyFollowUpQueuesWithoutSteering();
await checkIdleTurnQueuesAndStartsNext();
await checkCompletedTurnResendsPendingFinal();
await checkManualCompactionQueuesOrdinaryMessagesWithoutSteering();
await checkManualCompactionQueuesFollowUpWithoutStartingTurn();
await checkActiveTurnPreventsImmediateRestartWhileCtxStillIdle();
await checkDeferredCompactionDuplicateIsIgnored();
await checkCompactionBoundaryMessagesJoinDeferredRemainder();
console.log("Client turn delivery checks passed");
