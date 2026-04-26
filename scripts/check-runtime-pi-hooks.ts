import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { registerRuntimePiHooks } from "../src/pi/hooks.js";
import type { ActiveTelegramTurn, PendingTelegramTurn, TelegramRoute } from "../src/shared/types.js";

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

function route(): TelegramRoute {
	return {
		routeId: "123:9",
		sessionId: "session-1",
		chatId: 123,
		messageThreadId: 9,
		routeMode: "forum_supergroup_topic",
		topicName: "topic",
		createdAtMs: 1,
		updatedAtMs: 1,
	};
}

function buildPiHarness(): {
	handlers: Map<string, Array<(event: any, ctx?: ExtensionContext) => Promise<unknown>>>;
	tools: any[];
	pi: ExtensionAPI;
} {
	const handlers = new Map<string, Array<(event: any, ctx?: ExtensionContext) => Promise<unknown>>>();
	const tools: any[] = [];
	const pi = {
		registerTool: (tool: any) => { tools.push(tool); },
		registerCommand: () => undefined,
		on: (event: string, handler: (event: any, ctx?: ExtensionContext) => Promise<unknown>) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	return { handlers, tools, pi };
}

async function checkDeferredAgentEndClearsAbortCallback(): Promise<void> {
	const { handlers, pi } = buildPiHarness();
	let active: ActiveTelegramTurn | undefined = activeTurn();
	let currentAbort: (() => void) | undefined;
	let startNextCalls = 0;
	registerRuntimePiHooks(pi, {
		getConfig: () => ({}),
		setLatestCtx: () => undefined,
		getConnectedRoute: () => route(),
		setConnectedRoute: () => undefined,
		getActiveTelegramTurn: () => active,
		hasDeferredTelegramTurn: () => false,
		hasAwaitingTelegramFinalTurn: () => false,
		hasLiveAgentRun: () => false,
		flushDeferredTelegramTurn: async () => undefined,
		setActiveTelegramTurn: (turn) => { active = turn; },
		setQueuedTelegramTurns: () => undefined,
		setCurrentAbort: (abort) => { currentAbort = abort; },
		getSessionId: () => "session-1",
		getOwnerId: () => "owner-1",
		getIsBroker: () => false,
		getBrokerState: () => undefined,
		getConnectedBrokerSocketPath: () => "/tmp/broker.sock",
		activityReporter: { post: () => undefined, flush: async () => undefined } as never,
		isRoutableRoute: (candidate): candidate is TelegramRoute => Boolean(candidate),
		resolveAllowedAttachmentPath: async () => undefined,
		postIpc: async <TResponse>() => undefined as TResponse,
		promptForConfig: async () => false,
		connectTelegram: async () => undefined,
		unregisterSession: async () => undefined,
		markSessionOffline: async () => undefined,
		disconnectSessionRoute: async () => undefined,
		stopClientServer: async () => undefined,
		shutdownClientRoute: () => undefined,
		stopBroker: async () => undefined,
		hideTelegramStatus: () => undefined,
		updateStatus: () => undefined,
		readLease: async () => undefined,
		sendAssistantFinalToBroker: async () => true,
		finalizeActiveTelegramTurn: async () => "deferred",
		onAgentRetryStart: () => undefined,
		onRetryMessageStart: () => undefined,
		startNextTelegramTurn: () => { startNextCalls += 1; },
		drainDeferredCompactionTurns: () => undefined,
		onSessionStart: async () => undefined,
		clearMediaGroups: () => undefined,
	});

	const ctx = { abort: () => undefined, ui: { theme: {} } } as unknown as ExtensionContext;
	await (handlers.get("agent_start")?.[0]?.({}, ctx) ?? Promise.resolve());
	assert.ok(currentAbort);
	await (handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx) ?? Promise.resolve());
	assert.equal(currentAbort, undefined);
	assert.equal(startNextCalls, 0);
}

