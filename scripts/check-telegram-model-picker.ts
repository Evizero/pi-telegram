import assert from "node:assert/strict";

import { TelegramApiError } from "../src/telegram/api.js";
import type { TelegramMessage } from "../src/shared/types.js";
import { callbackQuery, callbackQueryForMessage, createRouter, message, session, state } from "./support/telegram-command-fixtures.js";
import type { IpcCall, TelegramCall } from "./support/telegram-command-fixtures.js";

async function checkBareModelUsesTwoStageInlinePickerAndExactSelection(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls);

	await router.dispatch([message("/model")]);

	assert.equal(ipcCalls[0]?.type, "query_models");
	assert.equal(sentReplies[0]?.includes("Choose a model subscription/provider"), true);
	const picker = Object.values(brokerState.modelPickers ?? {})[0]!;
	assert.equal(picker.groups.length, 3);
	assert.equal(telegramCalls[0]?.method, "sendMessageReplyMarkup");
	const providerKeyboard = telegramCalls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
	assert.equal(providerKeyboard.inline_keyboard.some((row) => row[0]?.text.includes("private")), true);

	await router.dispatchCallback(callbackQuery(providerKeyboard.inline_keyboard[1]![0]!.callback_data));
	const edit = telegramCalls.find((call) => call.method === "editMessageText")!;
	assert.equal((edit.body.text as string).includes("Provider: private"), true);
	const modelKeyboard = edit.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };

	await router.dispatchCallback(callbackQuery(modelKeyboard.inline_keyboard[0]![0]!.callback_data));

	const setModelCall = ipcCalls.find((call) => call.type === "set_model")!;
	assert.deepEqual(setModelCall.payload, { selector: "openai-codex-2/gpt-5.5", exact: true });
	assert.equal(Object.keys(brokerState.modelPickers ?? {}).length, 0);
}

async function checkModelListNumberCompatibilityRemains(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, []);

	await router.dispatch([message("/model list")]);
	await router.dispatch([message("/model 2")]);

	assert.equal(sentReplies[0]?.includes("1. openai-codex/gpt-5.5"), true);
	const setModelCall = ipcCalls.find((call) => call.type === "set_model")!;
	assert.deepEqual(setModelCall.payload, { selector: "openai-codex-2/gpt-5.5", exact: true });
}

async function checkModelSelectorCallbackRejectsOldSelection(): Promise<void> {
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
	const selectorMessage: TelegramMessage = { ...message("/model", 77), message_thread_id: undefined };

	await router.dispatch([selectorMessage]);
	const providerKeyboard = telegramCalls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
	const providerData = providerKeyboard.inline_keyboard[1]![0]!.callback_data;
	brokerState.selectorSelections["123"] = { chatId: 123, sessionId: "session-2", expiresAtMs: Date.now() + 60_000, updatedAtMs: Date.now() };
	await router.dispatchCallback(callbackQueryForMessage(providerData, { ...selectorMessage, message_id: 99 }));

	brokerState.selectorSelections["123"] = { chatId: 123, sessionId: "session-1", expiresAtMs: Date.now() + 120_000, updatedAtMs: Date.now() + 1 };
	await router.dispatchCallback(callbackQueryForMessage(providerData, { ...selectorMessage, message_id: 99 }));

	assert.equal(ipcCalls.filter((call) => call.type === "set_model").length, 0);
	assert.equal(telegramCalls.some((call) => call.method === "answerCallbackQuery" && call.body.show_alert === true && String(call.body.text).includes("no longer matches")), true);
}

async function checkProviderCallbackUiFailuresAreNonCritical(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let failAnswer = true;
	const callTelegram = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "answerCallbackQuery" && failAnswer) throw new Error("callback query is too old");
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, callTelegram);

	await router.dispatch([message("/model")]);
	const providerKeyboard = telegramCalls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
	await router.dispatchCallback(callbackQuery(providerKeyboard.inline_keyboard[1]![0]!.callback_data));
	failAnswer = false;

	assert.equal(Object.keys(brokerState.modelPickers ?? {}).length, 1);
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText"), true);
}

