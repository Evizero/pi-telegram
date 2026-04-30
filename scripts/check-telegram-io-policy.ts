import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_MESSAGE_LENGTH } from "../src/telegram/policy.js";
import { callTelegram, callTelegramMultipart } from "../src/telegram/api.js";
import { getTelegramRetryAfterMs, TelegramApiError } from "../src/telegram/api-errors.js";
import {
	isAlreadyDeletedTelegramTopic,
	isMissingDeletedTelegramMessage,
	isMissingEditableTelegramMessage,
	isSendPhotoContractError,
	isTelegramFormattingError,
	isTelegramMessageNotModified,
	isTerminalTelegramFinalDeliveryError,
	isTerminalTelegramTopicCleanupError,
} from "../src/telegram/errors.js";
import { deleteTelegramMessage, editOrSendTelegramText, editOrSendTelegramTextFully, editTelegramTextMessage, sendTelegramMarkdownReply, TelegramTextDeliveryProgressError, type TelegramJsonCall } from "../src/telegram/message-ops.js";

interface CapturedCall {
	method: string;
	body: Record<string, unknown>;
}

function captureCall(calls: CapturedCall[], fail?: (method: string, body: Record<string, unknown>, index: number) => unknown): TelegramJsonCall {
	let count = 0;
	return async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		count += 1;
		calls.push({ method, body });
		const failure = fail?.(method, body, count);
		if (failure) throw failure;
		return { message_id: 100 + count } as TResponse;
	};
}

