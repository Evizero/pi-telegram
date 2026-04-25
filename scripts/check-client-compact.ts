import assert from "node:assert/strict";

import { clientCompactSession } from "../src/client/compact.js";
import type { PendingTelegramTurn, QueuedAttachment, TelegramRoute } from "../src/shared/types.js";

interface CompactCallbacks {
	onComplete?: () => void;
	onError?: (error: unknown) => void;
}

function route(): TelegramRoute {
	return {
		routeId: "123:9",
		sessionId: "session-1",
		chatId: 123,
		messageThreadId: 9,
		routeMode: "forum_supergroup_topic",
		topicName: "project · main",
		createdAtMs: 1,
		updatedAtMs: 1,
	};
}

function isRoutableRoute(candidate: TelegramRoute | undefined): candidate is TelegramRoute {
	return candidate !== undefined && candidate.chatId !== 0 && String(candidate.chatId) !== "0";
}

async function checkBusyCompactInvokesPiManualCompaction(): Promise<void> {
	let compactCallbacks: CompactCallbacks | undefined;
	let starts = 0;
	let settled = 0;
	const finals: Array<{ turn: PendingTelegramTurn; text?: string; attachments: QueuedAttachment[] }> = [];
	const result = clientCompactSession({
		ctx: {
			compact: (options?: CompactCallbacks) => {
				compactCallbacks = options;
			},
		},
		sessionId: "session-1",
		getConnectedRoute: route,
		isRoutableRoute,
		sendAssistantFinalToBroker: async (payload) => {
			finals.push(payload);
			return true;
		},
		createTurnId: () => "cmd-1",
		formatError: (error) => error instanceof Error ? error.message : String(error),
		onStart: () => { starts += 1; },
		onSettled: () => { settled += 1; },
	});

	assert.deepEqual(result, { text: "Compaction started." });
	assert.equal(starts, 1);
	assert.equal(settled, 0);
	assert.ok(compactCallbacks, "expected compact() to be called without checking idle state first");
	compactCallbacks.onComplete?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, 1);
	assert.equal(finals.length, 1);
	assert.equal(finals[0]?.text, "Compaction completed.");
	assert.equal(finals[0]?.turn.turnId, "cmd-1");
	assert.equal(finals[0]?.turn.sessionId, "session-1");
	assert.equal(finals[0]?.turn.chatId, 123);
	assert.equal(finals[0]?.turn.messageThreadId, 9);
}

async function checkCompactFailureReportsToOriginalRoute(): Promise<void> {
	let compactCallbacks: CompactCallbacks | undefined;
	let settled = 0;
	let currentRoute = route();
	const finals: Array<{ turn: PendingTelegramTurn; text?: string; attachments: QueuedAttachment[] }> = [];
	clientCompactSession({
		ctx: {
			compact: (options?: CompactCallbacks) => {
				compactCallbacks = options;
			},
		},
		sessionId: "session-1",
		getConnectedRoute: () => currentRoute,
		isRoutableRoute,
		sendAssistantFinalToBroker: async (payload) => {
			finals.push(payload);
			return true;
		},
		createTurnId: () => "cmd-2",
		formatError: (error) => error instanceof Error ? error.message : String(error),
		onSettled: () => { settled += 1; },
	});

	currentRoute = { ...route(), messageThreadId: 10 };
	compactCallbacks?.onError?.(new Error("summary failed"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, 1);
	assert.equal(finals.length, 1);
	assert.equal(finals[0]?.text, "Compaction failed: summary failed");
	assert.equal(finals[0]?.turn.messageThreadId, 9);
}

async function checkRepeatedCompactOnlySettlesAfterBothCallbacks(): Promise<void> {
	let firstCallbacks: CompactCallbacks | undefined;
	let secondCallbacks: CompactCallbacks | undefined;
	let starts = 0;
	let settled = 0;
	const finals: string[] = [];
	const resultOne = clientCompactSession({
		ctx: {
			compact: (options?: CompactCallbacks) => {
				firstCallbacks = options;
			},
		},
		sessionId: "session-1",
		getConnectedRoute: route,
		isRoutableRoute,
		sendAssistantFinalToBroker: async (payload) => {
			if (payload.text) finals.push(payload.text);
			return true;
		},
		createTurnId: () => "cmd-repeat-1",
		formatError: (error) => error instanceof Error ? error.message : String(error),
		onStart: () => { starts += 1; },
			onSettled: () => { settled += 1; },
	});
	const resultTwo = clientCompactSession({
		ctx: {
			compact: (options?: CompactCallbacks) => {
				secondCallbacks = options;
			},
		},
		sessionId: "session-1",
		getConnectedRoute: route,
		isRoutableRoute,
		sendAssistantFinalToBroker: async (payload) => {
			if (payload.text) finals.push(payload.text);
			return true;
		},
		createTurnId: () => "cmd-repeat-2",
		formatError: (error) => error instanceof Error ? error.message : String(error),
		onStart: () => { starts += 1; },
		onSettled: () => { settled += 1; },
	});

	assert.deepEqual(resultOne, { text: "Compaction started." });
	assert.deepEqual(resultTwo, { text: "Compaction started." });
	assert.equal(starts, 2);
	assert.equal(settled, 0);
	firstCallbacks?.onComplete?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, 1);
	secondCallbacks?.onError?.(new Error("still running"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, 2);
	assert.deepEqual(finals, ["Compaction completed.", "Compaction failed: still running"]);
}

async function checkSynchronousCompactFailureUnwindsState(): Promise<void> {
	let starts = 0;
	let settled = 0;
	const result = clientCompactSession({
		ctx: {
			compact: () => {
				throw new Error("sync boom");
			},
		},
		sessionId: "session-1",
		getConnectedRoute: route,
		isRoutableRoute,
		sendAssistantFinalToBroker: async () => true,
		createTurnId: () => "cmd-sync",
		formatError: (error) => error instanceof Error ? error.message : String(error),
		onStart: () => { starts += 1; },
		onSettled: () => { settled += 1; },
	});

	assert.deepEqual(result, { text: "Compaction failed: sync boom" });
	assert.equal(starts, 1);
	assert.equal(settled, 1);
}

async function checkCompactWithoutRouteStillStarts(): Promise<void> {
	let compactCalled = false;
	let finals = 0;
	const result = clientCompactSession({
		ctx: {
			compact: (options?: CompactCallbacks) => {
				compactCalled = true;
				options?.onComplete?.();
			},
		},
		sessionId: "session-1",
		getConnectedRoute: () => undefined,
		isRoutableRoute,
		sendAssistantFinalToBroker: async () => {
			finals += 1;
			return true;
		},
		createTurnId: () => "cmd-3",
		formatError: String,
	});

	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(result, { text: "Compaction started." });
	assert.equal(compactCalled, true);
	assert.equal(finals, 0);
}

async function checkUnavailableContextDoesNotStartCompact(): Promise<void> {
	const result = clientCompactSession({
		ctx: undefined,
		sessionId: "session-1",
		getConnectedRoute: route,
		isRoutableRoute,
		sendAssistantFinalToBroker: async () => true,
		createTurnId: () => "cmd-4",
		formatError: String,
	});

	assert.deepEqual(result, { text: "Session context unavailable." });
}

await checkBusyCompactInvokesPiManualCompaction();
await checkCompactFailureReportsToOriginalRoute();
await checkRepeatedCompactOnlySettlesAfterBothCallbacks();
await checkSynchronousCompactFailureUnwindsState();
await checkCompactWithoutRouteStillStarts();
await checkUnavailableContextDoesNotStartCompact();
console.log("Client compact checks passed");