async function checkTelegramUiFailureAfterSuccessfulSelectionDoesNotMarkOffline(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const failingEditCall = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "editMessageText" && String(body.text).startsWith("Model changed")) throw new Error("message to edit not found");
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, failingEditCall);

	await router.dispatch([message("/model")]);
	const providerKeyboard = telegramCalls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
	await router.dispatchCallback(callbackQuery(providerKeyboard.inline_keyboard[1]![0]!.callback_data));
	const edit = telegramCalls.find((call) => call.method === "editMessageText")!;
	const modelKeyboard = edit.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
	await router.dispatchCallback(callbackQuery(modelKeyboard.inline_keyboard[0]![0]!.callback_data));

	assert.equal(brokerState.sessions["session-1"]!.status, "busy");
	assert.equal(sentReplies.at(-1), "Model changed to openai-codex-2/gpt-5.5");
}

async function checkRetryAfterAfterSuccessfulSelectionRetriesConfirmationWithoutRepeatingSetModel(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let failSelectionAnswer = true;
	const callTelegram = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "answerCallbackQuery" && String(body.text) === "Model selection handled." && failSelectionAnswer) {
			failSelectionAnswer = false;
			throw new TelegramApiError("answerCallbackQuery", "Too Many Requests", 429, 2);
		}
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, callTelegram);

	await router.dispatch([message("/model")]);
	const providerKeyboard = telegramCalls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
	await router.dispatchCallback(callbackQuery(providerKeyboard.inline_keyboard[1]![0]!.callback_data));
	const edit = telegramCalls.find((call) => call.method === "editMessageText")!;
	const modelKeyboard = edit.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
	const selectData = modelKeyboard.inline_keyboard[0]![0]!.callback_data;

	await assert.rejects(() => router.dispatchCallback(callbackQuery(selectData)), /Too Many Requests/);
	assert.equal(ipcCalls.filter((call) => call.type === "set_model").length, 1);
	const completedPicker = Object.values(brokerState.modelPickers ?? {})[0]!;
	assert.equal(completedPicker.completedText, "Model changed to openai-codex-2/gpt-5.5");
	completedPicker.expiresAtMs = Date.now() - 1;

	await router.dispatchCallback(callbackQuery(selectData));
	assert.equal(ipcCalls.filter((call) => call.type === "set_model").length, 1);
	assert.equal(Object.keys(brokerState.modelPickers ?? {}).length, 0);
}

async function checkNumericModelReplyFailureDoesNotMarkOfflineAfterSetModel(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	let failNextModelReply = false;
	const sendText = async (_chatId: number | string, _threadId: number | undefined, text: string): Promise<number | undefined> => {
		sentReplies.push(text);
		if (failNextModelReply && text.startsWith("Model changed")) throw new Error("telegram reply failed");
		return 99;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, [], () => 1, undefined, sendText);

	await router.dispatch([message("/model list")]);
	failNextModelReply = true;
	await router.dispatch([message("/model 2")]);

	assert.equal(brokerState.sessions["session-1"]!.status, "busy");
	assert.equal(ipcCalls.filter((call) => call.type === "set_model").length, 1);
}

async function checkBareModelAlsoKeepsNumberCompatibility(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, []);

	await router.dispatch([message("/model")]);
	await router.dispatch([message("/model 3")]);

	const setModelCall = ipcCalls.find((call) => call.type === "set_model")!;
	assert.deepEqual(setModelCall.payload, { selector: "openai-codex-3/gpt-5.5", exact: true });
}

await checkBareModelUsesTwoStageInlinePickerAndExactSelection();
await checkModelListNumberCompatibilityRemains();
await checkModelSelectorCallbackRejectsOldSelection();
await checkProviderCallbackUiFailuresAreNonCritical();
await checkTelegramUiFailureAfterSuccessfulSelectionDoesNotMarkOffline();
await checkRetryAfterAfterSuccessfulSelectionRetriesConfirmationWithoutRepeatingSetModel();
await checkNumericModelReplyFailureDoesNotMarkOfflineAfterSetModel();
await checkBareModelAlsoKeepsNumberCompatibility();
console.log("Telegram model picker checks passed");
