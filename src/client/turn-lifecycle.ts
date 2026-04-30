import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { QUEUED_CONTROL_TEXT } from "../shared/queued-control-text.js";
import type { ActiveTelegramTurn, PendingTelegramTurn, QueuedAttachment, TelegramRoute } from "../shared/types.js";
import { randomId } from "../shared/utils.js";
import { ManualCompactionTurnQueue } from "./manual-compaction.js";

export interface TakenQueuedTelegramTurn {
	turn: PendingTelegramTurn;
	source: "queued" | "manualCompaction";
	index?: number;
}

export interface ClientTelegramTurnLifecycleDeps {
	getSessionId: () => string;
	getLatestCtx: () => ExtensionContext | undefined;
	getConnectedRoute: () => TelegramRoute | undefined;
	hasClientServer: () => boolean;
	postTurnStarted: (turnId: string) => void;
	sendUserMessage: (content: PendingTelegramTurn["content"], options?: { deliverAs: "steer" | "followUp" }) => void;
	acknowledgeConsumedTurn: (turnId: string, finalizeQueuedControlText?: string) => void;
}

export class ClientTelegramTurnLifecycle {
	private queuedTelegramTurns: PendingTelegramTurn[] = [];
	private activeTelegramTurn: ActiveTelegramTurn | undefined;
	private currentAbort: (() => void) | undefined;
	private awaitingTelegramFinalTurnId: string | undefined;
	private readonly completedTurnIds = new Set<string>();
	private readonly disconnectedTurnIds = new Set<string>();
	private readonly manualCompactionQueue: ManualCompactionTurnQueue;

	constructor(private readonly deps: ClientTelegramTurnLifecycleDeps) {
		this.manualCompactionQueue = new ManualCompactionTurnQueue({
			getQueuedTelegramTurns: () => this.queuedTelegramTurns,
			setQueuedTelegramTurns: (turns) => { this.queuedTelegramTurns = turns; },
			getActiveTelegramTurn: () => this.activeTelegramTurn,
			hasAwaitingTelegramFinalTurn: () => this.awaitingTelegramFinalTurnId !== undefined,
			setActiveTelegramTurn: (turn) => { this.activeTelegramTurn = turn; },
			prepareTurnAbort: () => this.prepareAbortFromLatestContext(),
			postTurnStarted: this.deps.postTurnStarted,
			sendUserMessage: this.deps.sendUserMessage,
			acknowledgeConsumedTurn: this.deps.acknowledgeConsumedTurn,
		});
	}

	getManualCompactionQueue(): ManualCompactionTurnQueue {
		return this.manualCompactionQueue;
	}

	getActiveTurn(): ActiveTelegramTurn | undefined {
		return this.activeTelegramTurn;
	}

	restoreActiveTurn(turn: ActiveTelegramTurn | undefined): void {
		this.activeTelegramTurn = turn;
	}

	clearActiveTurnIf(turnId: string): void {
		if (this.activeTelegramTurn?.turnId === turnId) this.activeTelegramTurn = undefined;
	}

	getQueuedTurnsSnapshot(): PendingTelegramTurn[] {
		return [...this.queuedTelegramTurns];
	}

	replaceQueuedTurns(turns: PendingTelegramTurn[]): void {
		this.queuedTelegramTurns = turns;
	}

	queuedTurnCount(): number {
		return this.queuedTelegramTurns.length;
	}

	hasQueuedTurn(turnId: string): boolean {
		return this.queuedTelegramTurns.some((turn) => turn.turnId === turnId);
	}

	hasPendingTurn(turnId: string): boolean {
		return this.activeTelegramTurn?.turnId === turnId || this.hasQueuedTurn(turnId) || this.manualCompactionQueue.hasDeferredTurn(turnId);
	}

	queueTurn(turn: PendingTelegramTurn): void {
		this.queuedTelegramTurns.push(turn);
	}

	takeQueuedOrDeferredTurn(turnId: string): TakenQueuedTelegramTurn | undefined {
		const queuedIndex = this.queuedTelegramTurns.findIndex((turn) => turn.turnId === turnId);
		if (queuedIndex >= 0) {
			const [turn] = this.queuedTelegramTurns.splice(queuedIndex, 1);
			return { turn, source: "queued", index: queuedIndex };
		}
		const deferredTurn = this.manualCompactionQueue.removeDeferredTurn(turnId);
		return deferredTurn ? { turn: deferredTurn, source: "manualCompaction" } : undefined;
	}

	restoreTakenQueuedOrDeferredTurn(taken: TakenQueuedTelegramTurn): void {
		if (taken.source === "queued") {
			const index = taken.index ?? this.queuedTelegramTurns.length;
			this.queuedTelegramTurns.splice(index, 0, taken.turn);
			return;
		}
		this.manualCompactionQueue.enqueueDeferredTurn(taken.turn);
	}

	clearQueuedAndDeferredTurnsAsCompleted(): string[] {
		const turnIds = [
			...this.queuedTelegramTurns.map((turn) => turn.turnId),
			...this.manualCompactionQueue.peekPendingRemainder().map((turn) => turn.turnId),
		];
		this.queuedTelegramTurns = [];
		this.manualCompactionQueue.clearPendingRemainder();
		this.manualCompactionQueue.cancelDeferredStart();
		for (const turnId of turnIds) this.rememberCompletedTurn(turnId);
		return turnIds;
	}