async function checkLocalInputFlushesDeferredWithoutStartingQueuedTelegramTurn(): Promise<void> {
	const { handlers, pi } = buildPiHarness();
	let active: ActiveTelegramTurn | undefined;
	let flushedOptions: { startNext?: boolean } | undefined;
	const localMessages: Array<{ text: string; imagesCount?: number; routeId?: string; chatId?: number | string; messageThreadId?: number }> = [];
	registerRuntimePiHooks(pi, {
		getConfig: () => ({}),
		setLatestCtx: () => undefined,
		getConnectedRoute: () => route(),
		setConnectedRoute: () => undefined,
		getActiveTelegramTurn: () => active,
		hasDeferredTelegramTurn: () => true,
		hasAwaitingTelegramFinalTurn: () => false,
		hasLiveAgentRun: () => false,
		flushDeferredTelegramTurn: async (options) => {
			flushedOptions = options;
			return "turn-1";
		},
		setActiveTelegramTurn: (turn) => { active = turn; },
		setQueuedTelegramTurns: () => undefined,
		setCurrentAbort: () => undefined,
		getSessionId: () => "session-1",
		getOwnerId: () => "owner-1",
		getIsBroker: () => false,
		getBrokerState: () => undefined,
		getConnectedBrokerSocketPath: () => "/tmp/broker.sock",
		activityReporter: { post: () => undefined, flush: async () => undefined } as never,
		isRoutableRoute: (candidate): candidate is TelegramRoute => Boolean(candidate),
		resolveAllowedAttachmentPath: async () => undefined,
		postIpc: async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
			if (type === "local_user_message") localMessages.push(payload as { text: string; imagesCount?: number; routeId?: string; chatId?: number | string; messageThreadId?: number });
			return undefined as TResponse;
		},
		promptForConfig: async () => false,
		connectTelegram: async () => undefined,
		unregisterSession: async () => undefined,
		markSessionOffline: async () => undefined,
		disconnectSessionRoute: async () => undefined,
		stopClientServer: async () => undefined,
		shutdownClientRoute: () => undefined,
		stopBroker: async () => undefined,
		hideTelegramStatus: () => undefined,
		updateStatus: () => undefined,
		readLease: async () => undefined,
		sendAssistantFinalToBroker: async () => true,
		finalizeActiveTelegramTurn: async () => "completed",
		onAgentRetryStart: () => undefined,
		onRetryMessageStart: () => undefined,
		startNextTelegramTurn: () => { throw new Error("input flush should not start next Telegram turn directly"); },
		drainDeferredCompactionTurns: () => undefined,
		onSessionStart: async () => undefined,
		clearMediaGroups: () => undefined,
	});

	await (handlers.get("input")?.[0]?.({ source: "interactive", text: "local follow-up", images: [] }) ?? Promise.resolve());
	assert.deepEqual(flushedOptions, { startNext: false });
	assert.deepEqual(localMessages, [{ text: "local follow-up", imagesCount: 0, routeId: "123:9", chatId: 123, messageThreadId: 9 }]);
	assert.equal(active?.historyText, "local follow-up");
}

async function checkLocalInputDuringLiveRetryDoesNotFlushDeferredTurn(): Promise<void> {
	const { handlers, pi } = buildPiHarness();
	let active: ActiveTelegramTurn | undefined = activeTurn("retrying");
	let flushedOptions: { startNext?: boolean } | undefined;
	registerRuntimePiHooks(pi, {
		getConfig: () => ({}),
		setLatestCtx: () => undefined,
		getConnectedRoute: () => route(),
		setConnectedRoute: () => undefined,
		getActiveTelegramTurn: () => active,
		hasDeferredTelegramTurn: () => true,
		hasAwaitingTelegramFinalTurn: () => false,
		hasLiveAgentRun: () => true,
		flushDeferredTelegramTurn: async (options) => {
			flushedOptions = options;
			return "turn-1";
		},
		setActiveTelegramTurn: (turn) => { active = turn; },
		setQueuedTelegramTurns: () => undefined,
		setCurrentAbort: () => undefined,
		getSessionId: () => "session-1",
		getOwnerId: () => "owner-1",
		getIsBroker: () => false,
		getBrokerState: () => undefined,
		getConnectedBrokerSocketPath: () => "/tmp/broker.sock",
		activityReporter: { post: () => undefined, flush: async () => undefined } as never,
		isRoutableRoute: (candidate): candidate is TelegramRoute => Boolean(candidate),
		resolveAllowedAttachmentPath: async () => undefined,
		postIpc: async <TResponse>() => undefined as TResponse,
		promptForConfig: async () => false,
		connectTelegram: async () => undefined,
		unregisterSession: async () => undefined,
		markSessionOffline: async () => undefined,
		disconnectSessionRoute: async () => undefined,
		stopClientServer: async () => undefined,
		shutdownClientRoute: () => undefined,
		stopBroker: async () => undefined,
		hideTelegramStatus: () => undefined,
		updateStatus: () => undefined,
		readLease: async () => undefined,
		sendAssistantFinalToBroker: async () => true,
		finalizeActiveTelegramTurn: async () => "completed",
		onAgentRetryStart: () => undefined,
		onRetryMessageStart: () => undefined,
		startNextTelegramTurn: () => { throw new Error("live retry flush should not start next Telegram turn directly"); },
		drainDeferredCompactionTurns: () => undefined,
		onSessionStart: async () => undefined,
		clearMediaGroups: () => undefined,
	});

	await (handlers.get("input")?.[0]?.({ source: "interactive", text: "local takeover", images: [] }) ?? Promise.resolve());
	assert.equal(flushedOptions, undefined);
	assert.equal(active?.turnId, "retrying");
}

