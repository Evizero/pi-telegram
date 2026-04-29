import { errorMessage } from "../shared/utils.js";
import { getTelegramRetryAfterMs, TelegramApiError } from "./api.js";

export function telegramErrorDescription(error: TelegramApiError): string {
	return error.description ?? error.message;
}

export function telegramErrorText(error: unknown): string {
	if (error instanceof TelegramApiError) return `${error.method}: ${telegramErrorDescription(error)}`;
	return errorMessage(error);
}

export function isTelegramRetryAfterError(error: unknown): boolean {
	return getTelegramRetryAfterMs(error) !== undefined;
}

export function isTelegramFormattingError(error: unknown): boolean {
	return error instanceof TelegramApiError
		&& error.errorCode === 400
		&& /parse entities|can't parse entities|can't find end of/i.test(telegramErrorDescription(error));
}

export function isTelegramMessageNotModified(error: unknown): boolean {
	return error instanceof TelegramApiError
		&& error.errorCode === 400
		&& /message is not modified/i.test(telegramErrorDescription(error));
}

export function isMissingEditableTelegramMessage(error: unknown): boolean {
	return error instanceof TelegramApiError
		&& error.errorCode === 400
		&& /message to edit not found|message can't be edited|message cannot be edited/i.test(telegramErrorDescription(error));
}

export function isMissingDeletedTelegramMessage(error: unknown): boolean {
	return error instanceof TelegramApiError
		&& error.errorCode === 400
		&& /message to delete not found/i.test(telegramErrorDescription(error));
}

export function shouldPreserveTelegramMessageRefOnDeleteFailure(error: unknown): boolean {
	if (!(error instanceof TelegramApiError)) return true;
	if (isTelegramRetryAfterError(error)) return true;
	const errorCode = error.errorCode ?? 0;
	return errorCode >= 500;
}

export function shouldRetryTelegramMessageCleanup(error: unknown): boolean {
	if (!(error instanceof TelegramApiError)) return true;
	if (isTelegramRetryAfterError(error)) return true;
	const errorCode = error.errorCode ?? 0;
	return errorCode >= 500;
}

export function isDraftMethodUnsupported(error: unknown): boolean {
	return error instanceof TelegramApiError
		&& (error.errorCode === 404 || /method\s+not\s+found|not\s+found\s+method/i.test(telegramErrorDescription(error)));
}

export function isTransientTelegramMessageEditError(error: unknown): boolean {
	if (!(error instanceof TelegramApiError)) return true;
	return error.errorCode === undefined || error.errorCode >= 500;
}

export function isAlreadyDeletedTelegramTopic(error: unknown): boolean {
	if (!(error instanceof TelegramApiError)) return false;
	if (error.errorCode !== 400) return false;
	return /message\s+thread\s+not\s+found|thread\s+not\s+found|topic\s+not\s+found|message\s+thread\s+.*closed|topic\s+.*closed/i.test(telegramErrorDescription(error));
}

export function isTerminalTelegramTopicCleanupError(error: unknown): boolean {
	if (!(error instanceof TelegramApiError)) return false;
	if (isTelegramRetryAfterError(error)) return false;
	const description = telegramErrorDescription(error).toLowerCase();
	if (error.errorCode === 401) return true;
	if (error.errorCode === 403) {
		return /forbidden|bot\s+was\s+kicked|bot\s+was\s+blocked|bot\s+is\s+not\s+a\s+member|not\s+enough\s+rights|can't\s+delete|cannot\s+delete/.test(description);
	}
	if (error.errorCode === 400) {
		return /chat\s+not\s+found|bot\s+is\s+not\s+a\s+member|not\s+enough\s+rights|can't\s+delete|cannot\s+delete/.test(description);
	}
	return false;
}

export function isTerminalTelegramFinalDeliveryError(error: unknown): boolean {
	if (!(error instanceof TelegramApiError)) return false;
	if (isTelegramRetryAfterError(error)) return false;
	const description = telegramErrorDescription(error).toLowerCase();
	if (error.errorCode === 401) return true;
	if (error.errorCode === 403) {
		return /bot\s+was\s+blocked|bot\s+was\s+kicked|user\s+is\s+deactivated|forbidden|not\s+enough\s+rights|can't\s+send|cannot\s+send|can't\s+(?:be\s+)?delete(?:d)?|cannot\s+(?:be\s+)?delete(?:d)?/.test(description);
	}
	if (error.errorCode === 400) {
		return /chat\s+not\s+found|message\s+thread\s+not\s+found|thread\s+not\s+found|topic\s+not\s+found|topic\s+.*closed|message\s+thread\s+.*closed|bot\s+is\s+not\s+a\s+member|not\s+enough\s+rights|can't\s+send|cannot\s+send|can't\s+(?:be\s+)?delete(?:d)?|cannot\s+(?:be\s+)?delete(?:d)?/.test(description);
	}
	return false;
}

export function isSendPhotoContractError(error: unknown): boolean {
	if (!(error instanceof TelegramApiError)) return false;
	if (isTelegramRetryAfterError(error)) return false;
	if (error.errorCode !== 400) return false;
	const description = telegramErrorDescription(error).toLowerCase();
	return /image_process_failed|photo_(?:invalid|ext_invalid|invalid_dimensions)|invalid\s+photo|photo\s+invalid|wrong\s+file\s+identifier|invalid\s+file|file\s+is\s+too\s+big|request\s+entity\s+too\s+large/.test(description);
}
