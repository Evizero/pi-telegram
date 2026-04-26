const RETRYABLE_ASSISTANT_ERROR_RE = /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

export function isRetryableAssistantError(stopReason?: string, errorMessage?: string): boolean {
	if (stopReason !== "error" || !errorMessage) return false;
	return RETRYABLE_ASSISTANT_ERROR_RE.test(errorMessage);
}

export function formatAssistantFailureText(stopReason?: string, errorMessage?: string): string {
	if (stopReason === "aborted") return "Telegram bridge: pi aborted the request.";
	const detail = errorMessage?.trim();
	if (!detail) return "Telegram bridge: pi failed while processing the request.";
	return `Telegram bridge: pi failed while processing the request: ${detail}`;
}

export { RETRYABLE_ASSISTANT_ERROR_RE };