async function checkTelegramAttachIsAtomicOnValidationFailure(): Promise<void> {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-telegram-hook-check-"));
	try {
		const goodPath = join(tempDir, "good.txt");
		writeFileSync(goodPath, "ok");
		const { tools, pi } = buildPiHarness();
		let active: ActiveTelegramTurn | undefined = activeTurn("attach-turn");
		registerRuntimePiHooks(pi, {
			getConfig: () => ({}),
			setLatestCtx: () => undefined,
			getConnectedRoute: () => route(),
			setConnectedRoute: () => undefined,
			getActiveTelegramTurn: () => active,
			hasDeferredTelegramTurn: () => false,
			hasAwaitingTelegramFinalTurn: () => false,
			hasLiveAgentRun: () => false,
			flushDeferredTelegramTurn: async () => undefined,
			setActiveTelegramTurn: (turn) => { active = turn; },
			setQueuedTelegramTurns: () => undefined,
			setCurrentAbort: () => undefined,
			getSessionId: () => "session-1",
			getOwnerId: () => "owner-1",
			getIsBroker: () => false,
			getBrokerState: () => undefined,
			getConnectedBrokerSocketPath: () => "/tmp/broker.sock",
			activityReporter: { post: () => undefined, flush: async () => undefined } as never,
			isRoutableRoute: (candidate): candidate is TelegramRoute => Boolean(candidate),
			resolveAllowedAttachmentPath: async (inputPath) => inputPath === goodPath ? goodPath : undefined,
			postIpc: async <TResponse>() => undefined as TResponse,
			promptForConfig: async () => false,
			connectTelegram: async () => undefined,
			unregisterSession: async () => undefined,
			markSessionOffline: async () => undefined,
			disconnectSessionRoute: async () => undefined,
			stopClientServer: async () => undefined,
			shutdownClientRoute: () => undefined,
			stopBroker: async () => undefined,
			hideTelegramStatus: () => undefined,
			updateStatus: () => undefined,
			readLease: async () => undefined,
			sendAssistantFinalToBroker: async () => true,
			finalizeActiveTelegramTurn: async () => "completed",
			onAgentRetryStart: () => undefined,
			onRetryMessageStart: () => undefined,
			startNextTelegramTurn: () => undefined,
			drainDeferredCompactionTurns: () => undefined,
			onSessionStart: async () => undefined,
			clearMediaGroups: () => undefined,
		});
		const attachTool = tools.find((tool) => tool.name === "telegram_attach");
		assert.ok(attachTool);
		await assert.rejects(() => attachTool.execute("call-1", { paths: [goodPath, join(tempDir, "missing.txt")] }), /Attachment path is not allowed/);
		assert.deepEqual(active?.queuedAttachments ?? [], []);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

async function checkSessionShutdownLetsRouteTeardownOwnQueueDrainingAndStillStopsBroker(): Promise<void> {
	const { handlers, pi } = buildPiHarness();
	let clearedMediaGroups = 0;
	let setQueuedCalls = 0;
	let disconnectCalls = 0;
	let stopBrokerCalls = 0;
	registerRuntimePiHooks(pi, {
		getConfig: () => ({}),
		setLatestCtx: () => undefined,
		getConnectedRoute: () => route(),
		setConnectedRoute: () => undefined,
		getActiveTelegramTurn: () => undefined,
		hasDeferredTelegramTurn: () => false,
		hasAwaitingTelegramFinalTurn: () => false,
		hasLiveAgentRun: () => false,
		flushDeferredTelegramTurn: async () => undefined,
		setActiveTelegramTurn: () => undefined,
		setQueuedTelegramTurns: () => { setQueuedCalls += 1; },
		setCurrentAbort: () => undefined,
		getSessionId: () => "session-1",
		getOwnerId: () => "owner-1",
		getIsBroker: () => false,
		getBrokerState: () => undefined,
		getConnectedBrokerSocketPath: () => "/tmp/broker.sock",
		activityReporter: { post: () => undefined, flush: async () => undefined } as never,
		isRoutableRoute: (candidate): candidate is TelegramRoute => Boolean(candidate),
		resolveAllowedAttachmentPath: async () => undefined,
		postIpc: async <TResponse>() => undefined as TResponse,
		promptForConfig: async () => false,
		connectTelegram: async () => undefined,
		unregisterSession: async () => undefined,
		markSessionOffline: async () => undefined,
		disconnectSessionRoute: async () => {
			disconnectCalls += 1;
			throw new Error("disconnect failed");
		},
		stopClientServer: async () => undefined,
		shutdownClientRoute: () => undefined,
		stopBroker: async () => { stopBrokerCalls += 1; },
		hideTelegramStatus: () => undefined,
		updateStatus: () => undefined,
		readLease: async () => undefined,
		sendAssistantFinalToBroker: async () => true,
		finalizeActiveTelegramTurn: async () => "completed",
		onAgentRetryStart: () => undefined,
		onRetryMessageStart: () => undefined,
		startNextTelegramTurn: () => undefined,
		drainDeferredCompactionTurns: () => undefined,
		onSessionStart: async () => undefined,
		clearMediaGroups: () => { clearedMediaGroups += 1; },
	});

	await assert.rejects(() => handlers.get("session_shutdown")?.[0]?.({}) as Promise<unknown>, /disconnect failed/);
	assert.equal(clearedMediaGroups, 1);
	assert.equal(disconnectCalls, 1);
	assert.equal(stopBrokerCalls, 1);
	assert.equal(setQueuedCalls, 0);
}

async function checkImageOnlyLocalInputStillMirrorsToTelegram(): Promise<void> {
	const { handlers, pi } = buildPiHarness();
	let active: ActiveTelegramTurn | undefined;
	const localMessages: Array<{ text: string; imagesCount?: number; routeId?: string; chatId?: number | string; messageThreadId?: number }> = [];
	registerRuntimePiHooks(pi, {
		getConfig: () => ({}),
		setLatestCtx: () => undefined,
		getConnectedRoute: () => route(),
		setConnectedRoute: () => undefined,
		getActiveTelegramTurn: () => active,
		hasDeferredTelegramTurn: () => false,
		hasAwaitingTelegramFinalTurn: () => false,
		hasLiveAgentRun: () => false,
		flushDeferredTelegramTurn: async () => undefined,
		setActiveTelegramTurn: (turn) => { active = turn; },
		setQueuedTelegramTurns: () => undefined,
		setCurrentAbort: () => undefined,
		getSessionId: () => "session-1",
		getOwnerId: () => "owner-1",
		getIsBroker: () => false,
		getBrokerState: () => undefined,
		getConnectedBrokerSocketPath: () => "/tmp/broker.sock",
		activityReporter: { post: () => undefined, flush: async () => undefined } as never,
		isRoutableRoute: (candidate): candidate is TelegramRoute => Boolean(candidate),
		resolveAllowedAttachmentPath: async () => undefined,
		postIpc: async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
			if (type === "local_user_message") localMessages.push(payload as { text: string; imagesCount?: number; routeId?: string; chatId?: number | string; messageThreadId?: number });
			return undefined as TResponse;
		},
		promptForConfig: async () => false,
		connectTelegram: async () => undefined,
		unregisterSession: async () => undefined,
		markSessionOffline: async () => undefined,
		disconnectSessionRoute: async () => undefined,
		stopClientServer: async () => undefined,
		shutdownClientRoute: () => undefined,
		stopBroker: async () => undefined,
		hideTelegramStatus: () => undefined,
		updateStatus: () => undefined,
		readLease: async () => undefined,
		sendAssistantFinalToBroker: async () => true,
		finalizeActiveTelegramTurn: async () => "completed",
		onAgentRetryStart: () => undefined,
		onRetryMessageStart: () => undefined,
		startNextTelegramTurn: () => undefined,
		drainDeferredCompactionTurns: () => undefined,
		onSessionStart: async () => undefined,
		clearMediaGroups: () => undefined,
	});

	await (handlers.get("input")?.[0]?.({ source: "interactive", text: "", images: [{ type: "image", image: "img" }] }) ?? Promise.resolve());
	assert.deepEqual(localMessages, [{ text: "", imagesCount: 1, routeId: "123:9", chatId: 123, messageThreadId: 9 }]);
	assert.equal(active?.chatId, 123);
}

await checkDeferredAgentEndClearsAbortCallback();
await checkLocalInputFlushesDeferredWithoutStartingQueuedTelegramTurn();
await checkLocalInputDuringLiveRetryDoesNotFlushDeferredTurn();
await checkTelegramAttachIsAtomicOnValidationFailure();
await checkSessionShutdownLetsRouteTeardownOwnQueueDrainingAndStillStopsBroker();
await checkImageOnlyLocalInputStillMirrorsToTelegram();
console.log("Runtime pi hook checks passed");
