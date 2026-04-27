import assert from "node:assert/strict";

import { MAX_MESSAGE_LENGTH } from "../src/shared/config.js";
import type { TelegramSentMessage } from "../src/shared/types.js";
import { TelegramApiError } from "../src/telegram/api.js";
import { editTelegramTextMessage, sendTelegramMarkdownReply, sendTelegramTextReply, type TelegramJsonCall } from "../src/telegram/text.js";

interface CapturedCall {
	method: string;
	body: Record<string, unknown>;
}

function captureCall(calls: CapturedCall[], failFirst?: unknown): TelegramJsonCall {
	let count = 0;
	return async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		calls.push({ method, body });
		count += 1;
		if (count === 1 && failFirst) throw failFirst;
		return { message_id: count } as TelegramSentMessage as TResponse;
	};
}

async function assertSilentTextReply(): Promise<void> {
	const calls: CapturedCall[] = [];
	const messageId = await sendTelegramTextReply(captureCall(calls), 123, 456, "hello", { disableNotification: true });
	assert.equal(messageId, 1);
	assert.deepEqual(calls, [
		{
			method: "sendMessage",
			body: { chat_id: 123, message_thread_id: 456, text: "hello", disable_notification: true },
		},
	]);
}

async function assertNormalTextReplyDoesNotDisableNotifications(): Promise<void> {
	const calls: CapturedCall[] = [];
	await sendTelegramTextReply(captureCall(calls), "@chat", undefined, "hello");
	assert.deepEqual(calls, [
		{
			method: "sendMessage",
			body: { chat_id: "@chat", text: "hello" },
		},
	]);
}

async function assertSilentChunking(): Promise<void> {
	const calls: CapturedCall[] = [];
	const text = `${"a".repeat(MAX_MESSAGE_LENGTH)}${"b".repeat(12)}`;
	await sendTelegramTextReply(captureCall(calls), 123, 789, text, { disableNotification: true });
	assert.equal(calls.length, 2);
	for (const call of calls) {
		assert.equal(call.method, "sendMessage");
		assert.equal(call.body.chat_id, 123);
		assert.equal(call.body.message_thread_id, 789);
		assert.equal(call.body.disable_notification, true);
		assert.equal(typeof call.body.text, "string");
		assert.equal((call.body.text as string).length <= MAX_MESSAGE_LENGTH, true);
	}
}

async function assertReplyMarkupOnlyAttachedToLastChunk(): Promise<void> {
	const calls: CapturedCall[] = [];
	const replyMarkup = { inline_keyboard: [[{ text: "Pick", callback_data: "mp1:t:select:0" }]] };
	const text = `${"a".repeat(MAX_MESSAGE_LENGTH)}${"b".repeat(12)}`;
	await sendTelegramTextReply(captureCall(calls), 123, undefined, text, { replyMarkup });
	assert.equal(calls.length, 2);
	assert.equal(calls[0]?.body.reply_markup, undefined);
	assert.deepEqual(calls[1]?.body.reply_markup, replyMarkup);
}

async function assertMarkdownFallbackPreservesSilentOption(): Promise<void> {
	const calls: CapturedCall[] = [];
	await sendTelegramMarkdownReply(captureCall(calls, new TelegramApiError("sendMessage", "Bad Request: can't parse entities", 400, undefined)), 123, 456, "*oops", { disableNotification: true });
	assert.deepEqual(calls, [
		{
			method: "sendMessage",
			body: { chat_id: 123, message_thread_id: 456, text: "*oops", disable_notification: true, parse_mode: "Markdown" },
		},
		{
			method: "sendMessage",
			body: { chat_id: 123, message_thread_id: 456, text: "*oops", disable_notification: true },
		},
	]);
}

async function assertEditTextMessageUsesInlineKeyboard(): Promise<void> {
	const calls: CapturedCall[] = [];
	const replyMarkup = { inline_keyboard: [[{ text: "More", callback_data: "mp1:t:providers:1" }]] };
	await editTelegramTextMessage(captureCall(calls), 123, 99, "Pick", replyMarkup);
	assert.deepEqual(calls, [
		{
			method: "editMessageText",
			body: { chat_id: 123, message_id: 99, text: "Pick", reply_markup: replyMarkup },
		},
	]);
}

async function assertMarkdownRetryAfterPropagates(): Promise<void> {
	const calls: CapturedCall[] = [];
	await assert.rejects(
		() => sendTelegramMarkdownReply(captureCall(calls, new TelegramApiError("sendMessage", "Too Many Requests", 429, 3)), 123, undefined, "hello"),
		/Too Many Requests/,
	);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.body.parse_mode, "Markdown");
}

await assertSilentTextReply();
await assertNormalTextReplyDoesNotDisableNotifications();
await assertSilentChunking();
await assertReplyMarkupOnlyAttachedToLastChunk();
await assertEditTextMessageUsesInlineKeyboard();
await assertMarkdownFallbackPreservesSilentOption();
await assertMarkdownRetryAfterPropagates();
console.log("Telegram text reply checks passed");
