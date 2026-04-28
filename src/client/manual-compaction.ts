import type { ActiveTelegramTurn, PendingTelegramTurn } from "../shared/types.js";

export interface ManualCompactionTurnQueueDeps {
	getQueuedTelegramTurns: () => PendingTelegramTurn[];
	setQueuedTelegramTurns: (turns: PendingTelegramTurn[]) => void;
	getActiveTelegramTurn: () => ActiveTelegramTurn | undefined;
	hasAwaitingTelegramFinalTurn: () => boolean;
	setActiveTelegramTurn: (turn: ActiveTelegramTurn | undefined) => void;
	prepareTurnAbort: () => void;
	postTurnStarted: (turnId: string) => void;
	sendUserMessage: (content: PendingTelegramTurn["content"], options?: { deliverAs: "steer" | "followUp" }) => void;
	acknowledgeConsumedTurn: (turnId: string) => void;
}

export class ManualCompactionTurnQueue {
	private activeCount = 0;
	private pendingRemainder: PendingTelegramTurn[] = [];
	private awaitingAgentStart = false;

	constructor(private readonly deps: ManualCompactionTurnQueueDeps) {}

	start(): void {
		this.activeCount += 1;
	}

	finish(): void {
		if (this.activeCount > 0) this.activeCount -= 1;
		if (this.activeCount === 0) this.startDeferredTurnIfReady();
	}

	isActive(): boolean {
		return this.activeCount > 0;
	}

	hasDeferredTurn(turnId: string): boolean {
		return this.pendingRemainder.some((turn) => turn.turnId === turnId);
	}

	enqueueDeferredTurn(turn: PendingTelegramTurn): boolean {
		if (!this.awaitingAgentStart) return false;
		this.pendingRemainder.push(turn);
		return true;
	}

	cancelDeferredStart(): void {
		this.awaitingAgentStart = false;
	}

	reset(): void {
		this.activeCount = 0;
		this.pendingRemainder = [];
		this.awaitingAgentStart = false;
	}

	peekPendingRemainder(): PendingTelegramTurn[] {
		return [...this.pendingRemainder];
	}

	clearPendingRemainder(): PendingTelegramTurn[] {
		const pending = [...this.pendingRemainder];
		this.pendingRemainder = [];
		return pending;
	}

	removeDeferredTurn(turnId: string): PendingTelegramTurn | undefined {
		const index = this.pendingRemainder.findIndex((turn) => turn.turnId === turnId);
		if (index < 0) return undefined;
		const [turn] = this.pendingRemainder.splice(index, 1);
		return turn;
	}

	drainDeferredIntoActiveTurn(): void {
		if (!this.awaitingAgentStart) return;
		this.awaitingAgentStart = false;
		if (this.pendingRemainder.length === 0) return;
		const pending = [...this.pendingRemainder];
		this.pendingRemainder = [];
		for (const turn of pending) {
			this.deps.sendUserMessage(turn.content, { deliverAs: turn.deliveryMode === "steer" ? "steer" : "followUp" });
			this.deps.acknowledgeConsumedTurn(turn.turnId);
		}
	}

	private startDeferredTurnIfReady(): void {
		if (this.isActive()) return;
		if (this.deps.getActiveTelegramTurn() || this.deps.hasAwaitingTelegramFinalTurn()) return;
		const queuedTelegramTurns = this.deps.getQueuedTelegramTurns();
		if (queuedTelegramTurns.length === 0) return;
		const [firstTurn, ...remainingTurns] = queuedTelegramTurns;
		if (!firstTurn) return;
		this.deps.setQueuedTelegramTurns([]);
		this.pendingRemainder = remainingTurns;
		this.awaitingAgentStart = true;
		this.deps.setActiveTelegramTurn({ ...firstTurn, queuedAttachments: [] });
		this.deps.prepareTurnAbort();
		this.deps.postTurnStarted(firstTurn.turnId);
		this.deps.sendUserMessage(firstTurn.content, firstTurn.deliveryMode === "followUp" ? { deliverAs: "followUp" } : undefined);
	}
}
