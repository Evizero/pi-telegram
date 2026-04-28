import assert from "node:assert/strict";

import { ManualCompactionTurnQueue } from "../src/client/manual-compaction.js";
import { clientStatusText } from "../src/client/info.js";
import { collectSessionRegistration } from "../src/client/session-registration.js";
import { registerRuntimePiHooks } from "../src/pi/hooks.js";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ActiveTelegramTurn, PendingTelegramTurn, TelegramRoute } from "../src/shared/types.js";

function turn(id: string, deliveryMode?: PendingTelegramTurn["deliveryMode"]): PendingTelegramTurn {
	return {
		turnId: id,
		sessionId: "session-1",
		chatId: 123,
		messageThreadId: 9,
		replyToMessageId: 0,
		queuedAttachments: [],
		content: [{ type: "text", text: id }],
		historyText: id,
		deliveryMode,
	};
}

async function checkFinishStartsFirstDeferredTurnAndDrainsRemainder(): Promise<void> {
	let queuedTurns = [turn("first"), turn("second"), turn("third", "followUp")];
	let activeTurn: ActiveTelegramTurn | undefined;
	const sent: Array<{ text: string; deliverAs?: "steer" | "followUp" }> = [];
	const started: string[] = [];
	const consumed: string[] = [];
	const queue = new ManualCompactionTurnQueue({
		getQueuedTelegramTurns: () => queuedTurns,
		setQueuedTelegramTurns: (turns) => { queuedTurns = turns; },
		getActiveTelegramTurn: () => activeTurn,
		hasAwaitingTelegramFinalTurn: () => false,
		setActiveTelegramTurn: (turn) => { activeTurn = turn; },
		prepareTurnAbort: () => { started.push("prepare-abort"); },
		postTurnStarted: (turnId) => { started.push(turnId); },
		sendUserMessage: (content, options) => {
			const text = content.find((item) => item.type === "text");
			assert.equal(text?.type, "text");
			sent.push({ text: text.text, deliverAs: options?.deliverAs });
		},
		acknowledgeConsumedTurn: (turnId) => { consumed.push(turnId); },
	});

	queue.start();
	queue.finish();
	assert.equal(activeTurn?.turnId, "first");
	assert.deepEqual(started, ["prepare-abort", "first"]);
	assert.deepEqual(sent, [{ text: "first", deliverAs: undefined }]);
	assert.deepEqual(queuedTurns, []);
	assert.deepEqual(consumed, []);

	queue.drainDeferredIntoActiveTurn();
	assert.deepEqual(sent, [
		{ text: "first", deliverAs: undefined },
		{ text: "second", deliverAs: "followUp" },
		{ text: "third", deliverAs: "followUp" },
	]);
	assert.deepEqual(consumed, ["second", "third"]);
}

function idleCtx(): ExtensionContext {
	return {
		cwd: process.cwd(),
		isIdle: () => true,
		sessionManager: { getEntries: () => [] },
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => undefined,
	} as unknown as ExtensionContext;
}

async function checkFollowOnlyStillStartsNextTurn(): Promise<void> {
	let queuedTurns = [turn("follow-only", "followUp")];
	let activeTurn: ActiveTelegramTurn | undefined;
	const sent: Array<{ text: string; deliverAs?: "steer" | "followUp" }> = [];
	const queue = new ManualCompactionTurnQueue({
		getQueuedTelegramTurns: () => queuedTurns,
		setQueuedTelegramTurns: (turns) => { queuedTurns = turns; },
		getActiveTelegramTurn: () => activeTurn,
		hasAwaitingTelegramFinalTurn: () => false,
		setActiveTelegramTurn: (turn) => { activeTurn = turn; },
		prepareTurnAbort: () => undefined,
		postTurnStarted: () => undefined,
		sendUserMessage: (content, options) => {
			const text = content.find((item) => item.type === "text");
			assert.equal(text?.type, "text");
			sent.push({ text: text.text, deliverAs: options?.deliverAs });
		},
		acknowledgeConsumedTurn: () => undefined,
	});

	queue.start();
	queue.finish();
	assert.equal(activeTurn?.turnId, "follow-only");
	assert.deepEqual(sent, [{ text: "follow-only", deliverAs: "followUp" }]);
	assert.deepEqual(queuedTurns, []);
}

