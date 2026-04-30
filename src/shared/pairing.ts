export const PAIRING_PIN_DIGITS = 4;
export const PAIRING_PIN_TTL_MS = 5 * 60 * 1000;
export const PAIRING_MAX_FAILED_ATTEMPTS = 5;

interface PairingConfig {
	allowedUserId?: number;
	pairingCodeHash?: string;
	pairingCreatedAtMs?: number;
	pairingExpiresAtMs?: number;
	pairingFailedAttempts?: number;
}

interface TelegramDatedMessage {
	date?: number;
}

export function pairingCandidateFromText(text: string | undefined): string | undefined {
	const trimmed = (text ?? "").trim();
	if (!trimmed) return undefined;
	const startMatch = trimmed.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/i);
	if (startMatch) return startMatch[1]?.trim();
	if (/^\d{4}$/.test(trimmed)) return trimmed;
	return undefined;
}

export function isPairingPending(config: PairingConfig, nowMs: number): boolean {
	return config.allowedUserId === undefined && Boolean(config.pairingCodeHash) && Boolean(config.pairingCreatedAtMs) && Boolean(config.pairingExpiresAtMs && config.pairingExpiresAtMs > nowMs);
}

export function isMessageBeforePairingWindow(message: TelegramDatedMessage, config: PairingConfig): boolean {
	if (config.pairingCreatedAtMs === undefined || message.date === undefined) return false;
	return message.date < Math.floor(config.pairingCreatedAtMs / 1000);
}

export function clearPairingState<TConfig extends PairingConfig>(config: TConfig): TConfig {
	return {
		...config,
		pairingCodeHash: undefined,
		pairingCreatedAtMs: undefined,
		pairingExpiresAtMs: undefined,
		pairingFailedAttempts: undefined,
	};
}

export function formatPairingPin(value: number): string {
	return String(value).padStart(PAIRING_PIN_DIGITS, "0");
}
