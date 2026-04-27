import { chunkParagraphs } from "../shared/format.js";
import type { InlineKeyboardMarkup, TelegramSentMessage } from "../shared/types.js";
import { getTelegramRetryAfterMs, TelegramApiError } from "./api.js";

export type TelegramJsonCall = <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;

export interface SendTextReplyOptions {
	disableNotification?: boolean;
	replyMarkup?: InlineKeyboardMarkup;
}

function textMessageBody(chatId: number | string, messageThreadId: number | undefined, text: string, options?: SendTextReplyOptions): Record<string, unknown> {
	const body: Record<string, unknown> = { chat_id: chatId, text };
	if (messageThreadId !== undefined) body.message_thread_id = messageThreadId;
	if (options?.disableNotification) body.disable_notification = true;
	if (options?.replyMarkup) body.reply_markup = options.replyMarkup;
	return body;
}

export async function sendTelegramTextReply(
	callTelegram: TelegramJsonCall,
	chatId: number | string,
	messageThreadId: number | undefined,
	text: string,
	options?: SendTextReplyOptions,
): Promise<number | undefined> {
	const chunks = chunkParagraphs(text || " ");
	let lastMessageId: number | undefined;
	for (let index = 0; index < chunks.length; index += 1) {
		const chunkOptions = index === chunks.length - 1 ? options : { ...options, replyMarkup: undefined };
		const sent = await callTelegram<TelegramSentMessage>("sendMessage", textMessageBody(chatId, messageThreadId, chunks[index]!, chunkOptions));
		lastMessageId = sent.message_id;
	}
	return lastMessageId;
}

export async function sendTelegramMarkdownReply(
	callTelegram: TelegramJsonCall,
	chatId: number | string,
	messageThreadId: number | undefined,
	text: string,
	options?: SendTextReplyOptions,
): Promise<number | undefined> {
	const chunks = chunkParagraphs(text || " ");
	let lastMessageId: number | undefined;
	for (const chunk of chunks) {
		const body = { ...textMessageBody(chatId, messageThreadId, chunk, options), parse_mode: "Markdown" };
		try {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", body);
			lastMessageId = sent.message_id;
		} catch (error) {
			if (getTelegramRetryAfterMs(error) !== undefined || !isTelegramFormattingError(error)) throw error;
			lastMessageId = await sendTelegramTextReply(callTelegram, chatId, messageThreadId, chunk, options);
		}
	}
	return lastMessageId;
}

export async function editTelegramTextMessage(
	callTelegram: TelegramJsonCall,
	chatId: number | string,
	messageId: number,
	text: string,
	replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
	const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text: chunkParagraphs(text || " ")[0] ?? " " };
	if (replyMarkup) body.reply_markup = replyMarkup;
	try {
		await callTelegram("editMessageText", body);
	} catch (error) {
		if (isTelegramMessageNotModified(error)) return;
		throw error;
	}
}

export async function answerTelegramCallbackQuery(
	callTelegram: TelegramJsonCall,
	callbackQueryId: string,
	text?: string,
	options?: { showAlert?: boolean },
): Promise<void> {
	const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
	if (text) body.text = text.slice(0, 200);
	if (options?.showAlert) body.show_alert = true;
	await callTelegram("answerCallbackQuery", body);
}

function isTelegramFormattingError(error: unknown): boolean {
	return error instanceof TelegramApiError
		&& error.errorCode === 400
		&& /parse entities|can't parse entities|can't find end of/i.test(error.description ?? error.message);
}

function isTelegramMessageNotModified(error: unknown): boolean {
	return error instanceof TelegramApiError
		&& error.errorCode === 400
		&& /message is not modified/i.test(error.description ?? error.message);
}