async function checkRepeatedManualCompactionWaitsForFinalFinish(): Promise<void> {
	let queuedTurns = [turn("deferred")];
	let activeTurn: ActiveTelegramTurn | undefined;
	const sent: string[] = [];
	const queue = new ManualCompactionTurnQueue({
		getQueuedTelegramTurns: () => queuedTurns,
		setQueuedTelegramTurns: (turns) => { queuedTurns = turns; },
		getActiveTelegramTurn: () => activeTurn,
		hasAwaitingTelegramFinalTurn: () => false,
		setActiveTelegramTurn: (turn) => { activeTurn = turn; },
		prepareTurnAbort: () => undefined,
		postTurnStarted: () => undefined,
		sendUserMessage: (content) => {
			const text = content.find((item) => item.type === "text");
			assert.equal(text?.type, "text");
			sent.push(text.text);
		},
		acknowledgeConsumedTurn: () => undefined,
	});

	queue.start();
	queue.start();
	queue.finish();
	assert.equal(activeTurn?.turnId, undefined);
	assert.deepEqual(sent, []);
	queue.finish();
	assert.equal(activeTurn?.turnId, "deferred");
	assert.deepEqual(sent, ["deferred"]);
}

async function checkCancelDeferredStartPreventsBoundaryQueueing(): Promise<void> {
	let queuedTurns = [turn("first"), turn("second")];
	let activeTurn: ActiveTelegramTurn | undefined;
	const queue = new ManualCompactionTurnQueue({
		getQueuedTelegramTurns: () => queuedTurns,
		setQueuedTelegramTurns: (turns) => { queuedTurns = turns; },
		getActiveTelegramTurn: () => activeTurn,
		hasAwaitingTelegramFinalTurn: () => false,
		setActiveTelegramTurn: (turn) => { activeTurn = turn; },
		prepareTurnAbort: () => undefined,
		postTurnStarted: () => undefined,
		sendUserMessage: () => undefined,
		acknowledgeConsumedTurn: () => undefined,
	});

	queue.start();
	queue.finish();
	queue.cancelDeferredStart();
	assert.equal(queue.enqueueDeferredTurn(turn("late")), false);
}

async function checkDeferredTurnLookupIncludesPendingRemainder(): Promise<void> {
	let queuedTurns = [turn("first"), turn("second")];
	let activeTurn: ActiveTelegramTurn | undefined;
	const queue = new ManualCompactionTurnQueue({
		getQueuedTelegramTurns: () => queuedTurns,
		setQueuedTelegramTurns: (turns) => { queuedTurns = turns; },
		getActiveTelegramTurn: () => activeTurn,
		hasAwaitingTelegramFinalTurn: () => false,
		setActiveTelegramTurn: (turn) => { activeTurn = turn; },
		prepareTurnAbort: () => undefined,
		postTurnStarted: () => undefined,
		sendUserMessage: () => undefined,
		acknowledgeConsumedTurn: () => undefined,
	});

	queue.start();
	queue.finish();
	assert.equal(queue.hasDeferredTurn("second"), true);
	assert.equal(queue.hasDeferredTurn("missing"), false);
	assert.equal(queue.enqueueDeferredTurn(turn("third")), true);
	assert.equal(queue.hasDeferredTurn("third"), true);
	queue.drainDeferredIntoActiveTurn();
	assert.equal(queue.hasDeferredTurn("second"), false);
	assert.equal(queue.enqueueDeferredTurn(turn("late")), false);
}

async function checkAwaitingFinalPreventsDeferredTurnStart(): Promise<void> {
	let queuedTurns = [turn("first")];
	let activeTurn: ActiveTelegramTurn | undefined;
	const queue = new ManualCompactionTurnQueue({
		getQueuedTelegramTurns: () => queuedTurns,
		setQueuedTelegramTurns: (turns) => { queuedTurns = turns; },
		getActiveTelegramTurn: () => activeTurn,
		hasAwaitingTelegramFinalTurn: () => true,
		setActiveTelegramTurn: (turn) => { activeTurn = turn; },
		prepareTurnAbort: () => undefined,
		postTurnStarted: () => undefined,
		sendUserMessage: () => undefined,
		acknowledgeConsumedTurn: () => undefined,
	});

	queue.start();
	queue.finish();
	assert.equal(activeTurn, undefined);
	assert.equal(queuedTurns.length, 1);
}

