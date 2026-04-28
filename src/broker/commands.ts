import { MODEL_LIST_TTL_MS, SESSION_LIST_OFFLINE_GRACE_MS } from "../shared/config.js";
import { routeId } from "../shared/format.js";
import type { BrokerState, ClientDeliverTurnResult, ConvertQueuedTurnToSteerResult, InlineKeyboardMarkup, ModelSummary, PendingTelegramTurn, QueuedTurnControlState, SessionRegistration, TelegramCallbackQuery, TelegramMessage, TelegramModelPickerState, TelegramRoute } from "../shared/types.js";
import { errorMessage, now, randomId } from "../shared/utils.js";
import { getTelegramRetryAfterMs } from "../telegram/api.js";
import { answerTelegramCallbackQuery, editTelegramTextMessage } from "../telegram/text.js";
import { createModelPickerState, exactModelSelector, isModelPickerCallbackData, parseModelPickerCallback, renderInitialModelPicker, renderModelPicker, renderProviderPicker } from "./model-picker.js";

export function telegramCommandName(text: string): string {
	const command = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	return command.includes("@") ? command.slice(0, command.indexOf("@")) : command;
}

function telegramCommandArgs(text: string): string {
	const trimmed = text.trim();
	const match = trimmed.match(/^\S+\s+([\s\S]*)$/);
	return match?.[1]?.trim() ?? "";
}

function messagesWithFirstText(messages: TelegramMessage[], text: string): TelegramMessage[] {
	return messages.map((message, index) => {
		if (index !== 0) return message;
		if (message.caption !== undefined && message.text === undefined) return { ...message, caption: text };
		return { ...message, text };
	});
}

function queuedTurnSteerCallbackData(token: string): string {
	return `${QUEUED_TURN_CONTROL_CALLBACK_PREFIX}:${token}`;
}

function isQueuedTurnSteerCallbackData(data: string | undefined): boolean {
	return data?.startsWith(`${QUEUED_TURN_CONTROL_CALLBACK_PREFIX}:`) ?? false;
}

function parseQueuedTurnSteerCallbackToken(data: string | undefined): string | undefined {
	if (!data) return undefined;
	const [prefix, token, ...rest] = data.split(":");
	if (prefix !== QUEUED_TURN_CONTROL_CALLBACK_PREFIX || !token || rest.length > 0) return undefined;
	return token;
}

export interface TelegramCommandRouterDeps {
	getBrokerState: () => BrokerState | undefined;
	persistBrokerState: () => Promise<void>;
	markOfflineSessions: () => Promise<void>;
	createTelegramTurnForSession: (messages: TelegramMessage[], sessionIdForTurn: string) => Promise<PendingTelegramTurn>;
	durableTelegramTurn: (turn: PendingTelegramTurn) => PendingTelegramTurn;
	sendTextReply: (chatId: number | string, messageThreadId: number | undefined, text: string, options?: { disableNotification?: boolean; replyMarkup?: InlineKeyboardMarkup }) => Promise<number | undefined>;
	callTelegram: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
	postIpc: <TResponse>(socketPath: string, type: string, payload: unknown, targetSessionId?: string) => Promise<TResponse>;
	stopTypingLoop: (turnId: string) => void;
	unregisterSession: (targetSessionId: string) => Promise<unknown>;
	brokerInfo: () => string;
}

const COMPLETED_MODEL_PICKER_TTL_MS = 24 * 60 * 60 * 1000;
const QUEUED_TURN_CONTROL_CALLBACK_PREFIX = "qst1";
const QUEUED_TURN_CONTROL_TTL_MS = 24 * 60 * 60 * 1000;

export class TelegramCommandRouter {
	private readonly modelListCache = new Map<string, { expiresAt: number; models: ModelSummary[] }>();

	constructor(private readonly deps: TelegramCommandRouterDeps) {}

	routeForMessage(message: TelegramMessage): TelegramRoute | undefined {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return undefined;
		if (message.message_thread_id !== undefined) {
			return brokerState.routes[routeId(message.chat.id, message.message_thread_id)] ?? Object.values(brokerState.routes).find((route) => String(route.chatId) === String(message.chat.id) && route.messageThreadId === message.message_thread_id && route.routeMode === "forum_supergroup_topic");
		}
		const selected = brokerState.selectorSelections?.[String(message.chat.id)];
		if (selected && selected.expiresAtMs > now()) {
			return Object.values(brokerState.routes).find((route) => route.sessionId === selected.sessionId && route.routeMode === "single_chat_selector" && String(route.chatId) === String(message.chat.id));
		}
		return undefined;
	}

