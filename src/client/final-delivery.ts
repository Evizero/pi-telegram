import type { AssistantFinalPayload } from "../shared/types.js";
import { now } from "../shared/utils.js";
import { getTelegramRetryAfterMs } from "../telegram/api.js";
export { isTerminalTelegramFinalDeliveryError, terminalTelegramFinalDeliveryReason } from "../telegram/final-errors.js";

export class AssistantFinalRetryQueue {
	private readonly pending: AssistantFinalPayload[] = [];
	private retryAtMs = 0;
	private attemptingTurnId: string | undefined;

	find(turnId: string): AssistantFinalPayload | undefined {
		return this.pending.find((payload) => payload.turn.turnId === turnId);
	}

	pendingPayloads(): AssistantFinalPayload[] {
		return [...this.pending];
	}

	enqueue(payload: AssistantFinalPayload, retryAfterMs?: number): void {
		if (!this.find(payload.turn.turnId)) this.pending.push(payload);
		if (retryAfterMs !== undefined) this.retryAtMs = Math.max(this.retryAtMs, now() + retryAfterMs + 250);
	}

	replacePending(payload: AssistantFinalPayload, retryAfterMs?: number): void {
		const index = this.pending.findIndex((candidate) => candidate.turn.turnId === payload.turn.turnId);
		if (index >= 0) this.pending[index] = payload;
		else this.pending.push(payload);
		if (retryAfterMs !== undefined) this.retryAtMs = Math.max(this.retryAtMs, now() + retryAfterMs + 250);
	}

	deferNewFinals(): boolean {
		return this.pending.length > 0 || this.attemptingTurnId !== undefined || now() < this.retryAtMs;
	}

	canAttemptOnlyPendingTurn(turnId: string): boolean {
		return this.pending.length === 1 && this.pending[0]?.turn.turnId === turnId && this.attemptingTurnId === undefined && now() >= this.retryAtMs;
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

	clear(): void {
		this.pending.splice(0, this.pending.length);
		this.retryAtMs = 0;
		this.attemptingTurnId = undefined;
	}
}

