import assert from "node:assert/strict";
import { ActivityRenderer, ActivityReporter, activityLineToHtml, thinkingActivityLine, toolActivityLine } from "../src/broker/activity.js";
import { createTypingLoopController } from "../src/telegram/typing.js";

function assertIncludes(text: string, expected: string): void {
	assert.ok(text.includes(expected), `expected ${JSON.stringify(text)} to include ${JSON.stringify(expected)}`);
}

function assertNotIncludes(text: string, unexpected: string): void {
	assert.ok(!text.includes(unexpected), `expected ${JSON.stringify(text)} not to include ${JSON.stringify(unexpected)}`);
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

async function buildRenderer(startTypingLoopFor: () => void | Promise<void> = () => undefined) {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	let nextMessageId = 1;
	const renderer = new ActivityRenderer(
		async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
			calls.push({ method, body });
			if (method === "sendMessage") return { message_id: nextMessageId++ } as TResponse;
			return {} as TResponse;
		},
		startTypingLoopFor,
	);
	return { renderer, calls };
}

async function assertHiddenThinkingIsTransient(): Promise<void> {
	const hiddenOnly = await buildRenderer();
	await hiddenOnly.renderer.handleUpdate({ turnId: "turn-hidden-only", chatId: 1, line: thinkingActivityLine(false) });
	await hiddenOnly.renderer.flush("turn-hidden-only");
	assert.equal(hiddenOnly.calls[0]?.method, "sendMessage");
	assertIncludes(String(hiddenOnly.calls[0].body.text), "<b>⏳ working ...</b>");
	await hiddenOnly.renderer.handleUpdate({ turnId: "turn-hidden-only", chatId: 1, line: thinkingActivityLine(true) });
	await hiddenOnly.renderer.flush("turn-hidden-only");
	assert.equal(hiddenOnly.calls.at(-1)?.method, "deleteMessage");

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
await assertHiddenThinkingIsTransient();
await assertHiddenThinkingPromotesToVisibleThinking();
await assertVisibleThinkingReplacesInterleavedWorking();
await assertCompleteRemovesActiveWorkingBeforeFinalFlush();
await assertActivitySegmentsPreserveTelegramChronology();
await assertReporterFlushPreventsAfterFinalActivityEdits();
await assertActivityUpdateDoesNotWaitForTypingStartup();
await assertTypingLoopSkipsOverlappingSends();
await assertTypingLoopAbortStopsRetryDelayedSend();
await assertCompleteCorrectsInFlightStaleFlush();
await assertBashCompletionMatchesLabelLessRow();
console.log("Activity rendering checks passed");
