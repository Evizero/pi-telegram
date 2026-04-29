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
		readonly httpStatus?: number,
	) {
		const retry = retryAfterSeconds === undefined || description?.includes("retry after") ? "" : ` retry after ${retryAfterSeconds}s`;
		const status = httpStatus === undefined || errorCode === httpStatus ? "" : ` HTTP ${httpStatus}`;
		super(description ? `${description}${retry}` : `Telegram API ${method} failed${status}${retry}`);
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

function parseRetryAfterHeader(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds);
	const dateMs = Date.parse(value);
	if (!Number.isFinite(dateMs)) return undefined;
	return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
}

async function readTelegramApiResponse<TResponse>(response: Response): Promise<TelegramApiResponse<TResponse> | undefined> {
	return await response.json().catch(() => undefined) as TelegramApiResponse<TResponse> | undefined;
}

function telegramApiError<TResponse>(method: string, response: Response, data?: TelegramApiResponse<TResponse>): TelegramApiError {
	const httpStatus = response.status;
	const retryAfterSeconds = data?.parameters?.retry_after ?? parseRetryAfterHeader(response.headers?.get("retry-after") ?? null);
	const errorCode = data?.error_code ?? httpStatus;
	const description = data?.description ?? `Telegram API ${method} failed with HTTP ${httpStatus}`;
	return new TelegramApiError(method, description, errorCode, retryAfterSeconds, httpStatus);
}

async function readTelegramResult<TResponse>(method: string, response: Response): Promise<TResponse> {
	const data = await readTelegramApiResponse<TResponse>(response);
	if (response.ok === false || !data?.ok || data.result === undefined) throw telegramApiError(method, response, data);
	return data.result;
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
	return await readTelegramResult<TResponse>(method, response);
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
	return await readTelegramResult<TResponse>(method, response);
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
		const data = await readTelegramApiResponse<unknown>(response);
		throw telegramApiError("downloadFile", response, data);
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
