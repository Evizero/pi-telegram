import assert from "node:assert/strict";
import { ActivityRenderer, ActivityReporter, activityLineToHtml, thinkingActivityLine, toolActivityLine, type ActivityRendererDiagnostic, type ActivityRendererOptions } from "../src/broker/activity.js";
import type { ActiveActivityMessageRef } from "../src/broker/types.js";
import { ACTIVITY_THROTTLE_MS } from "../src/broker/policy.js";
import { TelegramApiError } from "../src/telegram/api-errors.js";
import { createTypingLoopController } from "../src/telegram/typing.js";

function assertIncludes(text: string, expected: string): void {
	assert.ok(text.includes(expected), `expected ${JSON.stringify(text)} to include ${JSON.stringify(expected)}`);
}

function assertNotIncludes(text: string, unexpected: string): void {
	assert.ok(!text.includes(unexpected), `expected ${JSON.stringify(text)} not to include ${JSON.stringify(unexpected)}`);
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function assertToolFormatting(): void {
	assert.equal(toolActivityLine("bash", { command: "npm run check" }), "*💻 $ npm run check");
	assert.equal(toolActivityLine("read", { path: "src/broker/activity.ts" }), "*📖 read src/broker/activity.ts");
	assert.equal(toolActivityLine("write", { path: "src/broker/activity.ts" }), "*📝 write src/broker/activity.ts");
	assert.equal(toolActivityLine("edit", { path: "src/broker/activity.ts" }), "*📝 edit src/broker/activity.ts");
	assert.equal(toolActivityLine("telegram_attach", { paths: ["out.txt"] }), '*🔧 telegram_attach {"paths":["out.txt"]}');
	assert.equal(activityLineToHtml(toolActivityLine("bash", { command: "echo '<x>' && echo $HOME & wait" })), "<b>💻 $ <code>echo '&lt;x&gt;' &amp;&amp; echo $HOME &amp; wait</code></b>");
	assert.equal(activityLineToHtml(toolActivityLine("read", { path: "src/a&b<c>.ts" })), "<b>📖 read <code>src/a&amp;b&lt;c&gt;.ts</code></b>");
}

async function buildRenderer(startTypingLoopFor: () => void | Promise<void> = () => undefined, options: ActivityRendererOptions = {}) {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	let nextMessageId = 1;
	const renderer = new ActivityRenderer(
		async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
			calls.push({ method, body });
			if (method === "sendMessage") return { message_id: nextMessageId++ } as TResponse;
			return {} as TResponse;
		},
		startTypingLoopFor,
		options,
	);
	return { renderer, calls };
}

function durableActivityOptions(store: Record<string, ActiveActivityMessageRef>, diagnostics: ActivityRendererDiagnostic[] = []): ActivityRendererOptions {
	return {
		getDurableMessage: (activityId) => store[activityId],
		listDurableMessages: () => Object.values(store),
		listDurableMessagesForTurn: (turnId) => Object.values(store).filter((message) => message.turnId === turnId),
		saveDurableMessage: (message) => { store[message.activityId] = message; },
		deleteDurableMessage: (activityId) => { delete store[activityId]; },
		reportDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
	};
}

