import { readFile, stat } from "node:fs/promises";

import { TELEGRAM_PREFIX } from "../shared/config.js";
import type { DownloadedTelegramFile, PendingTelegramTurn, TelegramFileInfo, TelegramMessage } from "../shared/types.js";
import { guessExtensionFromMime, guessMediaType, isImageMimeType } from "../shared/format.js";
import { hashSecret, randomId } from "../shared/utils.js";

const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES_TOTAL = 8 * 1024 * 1024;

export function collectTelegramFileInfos(messages: TelegramMessage[]): TelegramFileInfo[] {
	const files: TelegramFileInfo[] = [];
	for (const message of messages) {
		if (Array.isArray(message.photo) && message.photo.length > 0) {
			const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
			if (photo) files.push({ file_id: photo.file_id, fileName: `photo-${message.message_id}.jpg`, mimeType: "image/jpeg", isImage: true, fileSize: photo.file_size });
		}
		if (message.document) {
			const fileName = message.document.file_name || `document-${message.message_id}${guessExtensionFromMime(message.document.mime_type, "")}`;
			files.push({ file_id: message.document.file_id, fileName, mimeType: message.document.mime_type, isImage: isImageMimeType(message.document.mime_type), fileSize: message.document.file_size });
		}
		if (message.video) {
			const fileName = message.video.file_name || `video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`;
			files.push({ file_id: message.video.file_id, fileName, mimeType: message.video.mime_type, isImage: false, fileSize: message.video.file_size });
		}
		if (message.audio) {
			const fileName = message.audio.file_name || `audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`;
			files.push({ file_id: message.audio.file_id, fileName, mimeType: message.audio.mime_type, isImage: false, fileSize: message.audio.file_size });
		}
		if (message.voice) files.push({ file_id: message.voice.file_id, fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`, mimeType: message.voice.mime_type, isImage: false, fileSize: message.voice.file_size });
		if (message.animation) {
			const fileName = message.animation.file_name || `animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`;
			files.push({ file_id: message.animation.file_id, fileName, mimeType: message.animation.mime_type, isImage: false, fileSize: message.animation.file_size });
		}
		if (message.sticker) files.push({ file_id: message.sticker.file_id, fileName: `sticker-${message.message_id}.webp`, mimeType: "image/webp", isImage: true, fileSize: message.sticker.file_size });
	}
	return files;
}

export async function buildTelegramFiles(
	messages: TelegramMessage[],
	downloadTelegramFile: (fileId: string, suggestedName: string, fileSize?: number) => Promise<string>,
): Promise<DownloadedTelegramFile[]> {
	const downloaded: DownloadedTelegramFile[] = [];
	for (const file of collectTelegramFileInfos(messages)) {
		const path = await downloadTelegramFile(file.file_id, file.fileName, file.fileSize);
		downloaded.push({ path, fileName: file.fileName, isImage: file.isImage, mimeType: file.mimeType });
	}
	return downloaded;
}

export async function createTelegramTurnForSession(
	messages: TelegramMessage[],
	sessionIdForTurn: string,
	downloadTelegramFile: (fileId: string, suggestedName: string, fileSize?: number) => Promise<string>,
): Promise<PendingTelegramTurn> {
	const turn = await createTelegramTurn(messages, sessionIdForTurn, randomId, downloadTelegramFile);
	const sourceKey = messages.map((message) => `${message.chat.id}:${message.message_thread_id ?? "default"}:${message.message_id}:${message.edit_date ?? "original"}:${hashSecret(message.text ?? message.caption ?? "")}`).join("|");
	turn.turnId = `turn_${hashSecret(sourceKey).slice(0, 16)}`;
	return turn;
}

export function durableTelegramTurn(turn: PendingTelegramTurn): PendingTelegramTurn {
	const imageCount = turn.content.filter((part) => part.type === "image").length;
	if (imageCount === 0) return turn;
	return {
		...turn,
		content: [
			...turn.content.filter((part) => part.type !== "image"),
			{ type: "text", text: `${imageCount} Telegram image attachment(s) were omitted from durable broker state; use the local attachment path(s) in this message if the turn is retried.` },
		],
	};
}

export function formatTelegramHistoryText(rawText: string, files: DownloadedTelegramFile[]): string {
	let summary = rawText.length > 0 ? rawText : "(no text)";
	if (files.length > 0) {
		summary += `\nAttachments:`;
		for (const file of files) summary += `\n- ${file.path}`;
	}
	return summary;
}

export async function createTelegramTurn(
	messages: TelegramMessage[],
	sessionIdForTurn: string,
	randomId: (prefix: string) => string,
	downloadTelegramFile: (fileId: string, suggestedName: string, fileSize?: number) => Promise<string>,
): Promise<PendingTelegramTurn> {
	const firstMessage = messages[0];
	if (!firstMessage) throw new Error("Missing Telegram message for turn creation");
	const rawText = messages.map((message) => (message.text || message.caption || "").trim()).filter(Boolean).join("\n\n");
	const files = await buildTelegramFiles(messages, downloadTelegramFile);
	const content: PendingTelegramTurn["content"] = [];
	let prompt = `${TELEGRAM_PREFIX}`;
	if (rawText.length > 0) prompt += ` ${rawText}`;
	if (files.length > 0) {
		prompt += `\n\nTelegram attachments were saved locally:`;
		for (const file of files) prompt += `\n- ${file.path}`;
	}
	content.push({ type: "text", text: prompt });
	let inlineImageBytes = 0;
	let skippedInlineImages = 0;
	for (const file of files) {
		if (!file.isImage) continue;
		const mediaType = file.mimeType || guessMediaType(file.path);
		if (!mediaType) continue;
		const fileStat = await stat(file.path).catch(() => undefined);
		if ((fileStat?.size ?? 0) > MAX_INLINE_IMAGE_BYTES || (fileStat?.size !== undefined && inlineImageBytes + fileStat.size > MAX_INLINE_IMAGE_BYTES_TOTAL)) {
			skippedInlineImages += 1;
			continue;
		}
		const buffer = await readFile(file.path);
		if (buffer.byteLength > MAX_INLINE_IMAGE_BYTES || inlineImageBytes + buffer.byteLength > MAX_INLINE_IMAGE_BYTES_TOTAL) {
			skippedInlineImages += 1;
			continue;
		}
		inlineImageBytes += buffer.byteLength;
		content.push({ type: "image", data: buffer.toString("base64"), mimeType: mediaType });
	}
	if (skippedInlineImages > 0) {
		content.push({ type: "text", text: `${skippedInlineImages} Telegram image attachment(s) were not embedded inline because they are too large; use the local file path(s) listed above if needed.` });
	}
	return {
		turnId: randomId("turn"),
		sessionId: sessionIdForTurn,
		chatId: firstMessage.chat.id,
		messageThreadId: firstMessage.message_thread_id,
		replyToMessageId: firstMessage.message_id,
		queuedAttachments: [],
		content,
		historyText: formatTelegramHistoryText(rawText, files),
	};
}
