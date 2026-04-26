import { chunkParagraphs } from "../shared/format.js";
import type { TelegramSentMessage } from "../shared/types.js";
import { getTelegramRetryAfterMs } from "./api.js";

export type TelegramJsonCall = <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;

export interface SendTextReplyOptions {
	disableNotification?: boolean;
}

function textMessageBody(chatId: number | string, messageThreadId: number | undefined, text: string, options?: SendTextReplyOptions): Record<string, unknown> {
	const body: Record<string, unknown> = { chat_id: chatId, text };
	if (messageThreadId !== undefined) body.message_thread_id = messageThreadId;
	if (options?.disableNotification) body.disable_notification = true;
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
	for (const chunk of chunks) {
		const sent = await callTelegram<TelegramSentMessage>("sendMessage", textMessageBody(chatId, messageThreadId, chunk, options));
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
			if (getTelegramRetryAfterMs(error) !== undefined) throw error;
			lastMessageId = await sendTelegramTextReply(callTelegram, chatId, messageThreadId, chunk, options);
		}
	}
	return lastMessageId;
}