	clearQueuedAndDeferredTurnsAsDisconnected(): void {
		for (const turn of this.queuedTelegramTurns) this.rememberDisconnectedTurn(turn.turnId);
		this.queuedTelegramTurns = [];
		for (const turn of this.manualCompactionQueue.clearPendingRemainder()) this.rememberDisconnectedTurn(turn.turnId);
		this.manualCompactionQueue.reset();
	}

	clearRouteTurnState(options: { rememberActiveAsDisconnected?: boolean } = {}): void {
		if (options.rememberActiveAsDisconnected && this.activeTelegramTurn) this.rememberDisconnectedTurn(this.activeTelegramTurn.turnId);
		this.clearQueuedAndDeferredTurnsAsDisconnected();
		this.currentAbort = undefined;
		this.awaitingTelegramFinalTurnId = undefined;
		this.activeTelegramTurn = undefined;
	}

	queueActiveTurnAttachments(attachments: QueuedAttachment[], maxAttachments: number): void {
		const activeTurn = this.activeTelegramTurn;
		if (!activeTurn) throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
		if (activeTurn.queuedAttachments.length + attachments.length > maxAttachments) throw new Error(`Attachment limit reached (${maxAttachments})`);
		activeTurn.queuedAttachments.push(...attachments);
	}

	startNextTelegramTurn(): void {
		if (this.manualCompactionQueue.isActive() || this.activeTelegramTurn || this.awaitingTelegramFinalTurnId || !this.deps.getConnectedRoute() || !this.deps.hasClientServer()) return;
		const turn = this.queuedTelegramTurns.shift();
		if (!turn) return;
		const activeTurn = { ...turn, queuedAttachments: [] };
		const previousAbort = this.currentAbort;
		this.activeTelegramTurn = activeTurn;
		this.prepareAbortFromLatestContext();
		try {
			this.deps.sendUserMessage(turn.content, turn.deliveryMode === "followUp" ? { deliverAs: "followUp" } : undefined);
		} catch (error) {
			if (this.activeTelegramTurn?.turnId === turn.turnId) this.activeTelegramTurn = undefined;
			this.currentAbort = previousAbort;
			this.queuedTelegramTurns.unshift(turn);
			throw error;
		}
		this.deps.postTurnStarted(turn.turnId);
	}

	ensureCurrentTurnMirroredToTelegram(ctx: ExtensionContext | undefined, historyText: string): void {
		const connectedRoute = this.deps.getConnectedRoute();
		if (!ctx || ctx.isIdle() || this.activeTelegramTurn || !connectedRoute || connectedRoute.chatId === 0 || String(connectedRoute.chatId) === "0") return;
		this.activeTelegramTurn = {
			turnId: randomId("local"),
			sessionId: this.deps.getSessionId(),
			routeId: connectedRoute.routeId,
			chatId: connectedRoute.chatId,
			messageThreadId: connectedRoute.messageThreadId,
			replyToMessageId: 0,
			queuedAttachments: [],
			content: [],
			historyText,
		};
	}

	beginLocalInteractiveTurn(route: TelegramRoute, historyText: string): void {
		if (this.activeTelegramTurn || this.awaitingTelegramFinalTurnId) return;
		this.activeTelegramTurn = {
			turnId: randomId("local"),
			sessionId: this.deps.getSessionId(),
			routeId: route.routeId,
			chatId: route.chatId,
			messageThreadId: route.messageThreadId,
			replyToMessageId: 0,
			queuedAttachments: [],
			content: [],
			historyText,
		};
	}

	getCurrentAbort(): (() => void) | undefined {
		return this.currentAbort;
	}

	setCurrentAbort(abort: (() => void) | undefined): void {
		this.currentAbort = abort;
	}

	hasLiveAgentRun(): boolean {
		return this.currentAbort !== undefined;
	}

	hasAwaitingTelegramFinalTurn(): boolean {
		return this.awaitingTelegramFinalTurnId !== undefined;
	}

	setAwaitingTelegramFinalTurn(turnId: string | undefined): void {
		this.awaitingTelegramFinalTurnId = turnId;
	}

	clearAwaitingTelegramFinalTurn(turnId: string): void {
		if (this.awaitingTelegramFinalTurnId === turnId) this.awaitingTelegramFinalTurnId = undefined;
	}

	getAwaitingTelegramFinalTurnId(): string | undefined {
		return this.awaitingTelegramFinalTurnId;
	}

	rememberCompletedTurn(turnId: string): void {
		this.completedTurnIds.add(turnId);
		if (this.completedTurnIds.size > 1000) {
			const oldestTurnId = this.completedTurnIds.values().next().value;
			if (oldestTurnId) this.completedTurnIds.delete(oldestTurnId);
		}
	}

	replaceCompletedTurns(turnIds: Iterable<string>): void {
		this.completedTurnIds.clear();
		for (const turnId of turnIds) this.rememberCompletedTurn(turnId);
	}

	hasCompletedTurn(turnId: string): boolean {
		return this.completedTurnIds.has(turnId);
	}

	rememberDisconnectedTurn(turnId: string): void {
		this.disconnectedTurnIds.add(turnId);
		if (this.disconnectedTurnIds.size > 1000) {
			const oldestTurnId = this.disconnectedTurnIds.values().next().value;
			if (oldestTurnId) this.disconnectedTurnIds.delete(oldestTurnId);
		}
	}

	isTurnDisconnected(turnId: string): boolean {
		return this.disconnectedTurnIds.has(turnId);
	}

	private prepareAbortFromLatestContext(): void {
		const ctx = this.deps.getLatestCtx();
		if (ctx) this.currentAbort = () => ctx.abort();
	}
}