	async dispatchCallback(query: TelegramCallbackQuery): Promise<boolean> {
		if (isQueuedTurnSteerCallbackData(query.data)) return await this.dispatchQueuedTurnSteerCallback(query);
		if (!isModelPickerCallbackData(query.data)) return false;
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return true;
		const callback = parseModelPickerCallback(query.data);
		if (!callback) {
			await this.tryAnswerCallback(query.id, "This model picker button is invalid.", true);
			return true;
		}
		const picker = brokerState.modelPickers?.[callback.token];
		if (!picker) {
			await this.tryAnswerCallback(query.id, "Model picker expired. Send /model again.", true);
			await this.tryEditCallbackMessage(query, "Model picker expired. Send /model again.");
			return true;
		}
		if (!this.callbackMatchesPicker(query, picker) || !this.pickerRouteStillValid(brokerState, picker)) {
			await this.tryAnswerCallback(query.id, "This model picker no longer matches the active session. Send /model again.", true);
			return true;
		}
		if (picker.completedText && this.completedPickerStillRetryable(picker)) {
			await this.finishCompletedPicker(query, picker, picker.completedText);
			return true;
		}
		if (picker.expiresAtMs < now()) {
			delete brokerState.modelPickers![callback.token];
			await this.deps.persistBrokerState();
			await this.tryAnswerCallback(query.id, "Model picker expired. Send /model again.", true);
			await this.tryEditCallbackMessage(query, "Model picker expired. Send /model again.");
			return true;
		}
		picker.updatedAtMs = now();
		if (callback.kind === "providers") {
			const rendered = renderProviderPicker(picker, callback.page);
			await this.deps.persistBrokerState();
			await this.tryEditPickerMessage(query, picker, rendered.text, rendered.replyMarkup);
			await this.tryAnswerCallback(query.id);
			return true;
		}
		if (callback.kind === "models") {
			const rendered = renderModelPicker(picker, callback.groupIndex, callback.page);
			await this.deps.persistBrokerState();
			await this.tryEditPickerMessage(query, picker, rendered.text, rendered.replyMarkup);
			await this.tryAnswerCallback(query.id);
			return true;
		}
		await this.selectModelFromPicker(query, picker, callback.modelIndex);
		return true;
	}

