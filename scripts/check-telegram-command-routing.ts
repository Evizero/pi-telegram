import assert from "node:assert/strict";

import type { ClientManualCompactionResult, PendingTelegramTurn } from "../src/client/types.js";
import type { TelegramMessage } from "../src/telegram/types.js";
import { createRouter, message, state } from "./support/telegram-command-fixtures.js";
import type { IpcCall } from "./support/telegram-command-fixtures.js";

type PostIpcOverride = <TResponse>(socketPath: string, type: string, payload: unknown, targetSessionId?: string) => Promise<TResponse>;

function privateMessage(text: string): TelegramMessage {
	return {
		message_id: Math.floor(Math.random() * 1000),
		chat: { id: 123, type: "private" },
		from: { id: 456, is_bot: false, first_name: "User" },
		text,
	};
}

async function checkCommandRoutingPreservesCompactStopFollowSteerAndPlainTurns(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	let turnCounter = 0;
	const router = createRouter(brokerState, ipcCalls, sentReplies, [], () => ++turnCounter);

	await router.dispatch([message("/compact", 10)]);
	await router.markManualCompactionSettled("compact:session-1:123:9:10");
	await router.dispatch([message("/stop")]);
	await router.dispatch([message("/follow after this")]);
	await router.dispatch([message("/steer steer now")]);
	await router.dispatch([message("plain follow-up by default")]);

	assert.deepEqual(ipcCalls.map((call) => call.type), ["queue_or_start_compact_session", "abort_turn", "deliver_turn", "deliver_turn", "deliver_turn"]);
	assert.deepEqual(sentReplies, ["Compaction started.", "Aborted current turn."]);
	const followTurn = ipcCalls[2]!.payload as PendingTelegramTurn;
	const steerTurn = ipcCalls[3]!.payload as PendingTelegramTurn;
	const plainTurn = ipcCalls[4]!.payload as PendingTelegramTurn;
	assert.equal(followTurn.deliveryMode, "followUp");
	assert.equal(followTurn.content[0]?.type, "text");
	assert.equal(followTurn.historyText, "after this");
	assert.equal(steerTurn.deliveryMode, "steer");
	assert.equal(steerTurn.historyText, "steer now");
	assert.equal(plainTurn.deliveryMode, undefined);
	assert.equal(plainTurn.historyText, "plain follow-up by default");
	assert.equal(ipcCalls.every((call) => call.target === "session-1"), true);
}

async function checkFreshCompactWaitsForEarlierPendingTurn(): Promise<void> {
	const brokerState = state();
	brokerState.pendingTurns = {
		before: {
			turn: { turnId: "before", sessionId: "session-1", routeId: "123:9", chatId: 123, messageThreadId: 9, replyToMessageId: 1, queuedAttachments: [], content: [], historyText: "before" },
			updatedAtMs: 1,
		},
	};
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	let turnCounter = 0;
	const router = createRouter(brokerState, ipcCalls, sentReplies, [], () => ++turnCounter);

	await router.dispatch([message("/compact", 66)]);
	await router.dispatch([message("after compact", 67)]);

	assert.deepEqual(ipcCalls, []);
	assert.deepEqual(sentReplies, ["Compaction queued after current work.", "Queued after compaction."]);
	assert.deepEqual(Object.keys(brokerState.pendingManualCompactions ?? {}), ["compact:session-1:123:9:66"]);
	assert.equal(brokerState.pendingTurns?.["turn-1"]?.turn.blockedByManualCompactionOperationId, "compact:session-1:123:9:66");
}

async function checkQueuedCompactPersistsAndCoalescesUntilStarted(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const postIpc: PostIpcOverride = async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
		ipcCalls.push({ type, payload });
		if (type === "queue_or_start_compact_session") return { status: "queued", text: "Compaction queued after current work.", operationId: (payload as { operation: { operationId: string } }).operation.operationId } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, [], () => 1, undefined, undefined, postIpc);

	await router.dispatch([message("/compact", 77)]);
	await router.dispatch([message("/compact", 78)]);

	assert.deepEqual(ipcCalls.map((call) => call.type), ["queue_or_start_compact_session"]);
	assert.deepEqual(sentReplies, ["Compaction queued after current work.", "Compaction already queued after current work."]);
	assert.deepEqual(Object.keys(brokerState.pendingManualCompactions ?? {}), ["compact:session-1:123:9:77"]);
	await router.markManualCompactionStarted("compact:session-1:123:9:77");
	assert.equal(brokerState.pendingManualCompactions?.["compact:session-1:123:9:77"]?.status, "running");
	await router.markManualCompactionSettled("compact:session-1:123:9:77");
	assert.deepEqual(Object.keys(brokerState.pendingManualCompactions ?? {}), []);
}