async function assertHiddenThinkingPreservesSameTurnMessage(): Promise<void> {
	const hiddenOnly = await buildRenderer();
	await hiddenOnly.renderer.handleUpdate({ turnId: "turn-hidden-only", chatId: 1, line: thinkingActivityLine(false) });
	await hiddenOnly.renderer.flush("turn-hidden-only");
	assert.equal(hiddenOnly.calls[0]?.method, "sendMessage");
	assertIncludes(String(hiddenOnly.calls[0].body.text), "<b>⏳ working ...</b>");
	await hiddenOnly.renderer.handleUpdate({ turnId: "turn-hidden-only", chatId: 1, line: thinkingActivityLine(true) });
	await hiddenOnly.renderer.flush("turn-hidden-only");
	assert.deepEqual(hiddenOnly.calls.map((entry) => entry.method), ["sendMessage"]);
	await hiddenOnly.renderer.handleUpdate({ turnId: "turn-hidden-only", chatId: 1, line: toolActivityLine("read", { path: "after-hidden.ts" }) });
	await hiddenOnly.renderer.flush("turn-hidden-only");
	assert.deepEqual(hiddenOnly.calls.map((entry) => entry.method), ["sendMessage", "editMessageText"]);
	assertIncludes(String(hiddenOnly.calls.at(-1)?.body.text), "📖 read <code>after-hidden.ts</code>");

	const { renderer, calls } = await buildRenderer();
	await renderer.handleUpdate({ turnId: "turn-hidden", chatId: 1, line: thinkingActivityLine(false) });
	await renderer.flush("turn-hidden");
	assert.equal(calls[0]?.method, "sendMessage");
	assertIncludes(String(calls[0].body.text), "<b>⏳ working ...</b>");

	await renderer.handleUpdate({ turnId: "turn-hidden", chatId: 1, line: toolActivityLine("read", { path: "between.ts" }) });
	await renderer.handleUpdate({ turnId: "turn-hidden", chatId: 1, line: thinkingActivityLine(false) });
	await renderer.handleUpdate({ turnId: "turn-hidden", chatId: 1, line: thinkingActivityLine(true) });
	await renderer.flush("turn-hidden");
	const editedText = String(calls.at(-1)?.body.text);
	assert.equal(calls.at(-1)?.method, "editMessageText");
	assertIncludes(editedText, "📖 read <code>between.ts</code>");
	assertNotIncludes(editedText, "🧠 thinking ...");
	assertNotIncludes(editedText, "⏳ working ...");
}

async function assertActivitySendFailureDoesNotRepeatVisibleSends(): Promise<void> {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	const diagnostics: ActivityRendererDiagnostic[] = [];
	const store: Record<string, ActiveActivityMessageRef> = {};
	const renderer = new ActivityRenderer(
		async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
			calls.push({ method, body });
			if (method === "sendMessage") throw new Error("ambiguous accepted send");
			return {} as TResponse;
		},
		async () => undefined,
		durableActivityOptions(store, diagnostics),
	);
	await renderer.handleUpdate({ turnId: "turn-send-ambiguous", chatId: 1, line: toolActivityLine("read", { path: "first.ts" }) });
	await renderer.flush("turn-send-ambiguous");
	assert.deepEqual(calls.map((entry) => entry.method), ["sendMessage"]);
	assert.equal(store["turn-send-ambiguous"]?.messageIdUnavailable, true);
	assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes("sendMessage")));

	await renderer.handleUpdate({ turnId: "turn-send-ambiguous", chatId: 1, line: toolActivityLine("bash", { command: "npm test" }) });
	await renderer.flush("turn-send-ambiguous");
	assert.deepEqual(calls.map((entry) => entry.method), ["sendMessage"]);

	const recovered = new ActivityRenderer(
		async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
			calls.push({ method, body });
			return {} as TResponse;
		},
		async () => undefined,
		durableActivityOptions(store, diagnostics),
	);
	await recovered.handleUpdate({ turnId: "turn-send-ambiguous", chatId: 1, line: toolActivityLine("write", { path: "after-reset.ts" }) });
	await recovered.flush("turn-send-ambiguous");
	assert.deepEqual(calls.map((entry) => entry.method), ["sendMessage"]);
}

async function assertRetryAfterSendFailureCanRetryActivitySend(): Promise<void> {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	let failWithRetryAfter = true;
	const renderer = new ActivityRenderer(
		async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
			calls.push({ method, body });
			if (method === "sendMessage" && failWithRetryAfter) {
				failWithRetryAfter = false;
				throw new TelegramApiError("sendMessage", "Too Many Requests", 429, 0);
			}
			if (method === "sendMessage") return { message_id: 5 } as TResponse;
			return {} as TResponse;
		},
		async () => undefined,
	);
	await renderer.handleUpdate({ turnId: "turn-send-retry-after", chatId: 1, line: toolActivityLine("read", { path: "retry.ts" }) });
	await renderer.flush("turn-send-retry-after");
	assert.equal(calls.filter((entry) => entry.method === "sendMessage").length, 1);
	await renderer.flush("turn-send-retry-after");
	assert.equal(calls.filter((entry) => entry.method === "sendMessage").length, 1);
	await new Promise((resolve) => setTimeout(resolve, 270));
	await renderer.flush("turn-send-retry-after");
	assert.equal(calls.filter((entry) => entry.method === "sendMessage").length, 2);
	assertIncludes(String(calls.at(-1)?.body.text), "retry.ts");
}