	async dispatch(messages: TelegramMessage[]): Promise<void> {
		const firstMessage = messages[0];
		const brokerState = this.deps.getBrokerState();
		if (!firstMessage || !brokerState) return;
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).find((text) => text.length > 0) || "";
		const lower = rawText.toLowerCase();
		const command = telegramCommandName(rawText);
		if (this.pruneSelectorSelections(brokerState) || this.pruneModelPickers(brokerState) || this.pruneQueuedTurnControls(brokerState)) await this.deps.persistBrokerState();
		const route = this.routeForMessage(firstMessage);
		if (command === "/sessions") {
			await this.sendSessions(firstMessage.chat.id, firstMessage.message_thread_id);
			return;
		}
		if (command === "/use") {
			await this.handleUseCommand(firstMessage, rawText);
			return;
		}
		if (command === "/broker") {
			await this.deps.sendTextReply(firstMessage.chat.id, firstMessage.message_thread_id, this.deps.brokerInfo());
			return;
		}
		if ((command === "/help" || command === "/start") && !route) {
			await this.deps.sendTextReply(firstMessage.chat.id, firstMessage.message_thread_id, "Commands: /sessions, /use <number>, /status, /model, /compact, /follow, /steer, /stop, /disconnect, /broker.");
			return;
		}
		if (!route) {
			await this.deps.sendTextReply(firstMessage.chat.id, firstMessage.message_thread_id, "No pi session selected for this chat. Send /sessions.");
			return;
		}
		const session = brokerState.sessions[route.sessionId];
		if (!session || session.status === "offline") {
			await this.deps.sendTextReply(firstMessage.chat.id, firstMessage.message_thread_id, "That pi session is offline. Send /sessions to pick another.");
			return;
		}
		if (lower === "stop" || command === "/stop") {
			try {
				const result = await this.deps.postIpc<{ text: string; clearedTurnIds?: string[] }>(session.clientSocketPath, "abort_turn", { turnId: "active" }, session.sessionId);
				if (brokerState.pendingTurns && result.clearedTurnIds) {
					for (const turnId of result.clearedTurnIds) delete brokerState.pendingTurns[turnId];
					this.expireQueuedTurnControls(result.clearedTurnIds);
					await this.deps.persistBrokerState();
				}
				await this.deps.sendTextReply(route.chatId, route.messageThreadId, result.text);
			} catch (error) {
				await this.deps.sendTextReply(route.chatId, route.messageThreadId, `Failed to stop session: ${errorMessage(error)}`);
			}
			return;
		}
		if (command === "/status") {
			try {
				const status = await this.deps.postIpc<{ text: string }>(session.clientSocketPath, "query_status", {}, session.sessionId);
				await this.deps.sendTextReply(route.chatId, route.messageThreadId, status.text);
			} catch (error) {
				session.status = "offline";
				await this.deps.persistBrokerState();
				await this.deps.sendTextReply(route.chatId, route.messageThreadId, `Failed to query session: ${errorMessage(error)}`);
			}
			return;
		}
		if (command === "/compact") {
			try {
				const result = await this.deps.postIpc<{ text: string }>(session.clientSocketPath, "compact_session", {}, session.sessionId);
				await this.deps.sendTextReply(route.chatId, route.messageThreadId, result.text);
			} catch (error) {
				session.status = "offline";
				await this.deps.persistBrokerState();
				await this.deps.sendTextReply(route.chatId, route.messageThreadId, `Failed to compact session: ${errorMessage(error)}`);
			}
			return;
		}
		if (command === "/model") {
			try {
				await this.handleModelCommand(route, session, rawText);
			} catch (error) {
				if (getTelegramRetryAfterMs(error) !== undefined) throw error;
				await this.trySendTextReply(route.chatId, route.messageThreadId, `Failed to change model: ${errorMessage(error)}`);
			}
			return;
		}
		if (command === "/disconnect") {
			await this.deps.sendTextReply(route.chatId, route.messageThreadId, "Disconnected this pi session from Telegram. Deleting this topic...").catch(() => undefined);
			await this.deps.postIpc(session.clientSocketPath, "shutdown_client_route", {}, session.sessionId).catch(() => undefined);
			await this.deps.unregisterSession(session.sessionId);
			return;
		}
		if (command === "/help" || command === "/start") {
			await this.deps.sendTextReply(route.chatId, route.messageThreadId, "Send a message to queue follow-up work when this pi session is busy. Use /steer <message> for urgent active-turn steering or /follow <message> for explicit follow-up. Commands: /status, /model, /compact, /follow, /steer, /stop, /disconnect, /sessions.");
			return;
		}
		let turnMessages = messages;
		let deliveryMode: PendingTelegramTurn["deliveryMode"];
		if (command === "/follow" || command === "/steer") {
			const commandText = telegramCommandArgs(rawText);
			if (!commandText) {
				await this.deps.sendTextReply(route.chatId, route.messageThreadId, `Usage: ${command} <message>`);
				return;
			}
			turnMessages = messagesWithFirstText(messages, commandText);
			deliveryMode = command === "/steer" ? "steer" : "followUp";
		}
		let turn: PendingTelegramTurn;
		try {
			turn = await this.deps.createTelegramTurnForSession(turnMessages, route.sessionId);
			turn.routeId = route.routeId;
			if (deliveryMode) turn.deliveryMode = deliveryMode;
		} catch (error) {
			await this.deps.sendTextReply(route.chatId, route.messageThreadId, `Failed to prepare Telegram message: ${errorMessage(error)}`);
			return;
		}
		brokerState.pendingTurns ??= {};
		brokerState.completedTurnIds ??= [];
		if (brokerState.completedTurnIds.includes(turn.turnId)) return;
		if (brokerState.pendingTurns[turn.turnId]) {
			await this.retryQueuedTurnSteerControlStatus(turn.turnId);
			return;
		}
		brokerState.pendingTurns[turn.turnId] = { turn: this.deps.durableTelegramTurn(turn), updatedAtMs: now() };
		await this.deps.persistBrokerState();
		let delivery: ClientDeliverTurnResult;
		try {
			delivery = await this.deps.postIpc<ClientDeliverTurnResult>(session.clientSocketPath, "deliver_turn", turn, session.sessionId);
		} catch (error) {
			this.deps.stopTypingLoop(turn.turnId);
			await this.deps.sendTextReply(route.chatId, route.messageThreadId, `Failed to deliver turn; will retry while the session is connected: ${errorMessage(error)}`);
			return;
		}
		if (delivery.disposition === "queued" && delivery.queuedControl?.canSteer) {
			try {
				await this.offerQueuedTurnSteerControl(turn, delivery.queuedControl.targetActiveTurnId);
			} catch (error) {
				if (getTelegramRetryAfterMs(error) !== undefined) throw error;
			}
		}
	}

	private async dispatchQueuedTurnSteerCallback(query: TelegramCallbackQuery): Promise<boolean> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return true;
		const token = parseQueuedTurnSteerCallbackToken(query.data);
		if (!token) {
			await this.tryAnswerCallback(query.id, "This steer button is invalid.", true);
			return true;
		}
		const pruned = this.pruneQueuedTurnControls(brokerState);
		const control = brokerState.queuedTurnControls?.[token];
		if (!control) {
			if (pruned) await this.deps.persistBrokerState();
			await this.tryAnswerCallback(query.id, "This queued follow-up is no longer steerable.", true);
			return true;
		}
		if (!this.callbackMatchesQueuedTurnControl(query, control)) {
			await this.tryAnswerCallback(query.id, "This steer button no longer matches this Telegram route.", true);
			return true;
		}
		if (control.status === "converted") {
			if (control.completedText) await this.tryEditQueuedControlMessage(query, control, control.completedText);
			await this.tryAnswerCallback(query.id, "Queued follow-up already steered.");
			return true;
		}
		if (control.status === "expired" || control.expiresAtMs < now()) {
			control.status = "expired";
			control.updatedAtMs = now();
			await this.deps.persistBrokerState();
			await this.tryAnswerCallback(query.id, "This queued follow-up is no longer steerable.", true);
			await this.tryEditQueuedControlMessage(query, control, "Queued follow-up is no longer steerable.");
			return true;
		}
		const pending = brokerState.pendingTurns?.[control.turnId];
		if (!pending) {
			control.status = control.status === "converting" ? "converted" : "expired";
			control.updatedAtMs = now();
			await this.deps.persistBrokerState();
			await this.tryAnswerCallback(query.id, control.status === "converted" ? "Queued follow-up already handled." : "This queued follow-up is no longer waiting.", control.status !== "converted");
			await this.tryEditQueuedControlMessage(query, control, control.status === "converted" ? "Queued follow-up already handled." : "Queued follow-up is no longer waiting.");
			return true;
		}
		const session = brokerState.sessions[control.sessionId];
		if (!session || session.status === "offline" || !this.queuedControlRouteStillValid(brokerState, control)) {
			await this.tryAnswerCallback(query.id, "That pi session is offline or no longer matches this route.", true);
			return true;
		}
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
			await this.tryAnswerCallback(query.id, `Failed to steer queued follow-up: ${errorMessage(error)}`, true);
			return true;
		}
		if (result.status === "converted" || result.status === "already_handled") {
			await this.rememberBrokerTurnConsumed(control.turnId);
			control.status = "converted";
			control.completedText = result.text;
			control.updatedAtMs = now();
			control.expiresAtMs = now() + QUEUED_TURN_CONTROL_TTL_MS;
			await this.deps.persistBrokerState();
			await this.tryEditQueuedControlMessage(query, control, result.text);
			await this.tryAnswerCallback(query.id, result.text);
			return true;
		}
		control.status = "expired";
		control.updatedAtMs = now();
		await this.deps.persistBrokerState();
		await this.tryEditQueuedControlMessage(query, control, result.text);
		await this.tryAnswerCallback(query.id, result.text, true);
		return true;
	}

	private async offerQueuedTurnSteerControl(turn: PendingTelegramTurn, targetActiveTurnId: string | undefined): Promise<void> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState || !turn.routeId) return;
		this.pruneQueuedTurnControls(brokerState);
		const existing = Object.values(brokerState.queuedTurnControls ?? {}).find((control) => control.turnId === turn.turnId && control.status === "offered");
		if (existing) {
			await this.sendQueuedTurnControlStatus(existing);
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
		await this.sendQueuedTurnControlStatus(control);
	}

	private async retryQueuedTurnSteerControlStatus(turnId: string): Promise<void> {
		const control = Object.values(this.deps.getBrokerState()?.queuedTurnControls ?? {}).find((candidate) => candidate.turnId === turnId && candidate.status === "offered" && candidate.statusMessageId === undefined);
		if (control) await this.sendQueuedTurnControlStatus(control);
	}

	private async sendQueuedTurnControlStatus(control: QueuedTurnControlState): Promise<void> {
		if (control.statusMessageId !== undefined) return;
		const messageId = await this.deps.sendTextReply(control.chatId, control.messageThreadId, "Queued as follow-up.", {
			disableNotification: true,
			replyMarkup: { inline_keyboard: [[{ text: "Steer now", callback_data: queuedTurnSteerCallbackData(control.token) }]] },
		});
		if (messageId !== undefined) {
			control.statusMessageId = messageId;
			control.updatedAtMs = now();
			await this.deps.persistBrokerState();
		}
	}

	private async rememberBrokerTurnConsumed(turnId: string): Promise<void> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return;
		brokerState.completedTurnIds ??= [];
		if (!brokerState.completedTurnIds.includes(turnId)) brokerState.completedTurnIds.push(turnId);
		if (brokerState.completedTurnIds.length > 1000) brokerState.completedTurnIds.splice(0, brokerState.completedTurnIds.length - 1000);
		if (brokerState.pendingTurns?.[turnId]) delete brokerState.pendingTurns[turnId];
		this.deps.stopTypingLoop(turnId);
	}

	private expireQueuedTurnControls(turnIds: string[]): void {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState?.queuedTurnControls || turnIds.length === 0) return;
		const turnIdSet = new Set(turnIds);
		for (const control of Object.values(brokerState.queuedTurnControls)) {
			if (!turnIdSet.has(control.turnId) || control.status !== "offered") continue;
			control.status = "expired";
			control.updatedAtMs = now();
		}
	}

	private callbackMatchesQueuedTurnControl(query: TelegramCallbackQuery, control: QueuedTurnControlState): boolean {
		const message = query.message;
		if (!message) return false;
		if (String(message.chat.id) !== String(control.chatId)) return false;
		if (message.message_thread_id !== control.messageThreadId) return false;
		if (control.statusMessageId !== undefined && message.message_id !== control.statusMessageId) return false;
		return true;
	}

	private queuedControlRouteStillValid(brokerState: BrokerState, control: QueuedTurnControlState): boolean {
		return Object.values(brokerState.routes).some((route) => route.routeId === control.routeId && route.sessionId === control.sessionId && String(route.chatId) === String(control.chatId) && route.messageThreadId === control.messageThreadId);
	}

	private pruneQueuedTurnControls(brokerState: BrokerState): boolean {
		let changed = false;
		for (const [token, control] of Object.entries(brokerState.queuedTurnControls ?? {})) {
			if (control.expiresAtMs > now() && brokerState.sessions[control.sessionId]) continue;
			delete brokerState.queuedTurnControls![token];
			changed = true;
		}
		return changed;
	}

	private async tryEditQueuedControlMessage(query: TelegramCallbackQuery, control: QueuedTurnControlState, text: string): Promise<void> {
		const messageId = query.message?.message_id ?? control.statusMessageId;
		if (messageId === undefined) return;
		await editTelegramTextMessage(this.deps.callTelegram, control.chatId, messageId, text).catch((error) => {
			if (getTelegramRetryAfterMs(error) !== undefined) throw error;
		});
	}

	private async selectModelFromPicker(query: TelegramCallbackQuery, picker: TelegramModelPickerState, modelIndex: number): Promise<void> {
		const brokerState = this.deps.getBrokerState();
		const session = brokerState?.sessions[picker.sessionId];
		const model = picker.models[modelIndex];
		if (!brokerState || !session || session.status === "offline" || !model) {
			if (brokerState?.modelPickers?.[picker.token]) delete brokerState.modelPickers[picker.token];
			await this.deps.persistBrokerState();
			await this.tryAnswerCallback(query.id, "Model picker expired. Send /model again.", true);
			await this.tryEditCallbackMessage(query, "Model picker expired. Send /model again.");
			return;
		}
		const selector = exactModelSelector(model);
		let result: { text: string };
		try {
			result = await this.deps.postIpc<{ text: string }>(session.clientSocketPath, "set_model", { selector, exact: true }, session.sessionId);
		} catch (error) {
			session.status = "offline";
			delete brokerState.modelPickers?.[picker.token];
			await this.deps.persistBrokerState();
			await this.tryAnswerCallback(query.id, "Failed to change model.", true);
			await this.trySendTextReply(picker.chatId, picker.messageThreadId, `Failed to change model: ${errorMessage(error)}`);
			return;
		}
		picker.completedText = result.text;
		picker.selectedAtMs = now();
		picker.updatedAtMs = now();
		picker.expiresAtMs = now() + MODEL_LIST_TTL_MS;
		await this.deps.persistBrokerState();
		await this.finishCompletedPicker(query, picker, result.text);
	}

	private async finishCompletedPicker(query: TelegramCallbackQuery, picker: TelegramModelPickerState, text: string): Promise<void> {
		await this.tryEditOrSendPickerResult(query, picker, text);
		await this.tryAnswerCallback(query.id, "Model selection handled.");
		const brokerState = this.deps.getBrokerState();
		if (brokerState?.modelPickers?.[picker.token]) delete brokerState.modelPickers[picker.token];
		await this.deps.persistBrokerState();
	}

	private callbackMatchesPicker(query: TelegramCallbackQuery, picker: TelegramModelPickerState): boolean {
		const message = query.message;
		if (!message) return false;
		if (String(message.chat.id) !== String(picker.chatId)) return false;
		if (message.message_thread_id !== picker.messageThreadId) return false;
		if (picker.messageId !== undefined && message.message_id !== picker.messageId) return false;
		return true;
	}

	private pickerRouteStillValid(brokerState: BrokerState, picker: TelegramModelPickerState): boolean {
		const session = brokerState.sessions[picker.sessionId];
		if (!session || session.status === "offline") return false;
		return Object.values(brokerState.routes).some((route) => route.sessionId === picker.sessionId && route.routeId === picker.routeId && String(route.chatId) === String(picker.chatId) && route.messageThreadId === picker.messageThreadId);
	}

	private async editPickerMessage(query: TelegramCallbackQuery, picker: TelegramModelPickerState, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<void> {
		const messageId = query.message?.message_id ?? picker.messageId;
		if (messageId === undefined) {
			await this.deps.sendTextReply(picker.chatId, picker.messageThreadId, text, replyMarkup ? { replyMarkup } : undefined);
			return;
		}
		await editTelegramTextMessage(this.deps.callTelegram, picker.chatId, messageId, text, replyMarkup);
	}

	private async tryEditPickerMessage(query: TelegramCallbackQuery, picker: TelegramModelPickerState, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<void> {
		await this.editPickerMessage(query, picker, text, replyMarkup).catch((error) => {
			if (getTelegramRetryAfterMs(error) !== undefined) throw error;
		});
	}

	private async tryEditOrSendPickerResult(query: TelegramCallbackQuery, picker: TelegramModelPickerState, text: string): Promise<void> {
		try {
			await this.editPickerMessage(query, picker, text);
		} catch (error) {
			if (getTelegramRetryAfterMs(error) !== undefined) throw error;
			await this.deps.sendTextReply(picker.chatId, picker.messageThreadId, text).catch((sendError) => {
				if (getTelegramRetryAfterMs(sendError) !== undefined) throw sendError;
			});
		}
	}

	private async tryEditCallbackMessage(query: TelegramCallbackQuery, text: string): Promise<void> {
		const message = query.message;
		if (!message) return;
		await editTelegramTextMessage(this.deps.callTelegram, message.chat.id, message.message_id, text).catch((error) => {
			if (getTelegramRetryAfterMs(error) !== undefined) throw error;
		});
	}

	private async tryAnswerCallback(callbackQueryId: string, text?: string, showAlert = false): Promise<void> {
		await answerTelegramCallbackQuery(this.deps.callTelegram, callbackQueryId, text, { showAlert }).catch((error) => {
			if (getTelegramRetryAfterMs(error) !== undefined) throw error;
		});
	}

	private async trySendTextReply(chatId: number | string, messageThreadId: number | undefined, text: string, options?: { replyMarkup?: InlineKeyboardMarkup }): Promise<void> {
		await this.deps.sendTextReply(chatId, messageThreadId, text, options).catch((error) => {
			if (getTelegramRetryAfterMs(error) !== undefined) throw error;
		});
	}

	private async queryModels(session: SessionRegistration, payload: { filter?: string }): Promise<{ current?: string; models: ModelSummary[] }> {
		try {
			return await this.deps.postIpc<{ current?: string; models: ModelSummary[] }>(session.clientSocketPath, "query_models", payload, session.sessionId);
		} catch (error) {
			session.status = "offline";
			await this.deps.persistBrokerState();
			throw error;
		}
	}

	private async setModel(session: SessionRegistration, payload: { selector: string; exact?: boolean }): Promise<{ text: string }> {
		try {
			return await this.deps.postIpc<{ text: string }>(session.clientSocketPath, "set_model", payload, session.sessionId);
		} catch (error) {
			session.status = "offline";
			await this.deps.persistBrokerState();
			throw error;
		}
	}

	private completedPickerStillRetryable(picker: TelegramModelPickerState): boolean {
		return (picker.selectedAtMs ?? picker.updatedAtMs) + COMPLETED_MODEL_PICKER_TTL_MS > now();
	}

	private pruneModelPickers(brokerState: BrokerState): boolean {
		let changed = false;
		for (const [token, picker] of Object.entries(brokerState.modelPickers ?? {})) {
			if (brokerState.sessions[picker.sessionId] && (picker.expiresAtMs > now() || (picker.completedText && this.completedPickerStillRetryable(picker)))) continue;
			delete brokerState.modelPickers![token];
			changed = true;
		}
		return changed;
	}

	private pruneSelectorSelections(brokerState: BrokerState): boolean {
		let changed = false;
		for (const [chatId, selection] of Object.entries(brokerState.selectorSelections ?? {})) {
			if (selection.expiresAtMs > now() && brokerState.sessions[selection.sessionId]) continue;
			delete brokerState.selectorSelections![chatId];
			changed = true;
		}
		return changed;
	}

	private listableSessions(brokerState: BrokerState): SessionRegistration[] {
		const visibleSinceMs = now() - SESSION_LIST_OFFLINE_GRACE_MS;
		return Object.values(brokerState.sessions)
			.filter((session) => session.status !== "offline" || session.lastHeartbeatMs >= visibleSinceMs)
			.sort((left, right) => {
				if (left.status === "offline" && right.status !== "offline") return 1;
				if (left.status !== "offline" && right.status === "offline") return -1;
				return left.topicName.localeCompare(right.topicName) || left.sessionId.localeCompare(right.sessionId);
			});
	}

	private async sendSessions(chatId: number, threadId?: number): Promise<void> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return;
		await this.deps.markOfflineSessions();
		const sessions = this.listableSessions(brokerState);
		if (sessions.length === 0) {
			await this.deps.sendTextReply(chatId, threadId, "No connected pi sessions.");
			return;
		}
		const topicCounts = new Map<string, number>();
		for (const session of sessions) topicCounts.set(session.topicName, (topicCounts.get(session.topicName) ?? 0) + 1);
		const lines = ["Active pi sessions", ""];
		sessions.forEach((session, index) => {
			const queued = session.queuedTurnCount ? ` +${session.queuedTurnCount} queued` : "";
			const suffix = (topicCounts.get(session.topicName) ?? 0) > 1 ? ` (${session.sessionId.slice(-6)})` : "";
			lines.push(`${index + 1}. ${session.topicName}${suffix} — ${session.status}${queued}`);
		});
		lines.push("", "Use /use <number> in selector mode, or open the session topic.");
		await this.deps.sendTextReply(chatId, threadId, lines.join("\n"));
	}

	private async handleUseCommand(message: TelegramMessage, text: string): Promise<void> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return;
		await this.deps.markOfflineSessions();
		const arg = text.trim().split(/\s+/)[1];
		const sessions = this.listableSessions(brokerState);
		const index = arg ? Number(arg) - 1 : Number.NaN;
		const session = Number.isInteger(index) ? sessions[index] : sessions.find((candidate) => candidate.sessionId === arg);
		if (!session) {
			await this.deps.sendTextReply(message.chat.id, message.message_thread_id, "Unknown session. Send /sessions.");
			return;
		}
		brokerState.selectorSelections ??= {};
		brokerState.selectorSelections[String(message.chat.id)] = {
			chatId: message.chat.id,
			sessionId: session.sessionId,
			expiresAtMs: now() + MODEL_LIST_TTL_MS,
			updatedAtMs: now(),
		};
		const id = routeId(message.chat.id);
		brokerState.routes[`${id}:${session.sessionId}`] = brokerState.routes[`${id}:${session.sessionId}`] ?? { routeId: id, sessionId: session.sessionId, chatId: message.chat.id, routeMode: "single_chat_selector", topicName: session.topicName, createdAtMs: now(), updatedAtMs: now() };
		brokerState.routes[`${id}:${session.sessionId}`].updatedAtMs = now();
		await this.deps.persistBrokerState();
		await this.deps.sendTextReply(message.chat.id, message.message_thread_id, `Selected ${session.topicName} for 30 minutes.`);
	}

	private async handleModelCommand(route: TelegramRoute, session: SessionRegistration, text: string): Promise<void> {
		const args = text.trim().split(/\s+/).slice(1);
		if (args.length === 0) {
			const result = await this.queryModels(session, {});
			if (result.models.length === 0) {
				await this.trySendTextReply(route.chatId, route.messageThreadId, `Current: ${result.current ?? "unknown"}\n\nNo available models matched.`);
				return;
			}
			this.modelListCache.set(`${route.routeId}:${route.sessionId}`, { expiresAt: now() + MODEL_LIST_TTL_MS, models: result.models.slice(0, 30) });
			const picker = createModelPickerState(route, result.current, result.models);
			const rendered = renderInitialModelPicker(picker);
			const messageId = await this.deps.sendTextReply(route.chatId, route.messageThreadId, rendered.text, { replyMarkup: rendered.replyMarkup });
			picker.messageId = messageId;
			const brokerState = this.deps.getBrokerState();
			if (brokerState) {
				brokerState.modelPickers ??= {};
				brokerState.modelPickers[picker.token] = picker;
				this.pruneModelPickers(brokerState);
				await this.deps.persistBrokerState();
			}
			return;
		}
		if (args[0]?.toLowerCase() === "list") {
			const filter = args.slice(1).join(" ").trim();
			const result = await this.queryModels(session, { filter });
			const shownModels = result.models.slice(0, 30);
			this.modelListCache.set(`${route.routeId}:${route.sessionId}`, { expiresAt: now() + MODEL_LIST_TTL_MS, models: shownModels });
			const lines = [`Current: ${result.current ?? "unknown"}`, ""];
			if (shownModels.length === 0) lines.push("No available models matched.");
			else shownModels.forEach((model, index) => lines.push(`${index + 1}. ${model.label}`));
			await this.trySendTextReply(route.chatId, route.messageThreadId, lines.join("\n"));
			return;
		}
		let selector = args.join(" ").trim();
		const numericSelection = /^\d+$/.test(selector);
		if (numericSelection) {
			const cache = this.modelListCache.get(`${route.routeId}:${route.sessionId}`);
			const index = Number(selector) - 1;
			if (!cache || cache.expiresAt < now() || !cache.models[index]) {
				await this.trySendTextReply(route.chatId, route.messageThreadId, "Model list expired or number not found. Send /model first.");
				return;
			}
			selector = `${cache.models[index].provider}/${cache.models[index].id}`;
		}
		const setModelPayload = numericSelection ? { selector, exact: true } : { selector };
		const result = await this.setModel(session, setModelPayload);
		await this.trySendTextReply(route.chatId, route.messageThreadId, result.text);
	}
}
