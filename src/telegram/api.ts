import { randomBytes } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MAX_FILE_BYTES, MAX_TELEGRAM_DOWNLOAD_BYTES, TEMP_DIR } from "../shared/config.js";
import type { TelegramApiResponse, TelegramGetFileResult } from "../shared/types.js";
import { sanitizeFileName } from "../shared/format.js";
import { ensurePrivateDir } from "../shared/utils.js";
import { telegramSessionTempDir } from "./temp-files.js";

export class TelegramApiError extends Error {
	constructor(
		readonly method: string,
		readonly description: string | undefined,
		readonly errorCode: number | undefined,
		readonly retryAfterSeconds: number | undefined,
	) {
		const retry = retryAfterSeconds === undefined || description?.includes("retry after") ? "" : ` retry after ${retryAfterSeconds}s`;
		super(description ? `${description}${retry}` : `Telegram API ${method} failed${retry}`);
		this.name = "TelegramApiError";
	}
}

export function getTelegramRetryAfterMs(error: unknown): number | undefined {
	if (error instanceof TelegramApiError && error.retryAfterSeconds !== undefined) return Math.max(0, error.retryAfterSeconds * 1000);
	if (error instanceof Error) {
		const match = error.message.match(/retry after (\d+)s?\b/i);
		if (match) return Number(match[1]) * 1000;
	}
	return undefined;
}

function telegramApiError<TResponse>(method: string, data: TelegramApiResponse<TResponse>): TelegramApiError {
	return new TelegramApiError(method, data.description, data.error_code, data.parameters?.retry_after);
}

export async function callTelegram<TResponse>(
	botToken: string | undefined,
	method: string,
	body: Record<string, unknown>,
	options?: { signal?: AbortSignal },
): Promise<TResponse> {
	if (!botToken) throw new Error("Telegram bot token is not configured");
	const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: options?.signal,
	});
	const data = (await response.json()) as TelegramApiResponse<TResponse>;
	if (!data.ok || data.result === undefined) throw telegramApiError(method, data);
	return data.result;
}

export async function callTelegramMultipart<TResponse>(
	botToken: string | undefined,
	method: string,
	fields: Record<string, string>,
	fileField: string,
	filePath: string,
	fileName: string,
	options?: { signal?: AbortSignal },
): Promise<TResponse> {
	if (!botToken) throw new Error("Telegram bot token is not configured");
	const stats = await stat(filePath);
	if (!stats.isFile()) throw new Error(`Not a file: ${filePath}`);
	if (stats.size > MAX_FILE_BYTES) throw new Error(`File too large: ${fileName}`);
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	const buffer = await readFile(filePath);
	form.set(fileField, new Blob([buffer]), fileName);
	const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
		method: "POST",
		body: form,
		signal: options?.signal,
	});
	const data = (await response.json()) as TelegramApiResponse<TResponse>;
	if (!data.ok || data.result === undefined) throw telegramApiError(method, data);
	return data.result;
}

export async function downloadTelegramFile(
	botToken: string | undefined,
	sessionId: string,
	fileId: string,
	suggestedName: string,
	fileSize?: number,
): Promise<string> {
	if (fileSize !== undefined && fileSize > MAX_TELEGRAM_DOWNLOAD_BYTES) throw new Error(`Telegram file too large to download via Bot API: ${suggestedName}`);
	if (!botToken) throw new Error("Telegram bot token is not configured");
	const file = await callTelegram<TelegramGetFileResult>(botToken, "getFile", { file_id: fileId });
	if (!file.file_path) throw new Error(`Telegram file is not currently downloadable: ${suggestedName}`);
	if (file.file_size !== undefined && file.file_size > MAX_TELEGRAM_DOWNLOAD_BYTES) throw new Error(`Telegram file too large to download via Bot API: ${suggestedName}`);
	const dir = telegramSessionTempDir(sessionId);
	await ensurePrivateDir(TEMP_DIR);
	await ensurePrivateDir(dir);
	const targetPath = join(dir, `${Date.now()}-${randomBytes(4).toString("hex")}-${sanitizeFileName(suggestedName)}`);
	const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
	if (!response.ok) {
		const data = await response.json().catch(() => undefined) as TelegramApiResponse<unknown> | undefined;
		const retryAfterHeader = Number(response.headers.get("retry-after"));
		const retryAfterSeconds = data?.parameters?.retry_after ?? (Number.isFinite(retryAfterHeader) ? retryAfterHeader : undefined);
		throw new TelegramApiError("downloadFile", data?.description ?? `Failed to download Telegram file: ${response.status}`, data?.error_code ?? response.status, retryAfterSeconds);
	}
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_TELEGRAM_DOWNLOAD_BYTES) throw new Error(`Telegram file too large to download via Bot API: ${suggestedName}`);
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Telegram file response did not include a body");
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > MAX_TELEGRAM_DOWNLOAD_BYTES) throw new Error(`Telegram file too large to download via Bot API: ${suggestedName}`);
		chunks.push(value);
	}
	await writeFile(targetPath, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes), { mode: 0o600 });
	await chmod(targetPath, 0o600).catch(() => undefined);
	return targetPath;
}