async function assertRecoveredRetryAfterActivityIsRearmed(): Promise<void> {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	const store: Record<string, ActiveActivityMessageRef> = {
		"turn-retry-recover": { turnId: "turn-retry-recover", activityId: "turn-retry-recover", chatId: 1, retryAtMs: Date.now() + 30, lines: [toolActivityLine("read", { path: "recover.ts" })], createdAtMs: Date.now(), updatedAtMs: Date.now() },
	};
	const renderer = new ActivityRenderer(
		async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
			calls.push({ method, body });
			if (method === "sendMessage") return { message_id: 9 } as TResponse;
			return {} as TResponse;
		},
		async () => undefined,
		durableActivityOptions(store),
	);
	renderer.recoverDurableMessages();
	await waitFor(() => calls.some((entry) => entry.method === "sendMessage"), 500);
	assertIncludes(String(calls.at(-1)?.body.text), "recover.ts");
}

async function assertRecoveredRetryAfterDeleteIsRearmed(): Promise<void> {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	const store: Record<string, ActiveActivityMessageRef> = {
		"turn-delete-retry": { turnId: "turn-delete-retry", activityId: "turn-delete-retry", chatId: 1, messageId: 12, retryAtMs: Date.now() + 30, deleteWhenEmpty: true, lines: [], createdAtMs: Date.now(), updatedAtMs: Date.now() },
	};
	const renderer = new ActivityRenderer(
		async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
			calls.push({ method, body });
			return {} as TResponse;
		},
		async () => undefined,
		durableActivityOptions(store),
	);
	renderer.recoverDurableMessages();
	await waitFor(() => calls.some((entry) => entry.method === "deleteMessage"), 500);
	assert.equal(store["turn-delete-retry"], undefined);
}

async function assertInvalidatedActivityStateDoesNotFlushAfterCleanup(): Promise<void> {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	const store: Record<string, ActiveActivityMessageRef> = {};
	let renderValid = true;
	const renderer = new ActivityRenderer(
		async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
			calls.push({ method, body });
			return { message_id: 1 } as TResponse;
		},
		async () => undefined,
		{ ...durableActivityOptions(store), canRenderMessage: () => renderValid },
	);
	await renderer.handleUpdate({ turnId: "turn-cleaned-before-flush", chatId: 1, line: toolActivityLine("read", { path: "stale.ts" }) });
	assert.ok(store["turn-cleaned-before-flush"], "scheduled activity should be durable before cleanup");
	renderValid = false;
	await new Promise((resolve) => setTimeout(resolve, ACTIVITY_THROTTLE_MS + 50));
	assert.deepEqual(calls, []);
	assert.equal(store["turn-cleaned-before-flush"], undefined);
}

async function assertStaleInvalidationDoesNotDeleteRetargetedDurableRef(): Promise<void> {
	const store: Record<string, ActiveActivityMessageRef> = {};
	const renderer = new ActivityRenderer(
		async <TResponse>(): Promise<TResponse> => ({ message_id: 1 }) as TResponse,
		async () => undefined,
		{
			getDurableMessage: (activityId) => store[activityId],
			saveDurableMessage: (message) => { store[message.activityId] = message; },
			deleteDurableMessage: (activityId, expected) => {
				const current = store[activityId];
				if (!current) return;
				if (expected && current.sessionId !== expected.sessionId) return;
				delete store[activityId];
			},
			canRenderMessage: (message) => message.sessionId !== "old-session",
		},
	);
	await renderer.handleUpdate({ turnId: "turn-retargeted", chatId: 1, line: toolActivityLine("read", { path: "old.ts" }) }, "old-session");
	store["turn-retargeted"] = { ...store["turn-retargeted"]!, sessionId: "new-session" };
	await renderer.flush("turn-retargeted");
	assert.equal(store["turn-retargeted"]?.sessionId, "new-session");
}

async function assertRecoveredActivityRetargetsCurrentSession(): Promise<void> {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	const store: Record<string, ActiveActivityMessageRef> = {
		"turn-replacement": { turnId: "turn-replacement", activityId: "turn-replacement", sessionId: "old-session", chatId: 1, messageId: 20, lines: [toolActivityLine("read", { path: "before.ts" })], createdAtMs: Date.now(), updatedAtMs: Date.now() },
	};
	const renderer = new ActivityRenderer(
		async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
			calls.push({ method, body });
			return {} as TResponse;
		},
		async () => undefined,
		durableActivityOptions(store),
	);
	await renderer.handleUpdate({ turnId: "turn-replacement", chatId: 1, line: toolActivityLine("bash", { command: "npm test" }) }, "new-session");
	await renderer.flush("turn-replacement");
	assert.equal(store["turn-replacement"]?.sessionId, "new-session");
	assert.deepEqual(calls.map((entry) => entry.method), ["editMessageText"]);
}