async function checkStartedCompactMarksPendingOperationRunning(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const postIpc: PostIpcOverride = async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
		ipcCalls.push({ type, payload });
		if (type === "queue_or_start_compact_session") return { status: "started", text: "Compaction started.", operationId: (payload as { operation: { operationId: string } }).operation.operationId } satisfies ClientManualCompactionResult as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, [], () => 1, undefined, undefined, postIpc);

	await router.dispatch([message("/compact", 88)]);

	assert.deepEqual(sentReplies, ["Compaction started."]);
	assert.deepEqual(Object.keys(brokerState.pendingManualCompactions ?? {}), ["compact:session-1:123:9:88"]);
	assert.equal(brokerState.pendingManualCompactions?.["compact:session-1:123:9:88"]?.status, "running");
	await router.markManualCompactionSettled("compact:session-1:123:9:88");
	assert.deepEqual(Object.keys(brokerState.pendingManualCompactions ?? {}), []);
}

async function checkRetryReconcilesQueuedAndRunningCompactOperations(): Promise<void> {
	const brokerState = state();
	brokerState.pendingManualCompactions = {
		"compact-queued": { operationId: "compact-queued", sessionId: "session-1", routeId: "123:9", chatId: 123, messageThreadId: 9, status: "queued", createdAtMs: 1, updatedAtMs: 1 },
		"compact-running": { operationId: "compact-running", sessionId: "session-1", routeId: "123:9", chatId: 123, messageThreadId: 9, status: "running", createdAtMs: 1, updatedAtMs: 1 },
	};
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const postIpc: PostIpcOverride = async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
		ipcCalls.push({ type, payload });
		const operationId = (payload as { operation: { operationId: string } }).operation.operationId;
		if (operationId === "compact-queued") return { status: "already_running", text: "Compaction already running.", operationId } as TResponse;
		if (operationId === "compact-running") return { status: "already_handled", text: "Compaction already handled.", operationId } as TResponse;
		throw new Error(`unexpected operation ${operationId}`);
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, [], () => 1, undefined, undefined, postIpc);

	const clearedAny = await router.retryPendingManualCompactions();

	assert.equal(clearedAny, true);
	assert.deepEqual(ipcCalls.map((call) => (call.payload as { operation: { operationId: string } }).operation.operationId), ["compact-queued", "compact-running"]);
	assert.equal(brokerState.pendingManualCompactions?.["compact-queued"]?.status, "running");
	assert.equal(brokerState.pendingManualCompactions?.["compact-running"], undefined);
	assert.deepEqual(sentReplies, []);
}

async function checkRetryWaitsForEarlierPendingTurnsBeforeManualCompact(): Promise<void> {
	const brokerState = state();
	brokerState.pendingManualCompactions = {
		"compact-barrier": { operationId: "compact-barrier", sessionId: "session-1", routeId: "123:9", chatId: 123, messageThreadId: 9, status: "queued", createdAtMs: 1, updatedAtMs: 1 },
	};
	brokerState.pendingTurns = {
		before: {
			turn: { turnId: "before", sessionId: "session-1", routeId: "123:9", chatId: 123, messageThreadId: 9, replyToMessageId: 1, queuedAttachments: [], content: [], historyText: "before" },
			updatedAtMs: 1,
		},
		after: {
			turn: { turnId: "after", sessionId: "session-1", routeId: "123:9", chatId: 123, messageThreadId: 9, replyToMessageId: 2, queuedAttachments: [], content: [], historyText: "after", blockedByManualCompactionOperationId: "compact-barrier" },
			updatedAtMs: 1,
		},
	};
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const postIpc: PostIpcOverride = async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
		ipcCalls.push({ type, payload });
		return { status: "queued", text: "Compaction queued after current work.", operationId: "compact-barrier" } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, [], () => 1, undefined, undefined, postIpc);

	assert.equal(await router.retryPendingManualCompactions(), false);
	assert.equal(ipcCalls.length, 0);
	delete brokerState.pendingTurns.before;
	assert.equal(await router.retryPendingManualCompactions(), false);
	assert.deepEqual(ipcCalls.map((call) => call.type), ["queue_or_start_compact_session"]);
}

