import { stat } from "node:fs/promises";

import { MAX_TELEGRAM_PHOTO_BYTES } from "./policy.js";
import { guessMediaType } from "../shared/format.js";
import type { PendingTelegramTurn, QueuedAttachment } from "../client/types.js";
import type { TelegramSentMessage } from "./types.js";
import { errorMessage } from "../shared/utils.js";
import { getTelegramRetryAfterMs } from "./api-errors.js";
import { isSendPhotoContractError } from "./errors.js";

export { isSendPhotoContractError } from "./errors.js";

export async function sendQueuedAttachment(options: {
	turn: PendingTelegramTurn;
	attachment: QueuedAttachment;
	callTelegramMultipart: <TResponse>(method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string) => Promise<TResponse>;
	sendTextReply: (chatId: number | string, messageThreadId: number | undefined, text: string) => Promise<number | undefined>;
}): Promise<void> {
	const { turn, attachment, callTelegramMultipart, sendTextReply } = options;
	const fields: Record<string, string> = { chat_id: String(turn.chatId) };
	if (turn.messageThreadId !== undefined) fields.message_thread_id = String(turn.messageThreadId);
	const mediaType = guessMediaType(attachment.path);
	const size = await stat(attachment.path).then((stats) => stats.size).catch(() => undefined);
	const canSendAsPhoto = Boolean(mediaType) && (size === undefined || size <= MAX_TELEGRAM_PHOTO_BYTES);
	try {
		if (canSendAsPhoto) {
			try {
				await callTelegramMultipart<TelegramSentMessage>("sendPhoto", fields, "photo", attachment.path, attachment.fileName);
				return;
			} catch (error) {
				if (!isSendPhotoContractError(error)) throw error;
				// Telegram photo limits and image validation are stricter than document upload rules. Fall back below.
			}
		}
		await callTelegramMultipart<TelegramSentMessage>("sendDocument", fields, "document", attachment.path, attachment.fileName);
	} catch (error) {
		if (getTelegramRetryAfterMs(error) !== undefined) throw error;
		await sendTextReply(turn.chatId, turn.messageThreadId, `Failed to send attachment ${attachment.fileName}: ${errorMessage(error)}`);
	}
}
