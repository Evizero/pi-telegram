import type { BrokerState, CancelQueuedTurnResult, ConvertQueuedTurnToSteerResult, PendingTelegramTurn, QueuedTurnControlState, SessionRegistration, TelegramCallbackQuery } from "../shared/types.js";
import { errorMessage, now, randomId } from "../shared/utils.js";
import type { TelegramCommandRouterDeps } from "./command-types.js";
import { answerControlCallback } from "./inline-controls.js";
import { callbackMatchesQueuedTurnControl, markExpiredControlVisible, markMissingPendingControlHandled, markQueuedTurnControlExpired, parseQueuedTurnControlCallback, pruneQueuedTurnControls, queuedControlBelongsToRoute, queuedControlNeedsVisibleFinalization, QUEUED_CONTROL_TEXT, queuedTurnControlCallbackData, QUEUED_TURN_CONTROL_TTL_MS, setQueuedControlTerminal, type QueuedTurnControlAction } from "./queued-controls.js";
import { createTelegramOutboxRunnerState, drainTelegramOutboxInBroker, enqueueQueuedControlStatusEditJob } from "./telegram-outbox.js";

const defaultQueuedControlOutboxRunner = createTelegramOutboxRunnerState();

export class QueuedTurnControlHandler {
	constructor(private readonly deps: TelegramCommandRouterDeps) {}

