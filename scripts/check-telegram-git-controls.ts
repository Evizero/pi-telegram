import assert from "node:assert/strict";

import { TelegramApiError } from "../src/telegram/api.js";
import type { TelegramMessage } from "../src/shared/types.js";
import { callbackQuery, callbackQueryForMessage, createRouter, gitCallbackDataByText, message, session, state } from "./support/telegram-command-fixtures.js";
import type { IpcCall, TelegramCall } from "./support/telegram-command-fixtures.js";

async function checkGitCommandShowsInlineMenuWithoutAgentTurn(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls);

	await router.dispatch([message("/git")]);

	assert.deepEqual(ipcCalls, []);
	assert.equal(sentReplies[0], "Git repository tools\n\nChoose a read-only action:");
	assert.equal(telegramCalls[0]?.method, "sendMessageReplyMarkup");
	const control = Object.values(brokerState.gitControls ?? {})[0]!;
	assert.equal(control.sessionId, "session-1");
	assert.equal(control.chatId, 123);
	assert.equal(control.messageThreadId, 9);
	assert.equal(control.messageId, 99);
	gitCallbackDataByText(telegramCalls, "Status");
}

async function checkGitCallbacksQueryClientAndPreserveThread(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, undefined, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "query_git_repository") return { text: `Git ${(payload as { action: string }).action} result` } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("/git")]);
	const statusData = gitCallbackDataByText(telegramCalls, "Status");
	await router.dispatchCallback(callbackQuery(statusData));

	assert.deepEqual(ipcCalls, [{ type: "query_git_repository", payload: { action: "status" }, target: "session-1" }]);
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.chat_id === 123 && call.body.message_id === 99 && call.body.text === "Git status result"), true);
	assert.equal(telegramCalls.some((call) => call.method === "answerCallbackQuery" && call.body.text === "Git status ready."), true);
	assert.equal(Object.keys(brokerState.gitControls ?? {}).length, 0);

	await router.dispatch([message("/git")]);
	const diffstatData = gitCallbackDataByText(telegramCalls.slice(-1), "Diffstat");
	await router.dispatchCallback(callbackQuery(diffstatData));

	assert.equal(ipcCalls[1]?.type, "query_git_repository");
	assert.deepEqual(ipcCalls[1]?.payload, { action: "diffstat" });
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.text === "Git diffstat result"), true);
}

async function checkGitCallbackRejectsStaleOfflineAndWrongRoute(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls);

	await router.dispatch([message("/git")]);
	const statusData = gitCallbackDataByText(telegramCalls, "Status");
	brokerState.sessions["session-1"]!.status = "offline";
	await router.dispatchCallback(callbackQuery(statusData));

	assert.equal(ipcCalls.length, 0);
	assert.equal(telegramCalls.some((call) => call.method === "answerCallbackQuery" && call.body.show_alert === true && String(call.body.text).includes("no longer matches")), true);

	await router.dispatchCallback(callbackQuery("git1:missing:s"));
	assert.equal(telegramCalls.some((call) => call.method === "answerCallbackQuery" && call.body.text === "Git menu expired. Send /git again."), true);
}

async function checkGitSelectorCallbackRejectsOldSelection(): Promise<void> {
	const brokerState = state();
	const secondSession = { ...session(), sessionId: "session-2", clientSocketPath: "/tmp/client-2.sock", topicName: "other" };
	brokerState.sessions[secondSession.sessionId] = secondSession;
	brokerState.selectorSelections = { "123": { chatId: 123, sessionId: "session-1", expiresAtMs: Date.now() + 60_000, updatedAtMs: Date.now() } };
	brokerState.routes["123:session-1"] = { routeId: "123", sessionId: "session-1", chatId: 123, routeMode: "single_chat_selector", topicName: "project · main", createdAtMs: Date.now(), updatedAtMs: Date.now() };
	brokerState.routes["123:session-2"] = { routeId: "123", sessionId: "session-2", chatId: 123, routeMode: "single_chat_selector", topicName: "other", createdAtMs: Date.now(), updatedAtMs: Date.now() };
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls);
	const selectorMessage: TelegramMessage = { ...message("/git", 77), message_thread_id: undefined };

	await router.dispatch([selectorMessage]);
	const statusData = gitCallbackDataByText(telegramCalls, "Status");
	brokerState.selectorSelections["123"] = { chatId: 123, sessionId: "session-2", expiresAtMs: Date.now() + 60_000, updatedAtMs: Date.now() };
	await router.dispatchCallback(callbackQueryForMessage(statusData, { ...selectorMessage, message_id: 99 }));

	brokerState.selectorSelections["123"] = { chatId: 123, sessionId: "session-1", expiresAtMs: Date.now() + 120_000, updatedAtMs: Date.now() + 1 };
	await router.dispatchCallback(callbackQueryForMessage(statusData, { ...selectorMessage, message_id: 99 }));

	assert.equal(ipcCalls.length, 0);
	assert.equal(telegramCalls.some((call) => call.method === "answerCallbackQuery" && call.body.show_alert === true && String(call.body.text).includes("no longer matches")), true);
}

async function checkGitRetryAfterPropagatesWithoutClientQueryReplay(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let failAnswer = true;
	const callTelegram = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "answerCallbackQuery" && body.text === "Git status ready." && failAnswer) {
			failAnswer = false;
			throw new TelegramApiError("answerCallbackQuery", "Too Many Requests", 429, 2);
		}
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, callTelegram, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "query_git_repository") return { text: "Git status result" } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("/git")]);
	const statusData = gitCallbackDataByText(telegramCalls, "Status");
	await assert.rejects(() => router.dispatchCallback(callbackQuery(statusData)), /Too Many Requests/);
	assert.equal(ipcCalls.filter((call) => call.type === "query_git_repository").length, 1);
	const editCountAfterRetryAfter = telegramCalls.filter((call) => call.method === "editMessageText" && call.body.text === "Git status result").length;
	await router.dispatchCallback(callbackQuery(statusData));
	assert.equal(ipcCalls.filter((call) => call.type === "query_git_repository").length, 1);
	assert.equal(telegramCalls.filter((call) => call.method === "editMessageText" && call.body.text === "Git status result").length, editCountAfterRetryAfter);
	assert.equal(Object.keys(brokerState.gitControls ?? {}).length, 0);
}

await checkGitCommandShowsInlineMenuWithoutAgentTurn();
await checkGitCallbacksQueryClientAndPreserveThread();
await checkGitCallbackRejectsStaleOfflineAndWrongRoute();
await checkGitSelectorCallbackRejectsOldSelection();
await checkGitRetryAfterPropagatesWithoutClientQueryReplay();
console.log("Telegram git control checks passed");
