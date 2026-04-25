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
	});

	assert.deepEqual(result, { text: "Compaction started." });
	assert.ok(compactCallbacks, "expected compact() to be called without checking idle state first");
	compactCallbacks.onComplete?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(finals.length, 1);
	assert.equal(finals[0]?.text, "Compaction completed.");
	assert.equal(finals[0]?.turn.turnId, "cmd-1");
	assert.equal(finals[0]?.turn.sessionId, "session-1");
	assert.equal(finals[0]?.turn.chatId, 123);
	assert.equal(finals[0]?.turn.messageThreadId, 9);
}

async function checkCompactFailureReportsToOriginalRoute(): Promise<void> {
	let compactCallbacks: CompactCallbacks | undefined;
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
	});

	currentRoute = { ...route(), messageThreadId: 10 };
	compactCallbacks?.onError?.(new Error("summary failed"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(finals.length, 1);
	assert.equal(finals[0]?.text, "Compaction failed: summary failed");
	assert.equal(finals[0]?.turn.messageThreadId, 9);
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
await checkCompactWithoutRouteStillStarts();
await checkUnavailableContextDoesNotStartCompact();
console.log("Client compact checks passed");