async function assertRendererResetRecoversDurableActivityMessage(): Promise<void> {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	const store: Record<string, ActiveActivityMessageRef> = {};
	let nextMessageId = 40;
	const makeRenderer = () => new ActivityRenderer(
		async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
			calls.push({ method, body });
			if (method === "sendMessage") return { message_id: nextMessageId++ } as TResponse;
			return {} as TResponse;
		},
		async () => undefined,
		durableActivityOptions(store),
	);
	const first = makeRenderer();
	await first.handleUpdate({ turnId: "turn-reset", chatId: 1, messageThreadId: 7, line: toolActivityLine("read", { path: "before-reset.ts" }) }, "session-a");
	await first.flush("turn-reset");
	assert.equal(calls.at(-1)?.method, "sendMessage");
	assert.equal(store["turn-reset"]?.messageId, 40);

	const recovered = makeRenderer();
	await recovered.handleUpdate({ turnId: "turn-reset", chatId: 1, messageThreadId: 7, line: toolActivityLine("bash", { command: "npm run check" }) }, "session-a");
	await recovered.flush("turn-reset");
	assert.deepEqual(calls.map((entry) => entry.method), ["sendMessage", "editMessageText"]);
	assert.equal(calls.at(-1)?.body.message_id, 40);
	const editedText = String(calls.at(-1)?.body.text);
	assertIncludes(editedText, "before-reset.ts");
	assertIncludes(editedText, "npm run check");
	assert.equal(calls.at(-1)?.body.message_thread_id, undefined);

	const finalizerAfterReset = makeRenderer();
	await finalizerAfterReset.complete("turn-reset");
	assert.equal(calls.at(-1)?.method, "editMessageText");
	assert.equal(store["turn-reset"], undefined);
}

async function assertDeleteFailureDoesNotCreateReplacementActivityBubble(): Promise<void> {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	const diagnostics: ActivityRendererDiagnostic[] = [];
	let nextMessageId = 1;
	const terminalDeleteError = new TelegramApiError("deleteMessage", "Forbidden: bot was blocked", 403, undefined);
	const renderer = new ActivityRenderer(
		async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
			calls.push({ method, body });
			if (method === "sendMessage") return { message_id: nextMessageId++ } as TResponse;
			if (method === "deleteMessage") throw terminalDeleteError;
			return {} as TResponse;
		},
		async () => undefined,
		{ reportDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); } },
	);
	await renderer.handleUpdate({ turnId: "turn-delete-fails", chatId: 1, line: thinkingActivityLine(false) });
	await renderer.flush("turn-delete-fails");
	await renderer.complete("turn-delete-fails");
	await renderer.handleUpdate({ turnId: "turn-delete-fails", chatId: 1, line: toolActivityLine("read", { path: "stale.ts" }) });
	await renderer.flush("turn-delete-fails");
	assert.equal(calls.filter((entry) => entry.method === "sendMessage").length, 1);
	assert.ok(calls.every((entry) => entry.method === "sendMessage" || entry.method === "deleteMessage"));
	assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes("deleteMessage")));
}

async function assertHiddenThinkingPromotesToVisibleThinking(): Promise<void> {
	const { renderer, calls } = await buildRenderer();
	await renderer.handleUpdate({ turnId: "turn-promote", chatId: 1, line: thinkingActivityLine(false) });
	await renderer.handleUpdate({ turnId: "turn-promote", chatId: 1, line: thinkingActivityLine(false, "Inspecting activity renderer") });
	await renderer.handleUpdate({ turnId: "turn-promote", chatId: 1, line: toolActivityLine("read", { path: "between-visible.ts" }) });
	await renderer.handleUpdate({ turnId: "turn-promote", chatId: 1, line: thinkingActivityLine(false) });
	await renderer.flush("turn-promote");
	const visibleText = String(calls.at(-1)?.body.text);
	assertIncludes(visibleText, "<b>🧠 Inspecting activity renderer</b>");
	assertNotIncludes(visibleText, "⏳ working ...");

	await renderer.handleUpdate({ turnId: "turn-promote", chatId: 1, line: thinkingActivityLine(true) });
	await renderer.flush("turn-promote");
	const completedText = String(calls.at(-1)?.body.text);
	assertIncludes(completedText, "🧠 Inspecting activity renderer");
	assertNotIncludes(completedText, "<b>🧠 Inspecting activity renderer</b>");
}