async function checkStopClearsQueuedCompactOperation(): Promise<void> {
	const brokerState = state();
	brokerState.pendingManualCompactions = {
		"compact-existing": { operationId: "compact-existing", sessionId: "session-1", routeId: "123:9", chatId: 123, messageThreadId: 9, status: "queued", createdAtMs: 1, updatedAtMs: 1 },
	};
	brokerState.pendingTurns = {
		blocked: {
			turn: { turnId: "blocked", sessionId: "session-1", routeId: "123:9", chatId: 123, messageThreadId: 9, replyToMessageId: 1, queuedAttachments: [], content: [], historyText: "blocked", blockedByManualCompactionOperationId: "compact-existing" },
			updatedAtMs: 1,
		},
	};
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const postIpc: PostIpcOverride = async <TResponse>(_socketPath: string, type: string) => {
		ipcCalls.push({ type, payload: {} });
		if (type === "abort_turn") return { text: "Suppressed queued work.", clearedTurnIds: [] } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, [], () => 1, undefined, undefined, postIpc);

	await router.dispatch([message("/stop")]);

	assert.deepEqual(sentReplies, ["Suppressed queued work. Cancelled queued compaction."]);
	assert.deepEqual(Object.keys(brokerState.pendingManualCompactions ?? {}), []);
	assert.deepEqual(Object.keys(brokerState.pendingTurns ?? {}), []);
}

async function checkUseSelectorRouteCleansStaleTopicRoute(): Promise<void> {
	const brokerState = state();
	brokerState.pendingManualCompactions = {
		"compact-route": { operationId: "compact-route", sessionId: "session-1", routeId: "123:9", chatId: 123, messageThreadId: 9, status: "queued", createdAtMs: 1, updatedAtMs: 1 },
	};
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, []);

	await router.dispatch([privateMessage("/use 1")]);

	assert.deepEqual(ipcCalls, []);
	assert.ok(sentReplies.some((reply) => /selected/i.test(reply)));
	assert.equal(brokerState.routes["123:9"], undefined);
	assert.ok(brokerState.pendingRouteCleanups?.["123:9"]);
	assert.ok(brokerState.routes["123:default:session-1"]);
	assert.equal(brokerState.pendingManualCompactions?.["compact-route"]?.routeId, "123:default");
	assert.equal(brokerState.pendingManualCompactions?.["compact-route"]?.messageThreadId, undefined);
}

async function checkUseDoesNotCreateSelectorRouteWhenRoutingDisabled(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, [], () => 1, undefined, undefined, undefined, { allowedChatId: 123, topicMode: "disabled", fallbackMode: "disabled" });

	await router.dispatch([privateMessage("/use 1")]);

	assert.deepEqual(ipcCalls, []);
	assert.ok(sentReplies.some((reply) => /routing is disabled/i.test(reply)));
	assert.equal(brokerState.selectorSelections?.["123"], undefined);
	assert.equal(brokerState.routes["123:default:session-1"], undefined);
}

await checkCommandRoutingPreservesCompactStopFollowSteerAndPlainTurns();
await checkFreshCompactWaitsForEarlierPendingTurn();
await checkQueuedCompactPersistsAndCoalescesUntilStarted();
await checkStartedCompactMarksPendingOperationRunning();
await checkRetryReconcilesQueuedAndRunningCompactOperations();
await checkRetryWaitsForEarlierPendingTurnsBeforeManualCompact();
await checkStopClearsQueuedCompactOperation();
await checkUseSelectorRouteCleansStaleTopicRoute();
await checkUseDoesNotCreateSelectorRouteWhenRoutingDisabled();
console.log("Telegram command routing checks passed");
