import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { ActivityRenderer, ActivityReporter } from "../src/broker/activity.js";
import { registerRuntimePiHooks, type RuntimePiHooksDeps } from "../src/pi/hooks.js";
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

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	return await Promise.race([
		promise,
		new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 50)),
	]);
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

function baseDeps(overrides: Partial<RuntimePiHooksDeps> = {}): RuntimePiHooksDeps {
	return {
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
		prepareSessionReplacementHandoff: async () => false,
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
		...overrides,
	};
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
		prepareSessionReplacementHandoff: async () => false,
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
		prepareSessionReplacementHandoff: async () => false,
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
		prepareSessionReplacementHandoff: async () => false,
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

async function checkAssistantTextDoesNotCloseActivityOrPostPreview(): Promise<void> {
	const { handlers, pi } = buildPiHarness();
	const active = activeTurn("turn-final-only");
	const ipcCalls: Array<{ type: string; payload: any }> = [];
	const activityReporter = {
		post: (payload: any) => { ipcCalls.push({ type: "activity_update", payload }); },
		flush: async () => undefined,
	};
	registerRuntimePiHooks(pi, baseDeps({
		getActiveTelegramTurn: () => active,
		activityReporter: activityReporter as never,
		postIpc: async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
			ipcCalls.push({ type, payload });
			return undefined as TResponse;
		},
	}));

	await (handlers.get("tool_call")?.[0]?.({ toolName: "read", input: { path: "before.ts" } }) ?? Promise.resolve());
	await (handlers.get("message_update")?.[0]?.({
		message: { role: "assistant", content: [{ type: "text", text: "Final-only text stream" }] },
		assistantMessageEvent: { type: "text_delta", delta: "Final-only text stream" },
	}) ?? Promise.resolve());
	await (handlers.get("tool_call")?.[0]?.({ toolName: "bash", input: { command: "npm test" } }) ?? Promise.resolve());

	assert.deepEqual(ipcCalls.map((call) => call.type), ["activity_update", "activity_update"]);
	assert.equal(ipcCalls[0]?.payload.activityId, undefined);
	assert.equal(ipcCalls[1]?.payload.activityId, undefined);
}

async function checkAssistantTextWithoutPriorActivityPostsNoPreview(): Promise<void> {
	const { handlers, pi } = buildPiHarness();
	const active = activeTurn("turn-text-first");
	const ipcCalls: Array<{ type: string; payload: any }> = [];
	registerRuntimePiHooks(pi, baseDeps({
		getActiveTelegramTurn: () => active,
		postIpc: async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
			ipcCalls.push({ type, payload });
			return undefined as TResponse;
		},
	}));

	await (handlers.get("message_update")?.[0]?.({
		message: { role: "assistant", content: [{ type: "text", text: "Text first" }] },
		assistantMessageEvent: { type: "text_start", contentIndex: 0 },
	}) ?? Promise.resolve());

	assert.deepEqual(ipcCalls, []);
}