	async handleCallback(query: TelegramCallbackQuery): Promise<boolean> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return true;
		await this.retryFinalizations();
		const callback = parseQueuedTurnControlCallback(query.data);
		if (!callback) {
			await answerControlCallback(this.deps, query.id, "This queued follow-up button is invalid.", true);
			return true;
		}
		const { action, token } = callback;
		const pruned = pruneQueuedTurnControls(brokerState);
		const control = brokerState.queuedTurnControls?.[token];
		if (!control) {
			if (pruned) await this.deps.persistBrokerState();
			await answerControlCallback(this.deps, query.id, `This queued follow-up is no longer ${action === "steer" ? "steerable" : "cancellable"}.`, true);
			return true;
		}
		if (!callbackMatchesQueuedTurnControl(query, control)) {
			await answerControlCallback(this.deps, query.id, "This queued follow-up button no longer matches this Telegram route.", true);
			return true;
		}
		if (await this.finishTerminalControl(query, control, action)) return true;
		const pending = brokerState.pendingTurns?.[control.turnId];
		if (!pending && (control.status === "converting" || control.status === "cancelling")) {
			const wasConverting = control.status === "converting";
			markMissingPendingControlHandled(control);
			const text = control.completedText!;
			await this.deps.persistBrokerState();
			await this.tryEditControlMessage(query, control, text);
			await answerControlCallback(this.deps, query.id, wasConverting ? "Queued follow-up already steered." : "Queued follow-up already cancelled.");
			return true;
		}
		if (control.expiresAtMs < now()) {
			markQueuedTurnControlExpired(control, QUEUED_CONTROL_TEXT.noLongerWaiting);
			await this.deps.persistBrokerState();
			await this.tryEditControlMessage(query, control, control.completedText!);
			await answerControlCallback(this.deps, query.id, "This queued follow-up is no longer waiting.", true);
			return true;
		}
		if ((control.status === "converting" && action === "cancel") || (control.status === "cancelling" && action === "steer")) {
			await answerControlCallback(this.deps, query.id, control.status === "converting" ? "Queued follow-up is already being steered." : "Queued follow-up is already being cancelled.", true);
			return true;
		}
		if (!pending) {
			const text = QUEUED_CONTROL_TEXT.noLongerWaiting;
			setQueuedControlTerminal(control, "expired", text);
			await this.deps.persistBrokerState();
			await this.tryEditControlMessage(query, control, text);
			await answerControlCallback(this.deps, query.id, text, true);
			return true;
		}
		const session = brokerState.sessions[control.sessionId];
		if (!session || session.status === "offline" || !this.routeStillValid(brokerState, control)) {
			const text = QUEUED_CONTROL_TEXT.noLongerWaiting;
			markQueuedTurnControlExpired(control, text);
			await this.deps.persistBrokerState();
			if (queuedControlNeedsVisibleFinalization(control)) await this.tryEditControlMessage(query, control, text);
			await answerControlCallback(this.deps, query.id, "That pi session is offline or no longer matches this route.", true);
			return true;
		}
		if (action === "steer") return await this.convertToSteer(query, control, session);
		return await this.cancel(query, control, session);
	}

	async offer(turn: PendingTelegramTurn, targetActiveTurnId: string | undefined): Promise<void> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState || !turn.routeId) return;
		pruneQueuedTurnControls(brokerState);
		const existing = Object.values(brokerState.queuedTurnControls ?? {}).find((control) => control.turnId === turn.turnId && control.status === "offered");
		if (existing) {
			await this.sendStatus(existing);
			return;
		}
		const createdAtMs = now();
		const token = randomId("qs").replace(/[^A-Za-z0-9_-]/g, "");
		const control: QueuedTurnControlState = {
			token,
			turnId: turn.turnId,
			sessionId: turn.sessionId,
			routeId: turn.routeId,
			chatId: turn.chatId,
			messageThreadId: turn.messageThreadId,
			targetActiveTurnId,
			status: "offered",
			createdAtMs,
			updatedAtMs: createdAtMs,
			expiresAtMs: createdAtMs + QUEUED_TURN_CONTROL_TTL_MS,
		};
		brokerState.queuedTurnControls ??= {};
		brokerState.queuedTurnControls[token] = control;
		await this.deps.persistBrokerState();
		await this.sendStatus(control);
	}

	async retryStatus(turnId: string): Promise<void> {
		const control = Object.values(this.deps.getBrokerState()?.queuedTurnControls ?? {}).find((candidate) => candidate.turnId === turnId && candidate.status === "offered" && candidate.statusMessageId === undefined);
		if (control) await this.sendStatus(control);
	}

	markExpired(turnIds: string[], text: string = QUEUED_CONTROL_TEXT.noLongerWaiting): boolean {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState?.queuedTurnControls || turnIds.length === 0) return false;
		let changed = false;
		const turnIdSet = new Set(turnIds);
		for (const control of Object.values(brokerState.queuedTurnControls)) {
			if (!turnIdSet.has(control.turnId)) continue;
			changed = markQueuedTurnControlExpired(control, text) || changed;
		}
		return changed;
	}

	markConsumed(turnIds: string[], text: string = QUEUED_CONTROL_TEXT.noLongerWaiting): boolean {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState?.queuedTurnControls || turnIds.length === 0) return false;
		let changed = false;
		const turnIdSet = new Set(turnIds);
		for (const control of Object.values(brokerState.queuedTurnControls)) {
			if (!turnIdSet.has(control.turnId)) continue;
			if (control.status === "converting") {
				const terminalText = text === QUEUED_CONTROL_TEXT.noLongerWaiting ? QUEUED_CONTROL_TEXT.steered : text;
				changed = setQueuedControlTerminal(control, "converted", terminalText) || changed;
			} else if (control.status === "cancelling") {
				const terminalText = text === QUEUED_CONTROL_TEXT.noLongerWaiting ? QUEUED_CONTROL_TEXT.cancelled : text;
				changed = setQueuedControlTerminal(control, "cancelled", terminalText) || changed;
			} else changed = markQueuedTurnControlExpired(control, text) || changed;
		}
		return changed;
	}

	async finalize(turnIds: string[], text: string = QUEUED_CONTROL_TEXT.noLongerWaiting): Promise<boolean> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState?.queuedTurnControls || turnIds.length === 0) return false;
		let changed = this.markExpired(turnIds, text);
		for (const control of Object.values(brokerState.queuedTurnControls)) {
			if (!turnIds.includes(control.turnId) || !queuedControlNeedsVisibleFinalization(control)) continue;
			changed = enqueueQueuedControlStatusEditJob(brokerState, control) || changed;
		}
		if (changed) await this.deps.persistBrokerState();
		await this.drainOutbox();
		return changed;
	}

	async retryFinalizations(): Promise<boolean> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState?.queuedTurnControls) return false;
		let changed = false;
		for (const control of Object.values(brokerState.queuedTurnControls)) {
			const missingPendingTurn = brokerState.pendingTurns?.[control.turnId] === undefined;
			let marked = false;
			if (control.status === "expired" && !control.completedText) marked = markExpiredControlVisible(control, QUEUED_CONTROL_TEXT.noLongerWaiting);
			else if (control.status === "offered" && (control.expiresAtMs < now() || missingPendingTurn)) marked = markQueuedTurnControlExpired(control, QUEUED_CONTROL_TEXT.noLongerWaiting);
			else if (missingPendingTurn && (control.status === "converting" || control.status === "cancelling")) marked = markMissingPendingControlHandled(control);
			if (queuedControlNeedsVisibleFinalization(control)) changed = enqueueQueuedControlStatusEditJob(brokerState, control) || changed;
			changed = marked || changed;
		}
		if (changed) await this.deps.persistBrokerState();
		await this.drainOutbox();
		return changed;
	}

	private async finishTerminalControl(query: TelegramCallbackQuery, control: QueuedTurnControlState, action: QueuedTurnControlAction): Promise<boolean> {
		if (control.status === "converted") {
			if (queuedControlNeedsVisibleFinalization(control)) await this.tryEditControlMessage(query, control, control.completedText!);
			await answerControlCallback(this.deps, query.id, action === "steer" ? "Queued follow-up already steered." : "Queued follow-up was already steered.", action === "cancel");
			return true;
		}
		if (control.status === "cancelled") {
			if (queuedControlNeedsVisibleFinalization(control)) await this.tryEditControlMessage(query, control, control.completedText!);
			await answerControlCallback(this.deps, query.id, action === "cancel" ? "Queued follow-up already cancelled." : "Queued follow-up was cancelled.", action === "steer");
			return true;
		}
		if (control.status === "expired") {
			if (queuedControlNeedsVisibleFinalization(control)) await this.tryEditControlMessage(query, control, control.completedText!);
			await answerControlCallback(this.deps, query.id, "This queued follow-up is no longer waiting.", true);
			return true;
		}
		return false;
	}

	private async convertToSteer(query: TelegramCallbackQuery, control: QueuedTurnControlState, session: SessionRegistration): Promise<boolean> {
		control.status = "converting";
		control.updatedAtMs = now();
		await this.deps.persistBrokerState();
		let result: ConvertQueuedTurnToSteerResult;
		try {
			result = await this.deps.postIpc<ConvertQueuedTurnToSteerResult>(session.clientSocketPath, "convert_queued_turn_to_steer", { turnId: control.turnId, targetActiveTurnId: control.targetActiveTurnId }, session.sessionId);
		} catch (error) {
			session.status = "offline";
			control.status = "offered";
			control.updatedAtMs = now();
			await this.deps.persistBrokerState();
			await answerControlCallback(this.deps, query.id, `Failed to steer queued follow-up: ${errorMessage(error)}`, true);
			return true;
		}
		if (result.status === "converted" || result.status === "already_handled") {
			await this.rememberTurnConsumed(control.turnId);
			const text = result.status === "already_handled" ? QUEUED_CONTROL_TEXT.steered : result.text;
			setQueuedControlTerminal(control, "converted", text);
			await this.deps.persistBrokerState();
			await this.tryEditControlMessage(query, control, text);
			await answerControlCallback(this.deps, query.id, text);
			return true;
		}
		setQueuedControlTerminal(control, "expired", result.text);
		await this.deps.persistBrokerState();
		await this.tryEditControlMessage(query, control, result.text);
		await answerControlCallback(this.deps, query.id, result.text, true);
		return true;
	}

	private async cancel(query: TelegramCallbackQuery, control: QueuedTurnControlState, session: SessionRegistration): Promise<boolean> {
		control.status = "cancelling";
		control.updatedAtMs = now();
		await this.deps.persistBrokerState();
		let result: CancelQueuedTurnResult;
		try {
			result = await this.deps.postIpc<CancelQueuedTurnResult>(session.clientSocketPath, "cancel_queued_turn", { turnId: control.turnId }, session.sessionId);
		} catch (error) {
			session.status = "offline";
			control.status = "offered";
			control.updatedAtMs = now();
			await this.deps.persistBrokerState();
			await answerControlCallback(this.deps, query.id, `Failed to cancel queued follow-up: ${errorMessage(error)}`, true);
			return true;
		}
		if (result.status === "cancelled" || result.status === "already_handled") {
			await this.rememberTurnConsumed(control.turnId);
			const text = result.status === "already_handled" ? QUEUED_CONTROL_TEXT.cancelled : result.text;
			setQueuedControlTerminal(control, "cancelled", text);
			await this.deps.persistBrokerState();
			await this.tryEditControlMessage(query, control, text);
			await answerControlCallback(this.deps, query.id, text);
			return true;
		}
		setQueuedControlTerminal(control, "expired", result.text);
		await this.deps.persistBrokerState();
		await this.tryEditControlMessage(query, control, result.text);
		await answerControlCallback(this.deps, query.id, result.text, true);
		return true;
	}

	private async sendStatus(control: QueuedTurnControlState): Promise<void> {
		if (control.statusMessageId !== undefined) return;
		const messageId = await this.deps.sendTextReply(control.chatId, control.messageThreadId, QUEUED_CONTROL_TEXT.offered, {
			disableNotification: true,
			replyMarkup: { inline_keyboard: [[{ text: "Steer now", callback_data: queuedTurnControlCallbackData("steer", control.token) }, { text: "Cancel", callback_data: queuedTurnControlCallbackData("cancel", control.token) }]] },
		});
		if (messageId !== undefined) {
			control.statusMessageId = messageId;
			control.updatedAtMs = now();
			await this.deps.persistBrokerState();
		}
	}

	private async rememberTurnConsumed(turnId: string): Promise<void> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return;
		brokerState.completedTurnIds ??= [];
		if (!brokerState.completedTurnIds.includes(turnId)) brokerState.completedTurnIds.push(turnId);
		if (brokerState.completedTurnIds.length > 1000) brokerState.completedTurnIds.splice(0, brokerState.completedTurnIds.length - 1000);
		if (brokerState.pendingTurns?.[turnId]) delete brokerState.pendingTurns[turnId];
		this.deps.stopTypingLoop(turnId);
	}

	private routeStillValid(brokerState: BrokerState, control: QueuedTurnControlState): boolean {
		return Object.values(brokerState.routes).some((route) => queuedControlBelongsToRoute(control, route));
	}

	private async tryEditControlMessage(query: TelegramCallbackQuery, control: QueuedTurnControlState, text: string): Promise<void> {
		const messageId = query.message?.message_id ?? control.statusMessageId;
		if (messageId === undefined) return;
		await this.finalizeStatusMessage(control, text, messageId);
	}

	private async finalizeStatusMessage(control: QueuedTurnControlState, text: string, messageId = control.statusMessageId): Promise<boolean> {
		if (messageId === undefined) return false;
		if (control.statusMessageFinalizedAtMs !== undefined && control.completedText === text) return false;
		control.statusMessageId = messageId;
		control.completedText = text;
		control.statusMessageFinalizedAtMs = undefined;
		control.updatedAtMs = now();
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return false;
		const changed = enqueueQueuedControlStatusEditJob(brokerState, control);
		if (changed) await this.deps.persistBrokerState();
		await this.drainOutbox();
		return control.statusMessageFinalizedAtMs !== undefined;
	}

	private async drainOutbox(): Promise<void> {
		await drainTelegramOutboxInBroker(this.deps.telegramOutbox ?? defaultQueuedControlOutboxRunner, {
			getBrokerState: this.deps.getBrokerState,
			loadBrokerState: async () => {
				const brokerState = this.deps.getBrokerState();
				if (!brokerState) throw new Error("Broker state is not loaded");
				return brokerState;
			},
			setBrokerState: () => undefined,
			persistBrokerState: this.deps.persistBrokerState,
			callTelegram: this.deps.callTelegramForQueuedControlCleanup ?? this.deps.callTelegram,
			jobKinds: ["queued_control_status_edit"],
		});
	}
}