async function assertVisibleThinkingReplacesInterleavedWorking(): Promise<void> {
	const { renderer, calls } = await buildRenderer();
	await renderer.handleUpdate({ turnId: "turn-interleaved-visible", chatId: 1, line: thinkingActivityLine(false) });
	await renderer.handleUpdate({ turnId: "turn-interleaved-visible", chatId: 1, line: toolActivityLine("read", { path: "between-title.ts" }) });
	await renderer.handleUpdate({ turnId: "turn-interleaved-visible", chatId: 1, line: thinkingActivityLine(false, "Visible title after tool") });
	await renderer.handleUpdate({ turnId: "turn-interleaved-visible", chatId: 1, line: toolActivityLine("bash", { command: "echo interleaved" }) });
	await renderer.handleUpdate({ turnId: "turn-interleaved-visible", chatId: 1, line: thinkingActivityLine(false, "Updated title after second tool") });
	await renderer.handleUpdate({ turnId: "turn-interleaved-visible", chatId: 1, line: thinkingActivityLine(true, "Completed title") });
	await renderer.flush("turn-interleaved-visible");
	const text = String(calls.at(-1)?.body.text);
	assertIncludes(text, "🧠 Completed title");
	assertIncludes(text, "📖 read <code>between-title.ts</code>");
	assertIncludes(text, "💻 $ <code>echo interleaved</code>");
	assertNotIncludes(text, "<b>🧠");
	assertNotIncludes(text, "⏳ working ...");
	assert.equal((text.match(/🧠/g) ?? []).length, 1);
}

async function assertCompleteRemovesActiveWorkingBeforeFinalFlush(): Promise<void> {
	const { renderer, calls } = await buildRenderer();
	await renderer.handleUpdate({ turnId: "turn-complete-working", chatId: 1, line: thinkingActivityLine(false) });
	await renderer.flush("turn-complete-working");
	assertIncludes(String(calls.at(-1)?.body.text), "<b>⏳ working ...</b>");
	await renderer.complete("turn-complete-working");
	assert.equal(calls.at(-1)?.method, "deleteMessage");
}

async function assertActivitySegmentsPreserveTelegramChronology(): Promise<void> {
	const { renderer, calls } = await buildRenderer();
	await renderer.handleUpdate({ turnId: "turn-segmented", chatId: 1, line: toolActivityLine("read", { path: "before-text.ts" }) });
	await renderer.flush("turn-segmented");
	assert.equal(calls.at(-1)?.method, "sendMessage");
	assertIncludes(String(calls.at(-1)?.body.text), "before-text.ts");

	await renderer.completeActivity("turn-segmented");
	const completedBaseText = String(calls.at(-1)?.body.text);
	assertIncludes(completedBaseText, "📖 read <code>before-text.ts</code>");
	assertNotIncludes(completedBaseText, "<b>📖 read <code>before-text.ts</code></b>");
	const callsBeforeClosedBaseUpdate = calls.length;
	calls.push({ method: "assistant-preview", body: { text: "Interleaved assistant text" } });
	await renderer.handleUpdate({ turnId: "turn-segmented", activityId: "turn-segmented:activity:1", chatId: 1, line: toolActivityLine("bash", { command: "npm test" }) });
	await renderer.flush("turn-segmented:activity:1");
	assert.equal(calls.at(-2)?.method, "assistant-preview");
	assert.equal(calls.at(-1)?.method, "sendMessage");
	assertIncludes(String(calls.at(-1)?.body.text), "npm test");

	await renderer.handleUpdate({ turnId: "turn-segmented", chatId: 1, line: toolActivityLine("write", { path: "closed-base.ts" }) });
	await renderer.flush("turn-segmented");
	assert.equal(calls.length, callsBeforeClosedBaseUpdate + 2);
	await renderer.complete("turn-segmented");
	calls.push({ method: "final", body: { text: "final response" } });
	await renderer.handleUpdate({ turnId: "turn-segmented", activityId: "turn-segmented:activity:1", chatId: 1, line: toolActivityLine("bash", undefined, true) });
	await renderer.flush("turn-segmented:activity:1");
	assert.equal(calls.at(-1)?.method, "final");
}