async function checkAgentStartHookDrainsDeferredCompactionTurns(): Promise<void> {
	const eventHandlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const pi = {
		registerTool: () => undefined,
		registerCommand: () => undefined,
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	let drained = 0;
	let statusUpdates = 0;
	let currentAbort: (() => void) | undefined;
	registerRuntimePiHooks(pi, {
		getConfig: () => ({}),
		setLatestCtx: () => undefined,
		getConnectedRoute: () => undefined,
		setConnectedRoute: () => undefined,
		getActiveTelegramTurn: () => undefined,
		hasDeferredTelegramTurn: () => false,
		hasAwaitingTelegramFinalTurn: () => false,
		hasLiveAgentRun: () => false,
		flushDeferredTelegramTurn: async () => undefined,
		setActiveTelegramTurn: () => undefined,
		setQueuedTelegramTurns: () => undefined,
		setCurrentAbort: (abort) => { currentAbort = abort; },
		getSessionId: () => "session-1",
		getOwnerId: () => "owner-1",
		getIsBroker: () => false,
		getBrokerState: () => undefined,
		getConnectedBrokerSocketPath: () => "/tmp/broker.sock",
		activityReporter: { post: () => undefined, flush: async () => undefined } as never,
		isRoutableRoute: (_route): _route is TelegramRoute => false,
		resolveAllowedAttachmentPath: async () => undefined,
		postIpc: async <TResponse>() => undefined as TResponse,
		promptForConfig: async () => false,
		connectTelegram: async () => undefined,
		unregisterSession: async () => undefined,
		markSessionOffline: async () => undefined,
		disconnectSessionRoute: async () => undefined,
		prepareSessionReplacementHandoff: async () => false,
		stopClientServer: async () => undefined,
		shutdownClientRoute: () => undefined,
		stopBroker: async () => undefined,
		hideTelegramStatus: () => undefined,
		updateStatus: () => { statusUpdates += 1; },
		readLease: async () => undefined,
		sendAssistantFinalToBroker: async () => true,
		finalizeActiveTelegramTurn: async () => "completed",
		onAgentRetryStart: () => undefined,
		onRetryMessageStart: () => undefined,
		startNextTelegramTurn: () => undefined,
		drainDeferredCompactionTurns: () => { drained += 1; },
		onSessionStart: async () => undefined,
		clearMediaGroups: () => undefined,
	});

	const ctx = { abort: () => undefined } as unknown as ExtensionContext;
	const agentStartHandlers = eventHandlers.get("agent_start") ?? [];
	assert.equal(agentStartHandlers.length > 0, true);
	await agentStartHandlers[0]!({}, ctx);
	assert.equal(drained, 1);
	assert.equal(statusUpdates, 1);
	assert.ok(currentAbort);
}

async function checkStatusAndRegistrationTreatManualCompactionAsBusy(): Promise<void> {
	const ctx = idleCtx();
	const statusText = clientStatusText({
		ctx,
		connectedRoute: undefined,
		queuedTurnCount: 0,
		manualCompactionInProgress: true,
	});
	assert.match(statusText, /State: busy/);

	const registration = await collectSessionRegistration({
		ctx,
		sessionId: "session-1",
		ownerId: "owner-1",
		startedAtMs: 1,
		connectionStartedAtMs: 2,
		connectionNonce: "conn-1",
		clientSocketPath: "/tmp/client.sock",
		queuedTelegramTurns: [],
		manualCompactionInProgress: true,
	});
	assert.equal(registration.status, "busy");
}

await checkFinishStartsFirstDeferredTurnAndDrainsRemainder();
await checkFollowOnlyStillStartsNextTurn();
await checkRepeatedManualCompactionWaitsForFinalFinish();
await checkCancelDeferredStartPreventsBoundaryQueueing();
await checkDeferredTurnLookupIncludesPendingRemainder();
await checkAwaitingFinalPreventsDeferredTurnStart();
await checkAgentStartHookDrainsDeferredCompactionTurns();
await checkStatusAndRegistrationTreatManualCompactionAsBusy();
console.log("Manual compaction queue checks passed");