async function checkDeferredRetryContinuesActivityWithoutTextSegmentation(): Promise<void> {
	const { handlers, pi } = buildPiHarness();
	const active = activeTurn("turn-retry-segment");
	const ipcCalls: Array<{ type: string; payload: any }> = [];
	const activityReporter = {
		post: (payload: any) => { ipcCalls.push({ type: "activity_update", payload }); },
		flush: async () => undefined,
	};
	registerRuntimePiHooks(pi, baseDeps({
		getActiveTelegramTurn: () => active,
		activityReporter: activityReporter as never,
		postIpc: async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
			ipcCalls.push({ type, payload });
			return undefined as TResponse;
		},
		finalizeActiveTelegramTurn: async () => "deferred",
	}));

	await (handlers.get("tool_call")?.[0]?.({ toolName: "read", input: { path: "before-retry.ts" } }) ?? Promise.resolve());
	await (handlers.get("message_update")?.[0]?.({
		message: { role: "assistant", content: [{ type: "text", text: "Text before retry" }] },
		assistantMessageEvent: { type: "text_delta", delta: "Text before retry" },
	}) ?? Promise.resolve());
	await (handlers.get("agent_end")?.[0]?.({ messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed" }] }, { ui: { theme: {} } } as ExtensionContext) ?? Promise.resolve());
	await (handlers.get("tool_call")?.[0]?.({ toolName: "bash", input: { command: "npm test" } }) ?? Promise.resolve());

	assert.equal(ipcCalls.at(-1)?.type, "activity_update");
	assert.equal(ipcCalls.at(-1)?.payload.activityId, undefined);
}

async function checkAssistantTextDoesNotAttemptActivityCompletionOrPreview(): Promise<void> {
	const { handlers, pi } = buildPiHarness();
	const active = activeTurn("turn-no-complete");
	const ipcCalls: Array<{ type: string; payload: any }> = [];
	const activityReporter = {
		post: (payload: any) => { ipcCalls.push({ type: "activity_update", payload }); },
		flush: async () => undefined,
	};
	registerRuntimePiHooks(pi, baseDeps({
		getActiveTelegramTurn: () => active,
		activityReporter: activityReporter as never,
		postIpc: async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
			ipcCalls.push({ type, payload });
			if (type === "activity_complete") throw new Error("assistant text should not complete activity");
			if (type === "assistant_preview") throw new Error("assistant text should not stream a preview");
			return undefined as TResponse;
		},
	}));

	await (handlers.get("tool_call")?.[0]?.({ toolName: "read", input: { path: "before-failure.ts" } }) ?? Promise.resolve());
	await (handlers.get("message_update")?.[0]?.({
		message: { role: "assistant", content: [{ type: "text", text: "Held until final" }] },
		assistantMessageEvent: { type: "text_delta", delta: "Held until final" },
	}) ?? Promise.resolve());
	await (handlers.get("tool_call")?.[0]?.({ toolName: "bash", input: { command: "same-activity-message" } }) ?? Promise.resolve());

	assert.deepEqual(ipcCalls.map((call) => call.type), ["activity_update", "activity_update"]);
	assert.equal(ipcCalls.at(-1)?.payload.activityId, undefined);
}

async function checkAwaitingFinalHandoffKeepsActivityStateForSameActiveTurn(): Promise<void> {
	const { handlers, pi } = buildPiHarness();
	let active: ActiveTelegramTurn | undefined = activeTurn("turn-awaiting-final");
	const ipcCalls: Array<{ type: string; payload: any }> = [];
	const activityReporter = {
		post: (payload: any) => { ipcCalls.push({ type: "activity_update", payload }); },
		flush: async () => undefined,
	};
	registerRuntimePiHooks(pi, baseDeps({
		getActiveTelegramTurn: () => active,
		activityReporter: activityReporter as never,
		postIpc: async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
			ipcCalls.push({ type, payload });
			return undefined as TResponse;
		},
		finalizeActiveTelegramTurn: async () => "completed",
		setActiveTelegramTurn: (turn) => { active = turn; },
	}));

	await (handlers.get("tool_call")?.[0]?.({ toolName: "read", input: { path: "before-awaiting.ts" } }) ?? Promise.resolve());
	await (handlers.get("message_update")?.[0]?.({
		message: { role: "assistant", content: [{ type: "text", text: "Text before awaiting handoff" }] },
		assistantMessageEvent: { type: "text_delta", delta: "Text before awaiting handoff" },
	}) ?? Promise.resolve());
	await (handlers.get("agent_end")?.[0]?.({ messages: [{ role: "assistant", content: [{ type: "text", text: "final" }], stopReason: "stop" }] }, { ui: { theme: {} } } as ExtensionContext) ?? Promise.resolve());
	await (handlers.get("tool_call")?.[0]?.({ toolName: "bash", input: { command: "late-awaiting" } }) ?? Promise.resolve());

	assert.equal(ipcCalls.at(-1)?.type, "activity_update");
	assert.equal(ipcCalls.at(-1)?.payload.activityId, undefined);
}

async function checkAssistantTextDoesNotWaitForBlockedTypingStartup(): Promise<void> {
	const { handlers, pi } = buildPiHarness();
	const active = activeTurn("turn-preview-blocked-typing");
	const ipcCalls: Array<{ type: string; payload: any }> = [];
	const telegramCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
	const renderer = new ActivityRenderer(
		async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
			telegramCalls.push({ method, body });
			if (method === "sendMessage") return { message_id: 1 } as TResponse;
			return {} as TResponse;
		},
		async () => { await new Promise<void>(() => undefined); },
	);
	const activityReporter = new ActivityReporter((payload) => renderer.handleUpdate(payload));
	registerRuntimePiHooks(pi, baseDeps({
		getActiveTelegramTurn: () => active,
		activityReporter,
		postIpc: async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
			ipcCalls.push({ type, payload });
			if (type === "activity_complete") await renderer.completeActivity((payload as { turnId: string }).turnId, (payload as { activityId?: string }).activityId);
			return undefined as TResponse;
		},
	}));

	await (handlers.get("tool_call")?.[0]?.({ toolName: "read", input: { path: "before-preview.ts" } }) ?? Promise.resolve());
	await withTimeout(handlers.get("message_update")?.[0]?.({
		message: { role: "assistant", content: [{ type: "text", text: "No preview despite blocked typing" }] },
		assistantMessageEvent: { type: "text_delta", delta: "No preview despite blocked typing" },
	}) ?? Promise.resolve(), "assistant text update without preview after blocked typing startup");

	assert.deepEqual(ipcCalls, []);
	assert.deepEqual(telegramCalls, []);
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
			prepareSessionReplacementHandoff: async () => false,
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
		prepareSessionReplacementHandoff: async () => false,
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