async function assertReporterFlushPreventsAfterFinalActivityEdits(): Promise<void> {
	const { renderer, calls } = await buildRenderer();
	let releaseSend: (() => void) | undefined;
	const reporter = new ActivityReporter(async (payload) => {
		if (payload.line.includes("blocked.ts")) await new Promise<void>((resolve) => { releaseSend = resolve; });
		await renderer.handleUpdate(payload);
	});

	reporter.post({ turnId: "turn-drain", chatId: 1, line: toolActivityLine("read", { path: "initial.ts" }) });
	await reporter.flush();
	await renderer.flush("turn-drain");
	assert.equal(calls.at(-1)?.method, "sendMessage");

	reporter.post({ turnId: "turn-drain", chatId: 1, line: toolActivityLine("read", { path: "blocked.ts" }) });
	const drained = reporter.flush();
	while (!releaseSend) await new Promise((resolve) => setTimeout(resolve, 0));
	calls.push({ method: "final", body: { text: "final response" } });
	releaseSend();
	await drained;
	await renderer.flush("turn-drain");
	assert.equal(calls.at(-2)?.method, "final");
	assert.equal(calls.at(-1)?.method, "editMessageText");

	const guarded = await buildRenderer();
	const guardedReporter = new ActivityReporter((payload) => guarded.renderer.handleUpdate(payload));
	guardedReporter.post({ turnId: "turn-guarded", chatId: 1, line: toolActivityLine("read", { path: "before-final.ts" }) });
	guardedReporter.post({ turnId: "turn-guarded", chatId: 1, line: toolActivityLine("bash", { command: "npm run check" }) });
	await guardedReporter.flush();
	await guarded.renderer.complete("turn-guarded");
	guarded.calls.push({ method: "final", body: { text: "final response" } });
	guardedReporter.post({ turnId: "turn-guarded", chatId: 1, line: toolActivityLine("bash", undefined, true) });
	await guardedReporter.flush();
	await guarded.renderer.flush("turn-guarded");
	assert.equal(guarded.calls.at(-1)?.method, "final");
}

async function assertActivityUpdateDoesNotWaitForTypingStartup(): Promise<void> {
	let releaseTyping: (() => void) | undefined;
	let typingStarted = false;
	const { renderer, calls } = await buildRenderer(async () => {
		typingStarted = true;
		await new Promise<void>((resolve) => { releaseTyping = resolve; });
	});
	await renderer.handleUpdate({ turnId: "turn-typing-blocked", chatId: 1, messageThreadId: 123, line: toolActivityLine("read", { path: "live.ts" }) });
	await renderer.flush("turn-typing-blocked");
	assert.equal(calls.at(-1)?.method, "sendMessage");
	assertIncludes(String(calls.at(-1)?.body.text), "live.ts");
	assert.equal(calls.at(-1)?.body.message_thread_id, 123);
	assert.equal(calls.at(-1)?.body.disable_notification, true);
	while (!typingStarted || !releaseTyping) await new Promise((resolve) => setTimeout(resolve, 0));
	releaseTyping();
}

async function assertTypingLoopSkipsOverlappingSends(): Promise<void> {
	const calls: Record<string, unknown>[] = [];
	let releaseFirst: (() => void) | undefined;
	let firstResolved = false;
	const typing = createTypingLoopController(async (body) => {
		calls.push(body);
		if (calls.length === 1) {
			await new Promise<void>((resolve) => { releaseFirst = resolve; });
			firstResolved = true;
		}
	}, 5);
	typing.start("turn-typing-overlap", 99, 123);
	while (!releaseFirst) await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], { chat_id: 99, action: "typing", message_thread_id: 123 });
	releaseFirst();
	while (!firstResolved) await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(calls.length >= 2, "expected another typing send after the pending send resolved");
	typing.stop("turn-typing-overlap");
	const callsAfterStop = calls.length;
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.equal(calls.length, callsAfterStop);
}

