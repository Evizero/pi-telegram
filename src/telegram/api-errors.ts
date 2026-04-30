import type { TelegramApiResponse } from "./types.js";

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

export function telegramApiError<TResponse>(method: string, response: Response, data?: TelegramApiResponse<TResponse>): TelegramApiError {
	const httpStatus = response.status;
	const retryAfterSeconds = data?.parameters?.retry_after ?? parseRetryAfterHeader(response.headers?.get("retry-after") ?? null);
	const errorCode = data?.error_code ?? httpStatus;
	const description = data?.description ?? `Telegram API ${method} failed with HTTP ${httpStatus}`;
	return new TelegramApiError(method, description, errorCode, retryAfterSeconds, httpStatus);
}
