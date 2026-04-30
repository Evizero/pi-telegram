import { chunkParagraphs } from "../shared/format.js";
import type { InlineKeyboardMarkup, TelegramControlResultDeliveryProgress, TelegramSentMessage } from "./types.js";
import { getTelegramRetryAfterMs } from "./api.js";
import {
	isMissingDeletedTelegramMessage,
	isMissingEditableTelegramMessage,
	isTelegramFormattingError,
	isTelegramMessageNotModified,
	isTelegramRetryAfterError,
} from "./errors.js";

export type TelegramJsonCall = <TResponse>(method: string, body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<TResponse>;

export interface SendTextReplyOptions {
	disableNotification?: boolean;
	replyMarkup?: InlineKeyboardMarkup;
	signal?: AbortSignal;
}

export interface EditOrSendTextOptions {
	replyMarkup?: InlineKeyboardMarkup;
	fallbackOn?: "missing-editable" | "any-non-rate-limit";
	signal?: AbortSignal;
}

export interface EditOrSendFullTextOptions extends EditOrSendTextOptions {
	progress?: TelegramControlResultDeliveryProgress;
	onProgress?: (progress: TelegramControlResultDeliveryProgress) => Promise<void>;
}

export class TelegramTextDeliveryProgressError extends Error {
	constructor(public readonly originalError: unknown) {
		const message = originalError instanceof Error ? originalError.message : String(originalError);
		super(`Failed to persist Telegram text delivery progress: ${message}`);
		this.name = "TelegramTextDeliveryProgressError";
	}
}

export interface DeleteTelegramMessageOptions {
	ignoreMissing?: boolean;
	signal?: AbortSignal;
}

export function textMessageBody(chatId: number | string, messageThreadId: number | undefined, text: string, options?: SendTextReplyOptions): Record<string, unknown> {
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
		const sent = await callTelegram<TelegramSentMessage>("sendMessage", textMessageBody(chatId, messageThreadId, chunks[index]!, chunkOptions), { signal: options?.signal });
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
	for (let index = 0; index < chunks.length; index += 1) {
		const chunkOptions = options;
		const body = { ...textMessageBody(chatId, messageThreadId, chunks[index]!, chunkOptions), parse_mode: "Markdown" };
		try {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", body, { signal: options?.signal });
			lastMessageId = sent.message_id;
		} catch (error) {
			if (isTelegramRetryAfterError(error) || !isTelegramFormattingError(error)) throw error;
			lastMessageId = await sendTelegramTextReply(callTelegram, chatId, messageThreadId, chunks[index]!, chunkOptions);
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
	options?: { signal?: AbortSignal },
): Promise<void> {
	const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text: chunkParagraphs(text || " ")[0] ?? " " };
	if (replyMarkup) body.reply_markup = replyMarkup;
	try {
		await callTelegram("editMessageText", body, { signal: options?.signal });
	} catch (error) {
		if (isTelegramMessageNotModified(error)) return;
		throw error;
	}
}

export async function editTelegramMarkdownMessage(
	callTelegram: TelegramJsonCall,
	chatId: number | string,
	messageId: number,
	text: string,
	options?: { signal?: AbortSignal },
): Promise<void> {
	const truncated = chunkParagraphs(text || " ")[0] ?? " ";
	try {
		await callTelegram("editMessageText", { chat_id: chatId, message_id: messageId, text: truncated, parse_mode: "Markdown" }, { signal: options?.signal });
	} catch (error) {
		if (isTelegramMessageNotModified(error)) return;
		if (isTelegramRetryAfterError(error) || !isTelegramFormattingError(error)) throw error;
		try {
			await callTelegram("editMessageText", { chat_id: chatId, message_id: messageId, text: truncated }, { signal: options?.signal });
		} catch (fallbackError) {
			if (isTelegramMessageNotModified(fallbackError)) return;
			throw fallbackError;
		}
	}
}

export async function editOrSendTelegramText(
	callTelegram: TelegramJsonCall,
	sendTextReply: (chatId: number | string, messageThreadId: number | undefined, text: string, options?: SendTextReplyOptions) => Promise<number | undefined>,
	chatId: number | string,
	messageThreadId: number | undefined,
	messageId: number | undefined,
	text: string,
	options?: EditOrSendTextOptions,
): Promise<number | undefined> {
	if (messageId === undefined) return await sendTextReply(chatId, messageThreadId, text, options?.replyMarkup ? { replyMarkup: options.replyMarkup, signal: options.signal } : { signal: options?.signal });
	try {
		await editTelegramTextMessage(callTelegram, chatId, messageId, text, options?.replyMarkup, { signal: options?.signal });
		return messageId;
	} catch (error) {
		if (isTelegramRetryAfterError(error)) throw error;
		if (options?.fallbackOn === "missing-editable" && !isMissingEditableTelegramMessage(error)) throw error;
		return await sendTextReply(chatId, messageThreadId, text, options?.replyMarkup ? { replyMarkup: options.replyMarkup, signal: options.signal } : { signal: options?.signal });
	}
}

function resetProgress(progress: TelegramControlResultDeliveryProgress, chunks: string[]): void {
	progress.chunks = [...chunks];
	progress.mode = undefined;
	progress.deliveredChunkIndexes = [];
	progress.deliveredMessageIds = {};
}

function progressMatchesText(progress: TelegramControlResultDeliveryProgress, chunks: string[]): boolean {
	return progress.chunks?.length === chunks.length && chunks.every((chunk, index) => progress.chunks?.[index] === chunk);
}

function deliveredIndexes(progress: TelegramControlResultDeliveryProgress): Set<number> {
	return new Set((progress.deliveredChunkIndexes ?? []).filter((index) => Number.isInteger(index) && index >= 0));
}

async function persistTextDeliveryProgress(progress: TelegramControlResultDeliveryProgress, onProgress: ((progress: TelegramControlResultDeliveryProgress) => Promise<void>) | undefined): Promise<void> {
	try {
		await onProgress?.(progress);
	} catch (error) {
		throw new TelegramTextDeliveryProgressError(error);
	}
}

async function markTextChunkDelivered(
	progress: TelegramControlResultDeliveryProgress,
	chunks: string[],
	index: number,
	messageId: number | undefined,
	mode: "edited" | "sent",
	onProgress: ((progress: TelegramControlResultDeliveryProgress) => Promise<void>) | undefined,
): Promise<void> {
	if (!progressMatchesText(progress, chunks)) resetProgress(progress, chunks);
	progress.mode = mode;
	const indexes = deliveredIndexes(progress);
	indexes.add(index);
	progress.deliveredChunkIndexes = [...indexes].sort((left, right) => left - right);
	if (messageId !== undefined) {
		progress.deliveredMessageIds ??= {};
		progress.deliveredMessageIds[String(index)] = messageId;
	}
	await persistTextDeliveryProgress(progress, onProgress);
}

async function setTextDeliveryMode(
	progress: TelegramControlResultDeliveryProgress,
	chunks: string[],
	mode: "edited" | "sent",
	onProgress: ((progress: TelegramControlResultDeliveryProgress) => Promise<void>) | undefined,
): Promise<void> {
	if (!progressMatchesText(progress, chunks)) resetProgress(progress, chunks);
	if (progress.mode === mode) return;
	progress.mode = mode;
	await persistTextDeliveryProgress(progress, onProgress);
}

function lastDeliveredMessageId(progress: TelegramControlResultDeliveryProgress, chunks: string[], fallbackMessageId: number | undefined): number | undefined {
	for (let index = chunks.length - 1; index >= 0; index -= 1) {
		const messageId = progress.deliveredMessageIds?.[String(index)];
		if (messageId !== undefined) return messageId;
	}
	return fallbackMessageId;
}

async function sendTextChunk(
	callTelegram: TelegramJsonCall,
	chatId: number | string,
	messageThreadId: number | undefined,
	chunk: string,
	options: SendTextReplyOptions | undefined,
): Promise<number | undefined> {
	const sent = await callTelegram<TelegramSentMessage>("sendMessage", textMessageBody(chatId, messageThreadId, chunk, options), { signal: options?.signal });
	return sent.message_id;
}

export async function editOrSendTelegramTextFully(
	callTelegram: TelegramJsonCall,
	chatId: number | string,
	messageThreadId: number | undefined,
	messageId: number | undefined,
	text: string,
	options?: EditOrSendFullTextOptions,
): Promise<number | undefined> {
	const chunks = chunkParagraphs(text || " ");
	const progress = options?.progress ?? {};
	if (!progressMatchesText(progress, chunks)) resetProgress(progress, chunks);
	let mode = progress.mode;
	if (!mode && messageId !== undefined) {
		const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text: chunks[0] ?? " " };
		if (options?.replyMarkup) body.reply_markup = options.replyMarkup;
		let edited = false;
		try {
			await callTelegram("editMessageText", body, { signal: options?.signal });
			edited = true;
		} catch (error) {
			if (isTelegramMessageNotModified(error)) {
				edited = true;
			} else {
				if (isTelegramRetryAfterError(error)) throw error;
				if (options?.fallbackOn === "missing-editable" && !isMissingEditableTelegramMessage(error)) throw error;
				await setTextDeliveryMode(progress, chunks, "sent", options?.onProgress);
				mode = "sent";
			}
		}
		if (edited) {
			await markTextChunkDelivered(progress, chunks, 0, messageId, "edited", options?.onProgress);
			mode = "edited";
		}
	}
	if (!mode) {
		await setTextDeliveryMode(progress, chunks, "sent", options?.onProgress);
		mode = "sent";
	}
	const delivered = deliveredIndexes(progress);
	const startIndex = mode === "edited" ? 1 : 0;
	for (let index = startIndex; index < chunks.length; index += 1) {
		if (delivered.has(index)) continue;
		const includeReplyMarkup = mode === "sent" && index === chunks.length - 1;
		const sentMessageId = await sendTextChunk(callTelegram, chatId, messageThreadId, chunks[index]!, includeReplyMarkup ? { replyMarkup: options?.replyMarkup, signal: options?.signal } : { signal: options?.signal });
		delivered.add(index);
		await markTextChunkDelivered(progress, chunks, index, sentMessageId, mode, options?.onProgress);
	}
	return lastDeliveredMessageId(progress, chunks, mode === "edited" ? messageId : undefined);
}

export async function deleteTelegramMessage(
	callTelegram: TelegramJsonCall,
	chatId: number | string,
	messageId: number,
	options?: DeleteTelegramMessageOptions,
): Promise<"deleted" | "missing"> {
	try {
		await callTelegram("deleteMessage", { chat_id: chatId, message_id: messageId }, { signal: options?.signal });
		return "deleted";
	} catch (error) {
		if (options?.ignoreMissing && isMissingDeletedTelegramMessage(error)) return "missing";
		throw error;
	}
}

export async function answerTelegramCallbackQuery(
	callTelegram: TelegramJsonCall,
	callbackQueryId: string,
	text?: string,
	options?: { showAlert?: boolean; signal?: AbortSignal },
): Promise<void> {
	const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
	if (text) body.text = text.slice(0, 200);
	if (options?.showAlert) body.show_alert = true;
	await callTelegram("answerCallbackQuery", body, { signal: options?.signal });
}

export async function answerTelegramCallbackQueryBestEffort(
	callTelegram: TelegramJsonCall,
	callbackQueryId: string,
	text?: string,
	options?: { showAlert?: boolean; signal?: AbortSignal },
): Promise<void> {
	await answerTelegramCallbackQuery(callTelegram, callbackQueryId, text, options).catch((error) => {
		if (getTelegramRetryAfterMs(error) !== undefined) throw error;
	});
}