async function assertTypingLoopAbortStopsRetryDelayedSend(): Promise<void> {
	let aborted = false;
	const calls: Record<string, unknown>[] = [];
	const typing = createTypingLoopController(async (body, signal) => {
		calls.push(body);
		signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
		await new Promise<void>(() => undefined);
	}, 5);
	typing.start("turn-typing-abort", 99);
	while (calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
	typing.stop("turn-typing-abort");
	assert.equal(aborted, true);
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.equal(calls.length, 1);
}

async function assertOverlappingTimerFlushSchedulesFollowUpFlush(): Promise<void> {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	let nextMessageId = 1;
	let releaseFirstSend: (() => void) | undefined;
	const renderer = new ActivityRenderer(
		async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
			calls.push({ method, body });
			if (method === "sendMessage" && calls.filter((entry) => entry.method === "sendMessage").length === 1) {
				await new Promise<void>((resolve) => { releaseFirstSend = resolve; });
			}
			if (method === "sendMessage") return { message_id: nextMessageId++ } as TResponse;
			return {} as TResponse;
		},
		async () => undefined,
	);
	await renderer.handleUpdate({ turnId: "turn-overlap", chatId: 1, line: toolActivityLine("read", { path: "one.ts" }) });
	await waitFor(() => calls.length > 0, ACTIVITY_THROTTLE_MS + 250);
	await waitFor(() => Boolean(releaseFirstSend));
	await renderer.handleUpdate({ turnId: "turn-overlap", chatId: 1, line: toolActivityLine("read", { path: "two.ts" }) });
	await new Promise((resolve) => setTimeout(resolve, ACTIVITY_THROTTLE_MS + 50));
	releaseFirstSend?.();
	await waitFor(() => calls.some((entry) => entry.method === "editMessageText"), 1000);
	const firstText = String(calls.find((entry) => entry.method === "sendMessage")?.body.text);
	const followUpText = String(calls.find((entry) => entry.method === "editMessageText")?.body.text);
	assertIncludes(firstText, "one.ts");
	assertNotIncludes(firstText, "two.ts");
	assertIncludes(followUpText, "one.ts");
	assertIncludes(followUpText, "two.ts");
}

async function assertCompleteWaitsForQueuedFollowUpWithoutSpawningAnother(): Promise<void> {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	let nextMessageId = 1;
	let releaseFirstSend: (() => void) | undefined;
	const renderer = new ActivityRenderer(
		async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
			calls.push({ method, body });
			if (method === "sendMessage" && calls.filter((entry) => entry.method === "sendMessage").length === 1) {
				await new Promise<void>((resolve) => { releaseFirstSend = resolve; });
			}
			if (method === "sendMessage") return { message_id: nextMessageId++ } as TResponse;
			return {} as TResponse;
		},
		async () => undefined,
	);
	await renderer.handleUpdate({ turnId: "turn-overlap-complete", chatId: 1, line: toolActivityLine("read", { path: "one.ts" }) });
	await waitFor(() => Boolean(releaseFirstSend), ACTIVITY_THROTTLE_MS + 250);
	await renderer.handleUpdate({ turnId: "turn-overlap-complete", chatId: 1, line: toolActivityLine("read", { path: "two.ts" }) });
	await new Promise((resolve) => setTimeout(resolve, ACTIVITY_THROTTLE_MS + 50));
	const completed = renderer.complete("turn-overlap-complete");
	releaseFirstSend?.();
	await completed;
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(calls.map((entry) => entry.method), ["sendMessage", "editMessageText"]);
	const completedText = String(calls.at(-1)?.body.text);
	assertIncludes(completedText, "one.ts");
	assertIncludes(completedText, "two.ts");
	assertNotIncludes(completedText, "<b>📖 read <code>one.ts</code></b>");
	assertNotIncludes(completedText, "<b>📖 read <code>two.ts</code></b>");
}

async function assertCompleteStopsIfStateIsClearedDuringInFlightFlush(): Promise<void> {
	let releaseFirstSend: (() => void) | undefined;
	let completeResolved = false;
	const renderer = new ActivityRenderer(
		async <TResponse>(method: string): Promise<TResponse> => {
			if (method === "sendMessage") await new Promise<void>((resolve) => { releaseFirstSend = resolve; });
			return { message_id: 1 } as TResponse;
		},
		async () => undefined,
	);
	await renderer.handleUpdate({ turnId: "turn-clear-during-complete", chatId: 1, line: toolActivityLine("read", { path: "one.ts" }) });
	await waitFor(() => Boolean(releaseFirstSend), ACTIVITY_THROTTLE_MS + 250);
	const completed = renderer.complete("turn-clear-during-complete").then(() => { completeResolved = true; });
	renderer.clearAllTimers();
	releaseFirstSend?.();
	await waitFor(() => completeResolved, 1000);
	await completed;
}