async function checkReplacementShutdownUsesHandoffInsteadOfRouteCleanup(): Promise<void> {
	const { handlers, pi } = buildPiHarness();
	let disconnectCalls = 0;
	let handoffCalls = 0;
	let shutdownClientCalls = 0;
	let stopClientCalls = 0;
	let stopBrokerCalls = 0;
	registerRuntimePiHooks(pi, baseDeps({
		disconnectSessionRoute: async () => { disconnectCalls += 1; },
		prepareSessionReplacementHandoff: async (event) => {
			handoffCalls += 1;
			assert.deepEqual(event, { reason: "new", targetSessionFile: "/tmp/new-session.jsonl" });
			return true;
		},
		shutdownClientRoute: async () => { shutdownClientCalls += 1; },
		stopClientServer: async () => { stopClientCalls += 1; },
		stopBroker: async () => { stopBrokerCalls += 1; },
	}));

	await (handlers.get("session_shutdown")?.[0]?.({ reason: "new", targetSessionFile: "/tmp/new-session.jsonl" }, { ui: { theme: {} } } as ExtensionContext) ?? Promise.resolve());
	assert.equal(handoffCalls, 1);
	assert.equal(shutdownClientCalls, 1);
	assert.equal(stopClientCalls, 1);
	assert.equal(disconnectCalls, 0);
	assert.equal(stopBrokerCalls, 1);
}

async function checkReplacementShutdownStopsClientWhenRouteShutdownFails(): Promise<void> {
	const { handlers, pi } = buildPiHarness();
	let stopClientCalls = 0;
	let stopBrokerCalls = 0;
	registerRuntimePiHooks(pi, baseDeps({
		prepareSessionReplacementHandoff: async () => true,
		shutdownClientRoute: async () => { throw new Error("route shutdown failed"); },
		stopClientServer: async () => { stopClientCalls += 1; },
		stopBroker: async () => { stopBrokerCalls += 1; },
	}));

	await assert.rejects(() => handlers.get("session_shutdown")?.[0]?.({ reason: "resume" }, { ui: { theme: {} } } as ExtensionContext) as Promise<unknown>, /route shutdown failed/);
	assert.equal(stopClientCalls, 1);
	assert.equal(stopBrokerCalls, 1);
}

async function checkReplacementShutdownFallsBackWhenNoHandoff(): Promise<void> {
	const { handlers, pi } = buildPiHarness();
	let disconnectCalls = 0;
	let shutdownClientCalls = 0;
	registerRuntimePiHooks(pi, baseDeps({
		disconnectSessionRoute: async (mode) => {
			disconnectCalls += 1;
			assert.equal(mode, "shutdown");
		},
		prepareSessionReplacementHandoff: async () => false,
		shutdownClientRoute: async () => { shutdownClientCalls += 1; },
	}));

	await (handlers.get("session_shutdown")?.[0]?.({ reason: "fork" }, { ui: { theme: {} } } as ExtensionContext) ?? Promise.resolve());
	assert.equal(disconnectCalls, 1);
	assert.equal(shutdownClientCalls, 0);
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
		prepareSessionReplacementHandoff: async () => false,
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
await checkAssistantTextDoesNotCloseActivityOrPostPreview();
await checkAssistantTextWithoutPriorActivityPostsNoPreview();
await checkDeferredRetryContinuesActivityWithoutTextSegmentation();
await checkAssistantTextDoesNotAttemptActivityCompletionOrPreview();
await checkAwaitingFinalHandoffKeepsActivityStateForSameActiveTurn();
await checkAssistantTextDoesNotWaitForBlockedTypingStartup();
await checkTelegramAttachIsAtomicOnValidationFailure();
await checkSessionShutdownLetsRouteTeardownOwnQueueDrainingAndStillStopsBroker();
await checkReplacementShutdownUsesHandoffInsteadOfRouteCleanup();
await checkReplacementShutdownStopsClientWhenRouteShutdownFails();
await checkReplacementShutdownFallsBackWhenNoHandoff();
await checkImageOnlyLocalInputStillMirrorsToTelegram();
console.log("Runtime pi hook checks passed");
