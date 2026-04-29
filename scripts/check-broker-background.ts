import assert from "node:assert/strict";

import { runBrokerBackgroundTask } from "../src/broker/background.js";
import { AssistantFinalDeliveryLedger } from "../src/broker/finals.js";
import { StaleBrokerError } from "../src/broker/lease.js";
import { createRuntimeUpdateHandlers, type RuntimeUpdateDeps } from "../src/broker/updates.js";
import type { BrokerState, PendingAssistantFinalDelivery, PendingTelegramTurn } from "../src/shared/types.js";
import { now } from "../src/shared/utils.js";
import type { PreviewManager } from "../src/telegram/previews.js";
import { liveLease, runtimeUpdateDeps } from "./support/runtime-update-fixtures.js";

function turn(id: string): PendingTelegramTurn {
	return { turnId: id, sessionId: "s1", chatId: 123, messageThreadId: 9, replyToMessageId: 0, queuedAttachments: [], content: [{ type: "text", text: "hello" }], historyText: "" };
}

function stateWithPendingTurn(): BrokerState {
	return {
		schemaVersion: 1,
		recentUpdateIds: [],
		sessions: {
			s1: {
				sessionId: "s1",
				ownerId: "owner-1",
				pid: process.pid,
				cwd: "/tmp/project",
				projectName: "project",
				status: "idle",
				queuedTurnCount: 1,
				lastHeartbeatMs: now(),
				connectedAtMs: now(),
				connectionStartedAtMs: now(),
				connectionNonce: "conn-1",
				clientSocketPath: "/tmp/client.sock",
				topicName: "project · main",
			},
		},
		routes: { r1: { routeId: "r1", sessionId: "s1", chatId: 123, messageThreadId: 9, routeMode: "forum_supergroup_topic", topicName: "project · main", createdAtMs: now(), updatedAtMs: now() } },
		pendingTurns: { t1: { turn: { ...turn("t1"), routeId: "r1" }, updatedAtMs: now() } },
		pendingAssistantFinals: {},
		completedTurnIds: [],
		createdAtMs: now(),
		updatedAtMs: now(),
	};
}

function depsForState(state: BrokerState, overrides: Partial<RuntimeUpdateDeps>): RuntimeUpdateDeps {
	return runtimeUpdateDeps({ brokerState: state, lease: liveLease(), overrides });
}

async function waitForDetachedWork(): Promise<void> {
	await new Promise((resolveValue) => setImmediate(resolveValue));
	await new Promise((resolveValue) => setImmediate(resolveValue));
}

async function captureUnhandledRejections(run: () => void | Promise<void>): Promise<unknown[]> {
	const unhandled: unknown[] = [];
	const handler = (reason: unknown) => { unhandled.push(reason); };
	process.on("unhandledRejection", handler);
	try {
		await run();
		await waitForDetachedWork();
	} finally {
		process.off("unhandledRejection", handler);
	}
	return unhandled;
}

async function checkPendingTurnRetryStalePersistStandsDownWithoutUnhandledRejection(): Promise<void> {
	const state = stateWithPendingTurn();
	let stopCalls = 0;
	let persistCalls = 0;
	const logs: string[] = [];
	const handlers = createRuntimeUpdateHandlers(depsForState(state, {
		postIpc: async <TResponse>() => ({ ok: true }) as TResponse,
		persistBrokerState: async () => {
			persistCalls += 1;
			throw new StaleBrokerError();
		},
	}));

	const unhandled = await captureUnhandledRejections(() => {
		runBrokerBackgroundTask("pending turn retry", () => handlers.retryPendingTurns(), {
			stopBroker: async () => { stopCalls += 1; },
			log: (message) => { logs.push(message); },
		});
	});

	assert.equal(persistCalls, 1);
	assert.equal(stopCalls, 1);
	assert.deepEqual(unhandled, []);
	assert.deepEqual(logs, []);
	assert.ok(state.pendingTurns?.t1, "stale broker must not delete durable pending turns in memory before a successful persist");
}

async function checkNonStaleBackgroundErrorIsLoggedButDoesNotStandDown(): Promise<void> {
	let stopCalls = 0;
	const logs: string[] = [];
	const unhandled = await captureUnhandledRejections(() => {
		runBrokerBackgroundTask("ordinary maintenance", async () => { throw new Error("disk full"); }, {
			stopBroker: async () => { stopCalls += 1; },
			log: (message) => { logs.push(message); },
		});
	});
	assert.equal(stopCalls, 0);
	assert.deepEqual(unhandled, []);
	assert.equal(logs.length, 1);
	assert.match(logs[0]!, /ordinary maintenance failed: disk full/);
}

function finalEntry(id: string): PendingAssistantFinalDelivery {
	return {
		turn: turn(id),
		text: "done",
		attachments: [],
		status: "pending",
		createdAtMs: now(),
		updatedAtMs: now(),
		progress: { activityCompleted: true, typingStopped: true, previewDetached: true, sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] },
	};
}

async function checkAssistantFinalKickStalePersistSettlesWithoutUnhandledRejection(): Promise<void> {
	const state = stateWithPendingTurn();
	state.pendingAssistantFinals = { t1: finalEntry("t1") };
	let persistCalls = 0;
	const ledger = new AssistantFinalDeliveryLedger({
		getBrokerState: () => state,
		setBrokerState: () => undefined,
		loadBrokerState: async () => state,
		persistBrokerState: async () => {
			persistCalls += 1;
			throw new StaleBrokerError();
		},
		activityComplete: async () => undefined,
		stopTypingLoop: () => undefined,
		previewManager: { clear: async () => undefined, detachForFinal: async () => undefined } as unknown as PreviewManager,
		callTelegram: async <TResponse>() => ({ message_id: 1 }) as TResponse,
		callTelegramMultipart: async <TResponse>() => ({ message_id: 1 }) as TResponse,
		isBrokerActive: () => true,
		rememberCompletedBrokerTurn: async () => undefined,
		logTerminalFailure: () => undefined,
	});

	const unhandled = await captureUnhandledRejections(() => {
		ledger.kick();
	});
	ledger.kick();
	await waitForDetachedWork();

	assert.equal(persistCalls, 1);
	assert.deepEqual(unhandled, []);
	assert.ok(state.pendingAssistantFinals?.t1, "stale broker must leave final delivery durable for the next broker");
}

await checkPendingTurnRetryStalePersistStandsDownWithoutUnhandledRejection();
await checkNonStaleBackgroundErrorIsLoggedButDoesNotStandDown();
await checkAssistantFinalKickStalePersistSettlesWithoutUnhandledRejection();
console.log("Broker background stale-lease checks passed");
