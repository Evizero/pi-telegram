import type { ActiveTelegramTurn, AssistantFinalPayload } from "../shared/types.js";
import { isRetryableAssistantError } from "../shared/assistant-errors.js";

export interface RetryAwareTelegramTurnFinalizerDeps {
	getActiveTelegramTurn: () => ActiveTelegramTurn | undefined;
	setActiveTelegramTurn: (turn: ActiveTelegramTurn | undefined) => void;
	rememberCompletedLocalTurn: (turnId: string) => void;
	startNextTelegramTurn: () => void;
	sendAssistantFinalToBroker: (payload: AssistantFinalPayload) => Promise<boolean>;
	handoffAssistantFinalToBroker?: (payload: AssistantFinalPayload) => Promise<boolean>;
	setAwaitingTelegramFinalTurn?: (turnId: string | undefined) => void;
	persistDeferredState?: () => Promise<void>;
	clearPreview: (turnId: string, chatId: number | string, messageThreadId: number | undefined) => Promise<void>;
}

export interface RetryAwareTelegramTurnFinalizerOptions {
	retryGraceMs?: number;
	setTimeoutFn?: (callback: () => void, delayMs: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
}

export type ActiveTelegramTurnFinalizationResult = "completed" | "deferred";

interface DeferredAssistantFinal {
	payload: AssistantFinalPayload;
	timer?: unknown;
}

const DEFAULT_RETRY_GRACE_MS = 5_000;

export class RetryAwareTelegramTurnFinalizer {
	private deferred: DeferredAssistantFinal | undefined;
	private readonly retryGraceMs: number;
	private readonly setTimeoutFn: (callback: () => void, delayMs: number) => unknown;
	private readonly clearTimeoutFn: (handle: unknown) => void;

	constructor(
		private readonly deps: RetryAwareTelegramTurnFinalizerDeps,
		options: RetryAwareTelegramTurnFinalizerOptions = {},
	) {
		this.retryGraceMs = options.retryGraceMs ?? DEFAULT_RETRY_GRACE_MS;
		this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
		this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	hasDeferredTurn(turnId?: string): boolean {
		if (!this.deferred) return false;
		return turnId === undefined ? true : this.deferred.payload.turn.turnId === turnId;
	}

	peekDeferredPayload(): AssistantFinalPayload | undefined {
		return this.deferred ? { ...this.deferred.payload } : undefined;
	}

	consumeDeferredPayload(): AssistantFinalPayload | undefined {
		const payload = this.deferred ? { ...this.deferred.payload } : undefined;
		this.clearDeferred();
		void this.deps.persistDeferredState?.();
		return payload;
	}

	restoreDeferredPayload(payload: AssistantFinalPayload): void {
		if (this.deferred?.payload.turn.turnId === payload.turn.turnId) return;
		const activeTurn = this.deps.getActiveTelegramTurn();
		if (!activeTurn || activeTurn.turnId === payload.turn.turnId) this.deps.setActiveTelegramTurn(payload.turn);
		this.scheduleDeferred(payload);
		void this.deps.persistDeferredState?.();
	}

	async flushDeferredTurn(options: { startNext?: boolean } = {}): Promise<string | undefined> {
		const deferred = this.deferred;
		if (!deferred) return undefined;
		await this.flushDeferred(deferred.payload.turn.turnId, options);
		return deferred.payload.turn.turnId;
	}

	onAgentStart(): void {
		if (!this.deferred?.timer) return;
		this.clearTimeoutFn(this.deferred.timer);
		this.deferred.timer = undefined;
	}

	onRetryMessageStart(): void {
		this.clearDeferred();
		void this.deps.persistDeferredState?.();
	}

	cancel(): void {
		this.clearDeferred();
		void this.deps.persistDeferredState?.();
	}

	async releaseDeferredTurn(options: { markCompleted?: boolean; startNext?: boolean; deliverAbortedFinal?: boolean; requireDelivery?: boolean } = {}): Promise<string | undefined> {
		const deferred = this.deferred;
		if (!deferred) return undefined;
		this.clearDeferred();
		void this.deps.persistDeferredState?.();
		const turnId = deferred.payload.turn.turnId;
		const activeTurn = this.deps.getActiveTelegramTurn();
		if (activeTurn?.turnId === turnId) {
			if (options.markCompleted ?? true) this.deps.rememberCompletedLocalTurn(turnId);
			this.deps.setActiveTelegramTurn(undefined);
		}
		if (options.startNext ?? true) this.deps.startNextTelegramTurn();
		if (options.deliverAbortedFinal) {
			const abortedPayload: AssistantFinalPayload = {
				turn: deferred.payload.turn,
				stopReason: "aborted",
				attachments: [],
			};
			const handoff = this.deps.handoffAssistantFinalToBroker ?? this.deps.sendAssistantFinalToBroker;
			let delivered = await handoff(abortedPayload).catch(() => false);
			if (!delivered && handoff !== this.deps.sendAssistantFinalToBroker) {
				delivered = await this.deps.sendAssistantFinalToBroker(abortedPayload).catch(() => false);
			}
			if ((options.requireDelivery ?? false) && !delivered) throw new Error(`Could not hand off deferred cleanup final for ${turnId}`);
		}
		return turnId;
	}

	async finalizeActiveTurn(payload: AssistantFinalPayload): Promise<ActiveTelegramTurnFinalizationResult> {
		const finalText = payload.text?.trim() || undefined;
		if (!finalText && isRetryableAssistantError(payload.stopReason, payload.errorMessage)) {
			this.scheduleDeferred({ ...payload, text: finalText });
			await this.deps.persistDeferredState?.();
			await this.deps.clearPreview(payload.turn.turnId, payload.turn.chatId, payload.turn.messageThreadId).catch(() => undefined);
			return "deferred";
		}
		this.clearDeferred();
		await this.deps.persistDeferredState?.();
		await this.complete({ ...payload, text: finalText });
		return "completed";
	}

	private scheduleDeferred(payload: AssistantFinalPayload): void {
		this.clearDeferred();
		const timer = this.setTimeoutFn(() => {
			void this.flushDeferred(payload.turn.turnId);
		}, this.retryGraceMs);
		this.deferred = { payload, timer };
	}

	private async flushDeferred(turnId: string, options: { startNext?: boolean } = {}): Promise<void> {
		const deferred = this.deferred;
		if (!deferred || deferred.payload.turn.turnId !== turnId) return;
		this.clearDeferred();
		await this.complete(deferred.payload, options);
	}

	private async complete(payload: AssistantFinalPayload, options: { startNext?: boolean } = {}): Promise<void> {
		const delivered = await this.deps.sendAssistantFinalToBroker(payload);
		if (!delivered) {
			this.deps.setAwaitingTelegramFinalTurn?.(payload.turn.turnId);
			return;
		}
		const activeTurn = this.deps.getActiveTelegramTurn();
		if (activeTurn?.turnId === payload.turn.turnId) {
			this.deps.rememberCompletedLocalTurn(payload.turn.turnId);
			this.deps.setActiveTelegramTurn(undefined);
		}
		this.deps.setAwaitingTelegramFinalTurn?.(undefined);
		if (options.startNext ?? true) this.deps.startNextTelegramTurn();
	}

	private clearDeferred(): void {
		if (!this.deferred) return;
		if (this.deferred.timer !== undefined) this.clearTimeoutFn(this.deferred.timer);
		this.deferred = undefined;
	}
}