async function withFetch(mock: typeof fetch, fn: () => Promise<void>): Promise<void> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = mock;
	try {
		await fn();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function assertJsonApiPreservesHttpRetryAfter(): Promise<void> {
	await withFetch(async () => new Response("gateway rate limited", { status: 429, headers: { "retry-after": "4" } }), async () => {
		await assert.rejects(
			() => callTelegram("token", "sendMessage", { chat_id: 1, text: "hello" }),
			(error: unknown) => {
				assert.equal(error instanceof TelegramApiError, true);
				const telegramError = error as TelegramApiError;
				assert.equal(telegramError.method, "sendMessage");
				assert.equal(telegramError.errorCode, 429);
				assert.equal(telegramError.httpStatus, 429);
				assert.equal(getTelegramRetryAfterMs(error), 4000);
				return true;
			},
		);
	});
}

async function assertMultipartApiPreservesStructuredRetryAfter(): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-telegram-io-policy-"));
	try {
		const filePath = join(dir, "upload.txt");
		await writeFile(filePath, "hello");
		await withFetch(async () => Response.json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } }, { status: 429 }), async () => {
			await assert.rejects(
				() => callTelegramMultipart("token", "sendDocument", { chat_id: "1" }, "document", filePath, "upload.txt"),
				(error: unknown) => {
					assert.equal(error instanceof TelegramApiError, true);
					assert.equal((error as TelegramApiError).retryAfterSeconds, 7);
					assert.equal(getTelegramRetryAfterMs(error), 7000);
					return true;
				},
			);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function assertMarkdownFallbackDoesNotHideRateLimit(): Promise<void> {
	const calls: CapturedCall[] = [];
	await sendTelegramMarkdownReply(captureCall(calls, (_method, _body, index) => index === 1 ? new TelegramApiError("sendMessage", "Bad Request: can't parse entities", 400, undefined) : undefined), 123, 456, "*oops");
	assert.deepEqual(calls.map((call) => call.body.parse_mode), ["Markdown", undefined]);
	assert.equal(calls[1]?.body.message_thread_id, 456);

	const rateLimitCalls: CapturedCall[] = [];
	await assert.rejects(
		() => sendTelegramMarkdownReply(captureCall(rateLimitCalls, () => new TelegramApiError("sendMessage", "Too Many Requests", 429, 5)), 123, 456, "hello"),
		/Too Many Requests/,
	);
	assert.equal(rateLimitCalls.length, 1);
}

async function assertEditAndDeleteHelpersClassifyMessages(): Promise<void> {
	const editCalls: CapturedCall[] = [];
	await editTelegramTextMessage(captureCall(editCalls, () => new TelegramApiError("editMessageText", "Bad Request: message is not modified", 400, undefined)), 123, 9, "same");
	assert.equal(editCalls.length, 1);

	const fallbackCalls: CapturedCall[] = [];
	const messageId = await editOrSendTelegramText(
		captureCall(fallbackCalls, (method) => method === "editMessageText" ? new TelegramApiError("editMessageText", "Bad Request: message to edit not found", 400, undefined) : undefined),
		async (chatId, messageThreadId, text) => {
			fallbackCalls.push({ method: "sendTextReply", body: { chat_id: chatId, message_thread_id: messageThreadId, text } });
			return 77;
		},
		123,
		456,
		9,
		"replacement",
		{ fallbackOn: "missing-editable" },
	);
	assert.equal(messageId, 77);
	assert.deepEqual(fallbackCalls.map((call) => call.method), ["editMessageText", "sendTextReply"]);
	assert.equal(fallbackCalls[1]?.body.message_thread_id, 456);

	const deleteCalls: CapturedCall[] = [];
	const result = await deleteTelegramMessage(captureCall(deleteCalls, () => new TelegramApiError("deleteMessage", "Bad Request: message to delete not found", 400, undefined)), 123, 9, { ignoreMissing: true });
	assert.equal(result, "missing");
}

async function assertFullEditOrSendFallbackSendsAllChunks(): Promise<void> {
	const calls: CapturedCall[] = [];
	const longText = `${"a".repeat(MAX_MESSAGE_LENGTH)}${"b".repeat(12)}`;
	const messageId = await editOrSendTelegramTextFully(
		captureCall(calls, (method) => method === "editMessageText" ? new TelegramApiError("editMessageText", "Bad Request: message to edit not found", 400, undefined) : undefined),
		123,
		456,
		9,
		longText,
		{ fallbackOn: "missing-editable", replyMarkup: { inline_keyboard: [[{ text: "Done", callback_data: "done" }]] } },
	);
	assert.equal(messageId, 103);
	assert.deepEqual(calls.map((call) => call.method), ["editMessageText", "sendMessage", "sendMessage"]);
	assert.equal(calls[1]?.body.message_thread_id, 456);
	assert.equal(calls[1]?.body.text, "a".repeat(MAX_MESSAGE_LENGTH));
	assert.equal(calls[1]?.body.reply_markup, undefined);
	assert.equal(calls[2]?.body.text, "b".repeat(12));
	assert.deepEqual(calls[2]?.body.reply_markup, { inline_keyboard: [[{ text: "Done", callback_data: "done" }]] });
}

async function assertFullEditProgressFailureDoesNotFallbackSend(): Promise<void> {
	const calls: CapturedCall[] = [];
	await assert.rejects(
		() => editOrSendTelegramTextFully(captureCall(calls), 123, 456, 9, `${"a".repeat(MAX_MESSAGE_LENGTH)}${"b".repeat(12)}`, {
			progress: {},
			onProgress: async () => {
				throw new Error("persist failed");
			},
		}),
		(error: unknown) => error instanceof TelegramTextDeliveryProgressError,
	);
	assert.deepEqual(calls.map((call) => call.method), ["editMessageText"]);
}

function assertCentralClassifiers(): void {
	assert.equal(isTelegramFormattingError(new TelegramApiError("sendMessage", "Bad Request: can't parse entities", 400, undefined)), true);
	assert.equal(isTelegramMessageNotModified(new TelegramApiError("editMessageText", "Bad Request: message is not modified", 400, undefined)), true);
	assert.equal(isMissingEditableTelegramMessage(new TelegramApiError("editMessageText", "Bad Request: message can't be edited", 400, undefined)), true);
	assert.equal(isMissingDeletedTelegramMessage(new TelegramApiError("deleteMessage", "Bad Request: message to delete not found", 400, undefined)), true);
	assert.equal(isAlreadyDeletedTelegramTopic(new TelegramApiError("deleteForumTopic", "Bad Request: message thread not found", 400, undefined)), true);
	assert.equal(isTerminalTelegramTopicCleanupError(new TelegramApiError("deleteForumTopic", "Forbidden: bot was kicked", 403, undefined)), true);
	assert.equal(isTerminalTelegramTopicCleanupError(new TelegramApiError("deleteForumTopic", "Too Many Requests", 429, 2)), false);
	assert.equal(isSendPhotoContractError(new TelegramApiError("sendPhoto", "Bad Request: IMAGE_PROCESS_FAILED", 400, undefined)), true);
	assert.equal(isSendPhotoContractError(new TelegramApiError("sendPhoto", "Too Many Requests", 429, 2)), false);
	assert.equal(isTerminalTelegramFinalDeliveryError(new TelegramApiError("sendMessage", "Bad Request: message thread not found", 400, undefined)), true);
}

await assertJsonApiPreservesHttpRetryAfter();
await assertMultipartApiPreservesStructuredRetryAfter();
await assertMarkdownFallbackDoesNotHideRateLimit();
await assertEditAndDeleteHelpersClassifyMessages();
await assertFullEditOrSendFallbackSendsAllChunks();
await assertFullEditProgressFailureDoesNotFallbackSend();
assertCentralClassifiers();
console.log("Telegram IO policy checks passed");