async function assertCompleteCorrectsInFlightStaleFlush(): Promise<void> {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	let nextMessageId = 1;
	let releaseTelegram: (() => void) | undefined;
	const renderer = new ActivityRenderer(
		async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
			calls.push({ method, body });
			if (method === "editMessageText" && String(body.text).includes("⏳ working ...")) await new Promise<void>((resolve) => { releaseTelegram = resolve; });
			if (method === "sendMessage") return { message_id: nextMessageId++ } as TResponse;
			return {} as TResponse;
		},
		async () => undefined,
	);
	await renderer.handleUpdate({ turnId: "turn-stale-flush", chatId: 1, line: thinkingActivityLine(false) });
	await renderer.flush("turn-stale-flush");
	const blockedFlush = renderer.handleUpdate({ turnId: "turn-stale-flush", chatId: 1, line: thinkingActivityLine(false) })
		.then(() => renderer.flush("turn-stale-flush"));
	while (!releaseTelegram) await new Promise((resolve) => setTimeout(resolve, 0));
	const completed = renderer.complete("turn-stale-flush");
	releaseTelegram();
	await blockedFlush;
	await completed;
	assert.equal(calls.at(-2)?.method, "editMessageText");
	assert.equal(calls.at(-1)?.method, "deleteMessage");
}

async function assertBashCompletionMatchesLabelLessRow(): Promise<void> {
	const { renderer, calls } = await buildRenderer();
	await renderer.handleUpdate({ turnId: "turn-bash", chatId: 1, line: toolActivityLine("bash", { command: "npm run check" }) });
	await renderer.flush("turn-bash");
	await renderer.handleUpdate({ turnId: "turn-bash", chatId: 1, line: toolActivityLine("bash", undefined, true) });
	await renderer.flush("turn-bash");
	const completedText = String(calls.at(-1)?.body.text);
	assertIncludes(completedText, "💻 $ <code>npm run check</code>");
	assertNotIncludes(completedText, "bash");
	assert.equal((completedText.match(/npm run check/g) ?? []).length, 1);

	const error = await buildRenderer();
	await error.renderer.handleUpdate({ turnId: "turn-bash-error", chatId: 1, line: toolActivityLine("bash", { command: "exit 1" }) });
	await error.renderer.flush("turn-bash-error");
	await error.renderer.handleUpdate({ turnId: "turn-bash-error", chatId: 1, line: toolActivityLine("bash", undefined, true, true) });
	await error.renderer.flush("turn-bash-error");
	const errorText = String(error.calls.at(-1)?.body.text);
	assertIncludes(errorText, "❌ $ <code>exit 1</code>");
	assertNotIncludes(errorText, "bash");
	assert.equal((errorText.match(/exit 1/g) ?? []).length, 1);
}

assertToolFormatting();
await assertHiddenThinkingPreservesSameTurnMessage();
await assertActivitySendFailureDoesNotRepeatVisibleSends();
await assertRetryAfterSendFailureCanRetryActivitySend();
await assertRecoveredRetryAfterActivityIsRearmed();
await assertRecoveredRetryAfterDeleteIsRearmed();
await assertInvalidatedActivityStateDoesNotFlushAfterCleanup();
await assertStaleInvalidationDoesNotDeleteRetargetedDurableRef();
await assertRecoveredActivityRetargetsCurrentSession();
await assertRendererResetRecoversDurableActivityMessage();
await assertDeleteFailureDoesNotCreateReplacementActivityBubble();
await assertHiddenThinkingPromotesToVisibleThinking();
await assertVisibleThinkingReplacesInterleavedWorking();
await assertCompleteRemovesActiveWorkingBeforeFinalFlush();
await assertActivitySegmentsPreserveTelegramChronology();
await assertReporterFlushPreventsAfterFinalActivityEdits();
await assertActivityUpdateDoesNotWaitForTypingStartup();
await assertTypingLoopSkipsOverlappingSends();
await assertTypingLoopAbortStopsRetryDelayedSend();
await assertOverlappingTimerFlushSchedulesFollowUpFlush();
await assertCompleteWaitsForQueuedFollowUpWithoutSpawningAnother();
await assertCompleteStopsIfStateIsClearedDuringInFlightFlush();
await assertCompleteCorrectsInFlightStaleFlush();
await assertBashCompletionMatchesLabelLessRow();
console.log("Activity rendering checks passed");
