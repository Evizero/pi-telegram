import { getTelegramRetryAfterMs } from "./api.js";

export async function withTelegramRetry<T>(operation: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
	while (true) {
		try {
			return await operation(signal);
		} catch (error) {
			const retryAfterMs = getTelegramRetryAfterMs(error);
			if (retryAfterMs === undefined || signal?.aborted) throw error;
			await sleep(retryAfterMs + 250, signal);
		}
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		}, { once: true });
	});
}
