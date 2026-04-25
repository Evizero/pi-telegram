import type { AssistantFinalPayload } from "../shared/types.js";
import { now } from "../shared/utils.js";
import { getTelegramRetryAfterMs, TelegramApiError } from "../telegram/api.js";

export class AssistantFinalRetryQueue {
	private readonly pending: AssistantFinalPayload[] = [];
	private retryAtMs = 0;
	private attemptingTurnId: string | undefined;

	find(turnId: string): AssistantFinalPayload | undefined {
		return this.pending.find((payload) => payload.turn.turnId === turnId);
	}

	enqueue(payload: AssistantFinalPayload, retryAfterMs?: number): void {
		if (!this.find(payload.turn.turnId)) this.pending.push(payload);
		if (retryAfterMs !== undefined) this.retryAtMs = Math.max(this.retryAtMs, now() + retryAfterMs + 250);
	}

	deferNewFinals(): boolean {
		return this.pending.length > 0 || this.attemptingTurnId !== undefined || now() < this.retryAtMs;
	}

	beginReadyAttempt(): AssistantFinalPayload | undefined {
		if (this.pending.length === 0 || this.attemptingTurnId !== undefined || now() < this.retryAtMs) return undefined;
		const payload = this.pending[0];
		this.attemptingTurnId = payload.turn.turnId;
		return payload;
	}

	markDelivered(turnId: string): void {
		const index = this.pending.findIndex((payload) => payload.turn.turnId === turnId);
		if (index >= 0) this.pending.splice(index, 1);
		if (this.attemptingTurnId === turnId) this.attemptingTurnId = undefined;
	}

	markRetryable(payload: AssistantFinalPayload, error?: unknown): void {
		this.enqueue(payload, error === undefined ? undefined : getTelegramRetryAfterMs(error));
		if (this.attemptingTurnId === payload.turn.turnId) this.attemptingTurnId = undefined;
	}
}

export function isTerminalTelegramFinalDeliveryError(error: unknown): boolean {
	if (!(error instanceof TelegramApiError)) return false;
	if (getTelegramRetryAfterMs(error) !== undefined) return false;
	const description = (error.description ?? error.message).toLowerCase();
	if (error.errorCode === 403) {
		return /bot\s+was\s+blocked|bot\s+was\s+kicked|user\s+is\s+deactivated|forbidden|not\s+enough\s+rights|can't\s+send|cannot\s+send/.test(description);
	}
	if (error.errorCode === 400) {
		return /chat\s+not\s+found|message\s+thread\s+not\s+found|thread\s+not\s+found|topic\s+not\s+found|topic\s+.*closed|message\s+thread\s+.*closed|bot\s+is\s+not\s+a\s+member|not\s+enough\s+rights|can't\s+send|cannot\s+send/.test(description);
	}
	return false;
}

export function terminalTelegramFinalDeliveryReason(error: unknown): string {
	if (error instanceof TelegramApiError) return `${error.method}: ${error.description ?? error.message}`;
	return error instanceof Error ? error.message : String(error);
}
