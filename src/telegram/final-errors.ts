import { getTelegramRetryAfterMs, TelegramApiError } from "./api.js";

export function isTerminalTelegramFinalDeliveryError(error: unknown): boolean {
	if (!(error instanceof TelegramApiError)) return false;
	if (getTelegramRetryAfterMs(error) !== undefined) return false;
	const description = (error.description ?? error.message).toLowerCase();
	if (error.errorCode === 401) return true;
	if (error.errorCode === 403) {
		return /bot\s+was\s+blocked|bot\s+was\s+kicked|user\s+is\s+deactivated|forbidden|not\s+enough\s+rights|can't\s+send|cannot\s+send|can't\s+(?:be\s+)?delete(?:d)?|cannot\s+(?:be\s+)?delete(?:d)?/.test(description);
	}
	if (error.errorCode === 400) {
		return /chat\s+not\s+found|message\s+thread\s+not\s+found|thread\s+not\s+found|topic\s+not\s+found|topic\s+.*closed|message\s+thread\s+.*closed|bot\s+is\s+not\s+a\s+member|not\s+enough\s+rights|can't\s+send|cannot\s+send|can't\s+(?:be\s+)?delete(?:d)?|cannot\s+(?:be\s+)?delete(?:d)?/.test(description);
	}
	return false;
}

export function terminalTelegramFinalDeliveryReason(error: unknown): string {
	if (error instanceof TelegramApiError) return `${error.method}: ${error.description ?? error.message}`;
	return error instanceof Error ? error.message : String(error);
}
