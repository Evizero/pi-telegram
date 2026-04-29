import { MODEL_LIST_TTL_MS, SESSION_LIST_OFFLINE_GRACE_MS } from "../shared/config.js";
import { routeId } from "../shared/format.js";
import { canonicalRouteKey } from "../shared/routing.js";
import type { BrokerState, ClientDeliverTurnResult, PendingTelegramTurn, SessionRegistration, TelegramCallbackQuery, TelegramConfig, TelegramMessage, TelegramRoute } from "../shared/types.js";
import { errorMessage, now } from "../shared/utils.js";
import { getTelegramRetryAfterMs } from "../telegram/api.js";
import type { TelegramCommandRouterDeps } from "./command-types.js";
import { messagesWithFirstText, telegramCommandArgs, telegramCommandName } from "./command-text.js";
import { TelegramGitCommandHandler } from "./git-command.js";
import { isGitControlCallbackData } from "./git-controls.js";
import { TelegramModelCommandHandler } from "./model-command.js";
import { isModelPickerCallbackData } from "./model-picker.js";
import { isQueuedTurnControlCallbackData, pruneQueuedTurnControls, QUEUED_CONTROL_TEXT } from "./queued-controls.js";
import { QueuedTurnControlHandler } from "./queued-turn-control-handler.js";
import { replaceRoutesForSession } from "./routes.js";

export { telegramCommandName } from "./command-text.js";
export type { TelegramCommandRouterDeps } from "./command-types.js";

function selectorRoutingAvailableForChat(config: TelegramConfig, chatId: number | string): boolean {
	const topicMode = config.topicMode ?? "auto";
	if (topicMode === "disabled") return false;
	const selectorMode = topicMode === "single_chat_selector" || (topicMode === "auto" && (config.fallbackMode ?? "single_chat_selector") === "single_chat_selector");
	if (!selectorMode) return false;
	if (config.allowedChatId === undefined) return true;
	return String(config.allowedChatId) === String(chatId);
}

export class TelegramCommandRouter {
	private readonly modelCommands: TelegramModelCommandHandler;
	private readonly gitCommands: TelegramGitCommandHandler;
	private readonly queuedControls: QueuedTurnControlHandler;

	constructor(private readonly deps: TelegramCommandRouterDeps) {
		this.modelCommands = new TelegramModelCommandHandler(deps);
		this.gitCommands = new TelegramGitCommandHandler(deps);
		this.queuedControls = new QueuedTurnControlHandler(deps);
	}

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
		if (isQueuedTurnControlCallbackData(query.data)) return await this.queuedControls.handleCallback(query);
		if (isGitControlCallbackData(query.data)) return await this.gitCommands.handleCallback(query);
		if (isModelPickerCallbackData(query.data)) return await this.modelCommands.handleCallback(query);
		return false;
	}

	async dispatch(messages: TelegramMessage[]): Promise<void> {
		const firstMessage = messages[0];
		const brokerState = this.deps.getBrokerState();
		if (!firstMessage || !brokerState) return;
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).find((text) => text.length > 0) || "";
		const lower = rawText.toLowerCase();
		const command = telegramCommandName(rawText);
		await this.pruneCommandState(brokerState);
		const route = this.routeForMessage(firstMessage);
		if (await this.dispatchGlobalCommand(firstMessage, command, rawText, route)) return;
		if (!route) {
			await this.deps.sendTextReply(firstMessage.chat.id, firstMessage.message_thread_id, "No pi session selected for this chat. Send /sessions.");
			return;
		}
		const session = brokerState.sessions[route.sessionId];
		if (!session || session.status === "offline") {
			await this.deps.sendTextReply(firstMessage.chat.id, firstMessage.message_thread_id, "That pi session is offline. Send /sessions to pick another.");
			return;
		}
		if (await this.dispatchSessionCommand(command, lower, rawText, route, session)) return;
		await this.deliverTelegramTurn(messages, command, rawText, route, session);
	}

	markQueuedTurnControlsExpired(turnIds: string[], text: string = QUEUED_CONTROL_TEXT.noLongerWaiting): boolean {
		return this.queuedControls.markExpired(turnIds, text);
	}

	markQueuedTurnControlsConsumed(turnIds: string[], text: string = QUEUED_CONTROL_TEXT.noLongerWaiting): boolean {
		return this.queuedControls.markConsumed(turnIds, text);
	}

	async finalizeQueuedTurnControls(turnIds: string[], text: string = QUEUED_CONTROL_TEXT.noLongerWaiting): Promise<boolean> {
		return await this.queuedControls.finalize(turnIds, text);
	}

	async retryQueuedTurnControlFinalizations(): Promise<boolean> {
		return await this.queuedControls.retryFinalizations();
	}

	private async pruneCommandState(brokerState: BrokerState): Promise<void> {
		await this.queuedControls.retryFinalizations();
		if (this.pruneSelectorSelections(brokerState) || this.modelCommands.prune(brokerState) || this.gitCommands.prune(brokerState) || pruneQueuedTurnControls(brokerState)) await this.deps.persistBrokerState();
	}

	private async dispatchGlobalCommand(message: TelegramMessage, command: string, rawText: string, route: TelegramRoute | undefined): Promise<boolean> {
		if (command === "/sessions") {
			await this.sendSessions(message.chat.id, message.message_thread_id);
			return true;
		}
		if (command === "/use") {
			await this.handleUseCommand(message, rawText);
			return true;
		}
		if (command === "/broker") {
			await this.deps.sendTextReply(message.chat.id, message.message_thread_id, this.deps.brokerInfo());
			return true;
		}
		if ((command === "/help" || command === "/start") && !route) {
			await this.deps.sendTextReply(message.chat.id, message.message_thread_id, "Commands: /sessions, /use <number>, /status, /git, /model, /compact, /follow, /steer, /stop, /disconnect, /broker.");
			return true;
		}
		return false;
	}

	private async dispatchSessionCommand(command: string, lower: string, rawText: string, route: TelegramRoute, session: SessionRegistration): Promise<boolean> {
		if (lower === "stop" || command === "/stop") {
			await this.stopSession(route, session);
			return true;
		}
		if (command === "/status") {
			await this.querySessionStatus(route, session);
			return true;
		}
		if (command === "/compact") {
			await this.compactSession(route, session);
			return true;
		}
		if (command === "/model") {
			try {
				await this.modelCommands.handleCommand(route, session, rawText);
			} catch (error) {
				if (getTelegramRetryAfterMs(error) !== undefined) throw error;
				await this.trySendTextReply(route.chatId, route.messageThreadId, `Failed to change model: ${errorMessage(error)}`);
			}
			return true;
		}
		if (command === "/git") {
			try {
				await this.gitCommands.handleCommand(route);
			} catch (error) {
				if (getTelegramRetryAfterMs(error) !== undefined) throw error;
				await this.trySendTextReply(route.chatId, route.messageThreadId, `Failed to open Git tools: ${errorMessage(error)}`);
			}
			return true;
		}
		if (command === "/disconnect") {
			await this.disconnectSession(route, session);
			return true;
		}
		if (command === "/help" || command === "/start") {
			await this.deps.sendTextReply(route.chatId, route.messageThreadId, "Send a message to queue follow-up work when this pi session is busy. Use /steer <message> for urgent active-turn steering or /follow <message> for explicit follow-up. Commands: /status, /git, /model, /compact, /follow, /steer, /stop, /disconnect, /sessions.");
			return true;
		}
		return false;
	}

	private async stopSession(route: TelegramRoute, session: SessionRegistration): Promise<void> {
		const brokerState = this.deps.getBrokerState();
		try {
			const result = await this.deps.postIpc<{ text: string; clearedTurnIds?: string[] }>(session.clientSocketPath, "abort_turn", { turnId: "active" }, session.sessionId);
			if (brokerState?.pendingTurns && result.clearedTurnIds) {
				for (const turnId of result.clearedTurnIds) delete brokerState.pendingTurns[turnId];
				await this.finalizeQueuedTurnControls(result.clearedTurnIds, QUEUED_CONTROL_TEXT.cleared).catch((error) => {
					if (getTelegramRetryAfterMs(error) === undefined) throw error;
				});
				await this.deps.persistBrokerState();
			}
			await this.deps.sendTextReply(route.chatId, route.messageThreadId, result.text);
		} catch (error) {
			if (getTelegramRetryAfterMs(error) !== undefined) throw error;
			await this.deps.sendTextReply(route.chatId, route.messageThreadId, `Failed to stop session: ${errorMessage(error)}`);
		}
	}

	private async querySessionStatus(route: TelegramRoute, session: SessionRegistration): Promise<void> {
		try {
			const status = await this.deps.postIpc<{ text: string }>(session.clientSocketPath, "query_status", {}, session.sessionId);
			await this.deps.sendTextReply(route.chatId, route.messageThreadId, status.text);
		} catch (error) {
			session.status = "offline";
			await this.deps.persistBrokerState();
			await this.deps.sendTextReply(route.chatId, route.messageThreadId, `Failed to query session: ${errorMessage(error)}`);
		}
	}

	private async compactSession(route: TelegramRoute, session: SessionRegistration): Promise<void> {
		try {
			const result = await this.deps.postIpc<{ text: string }>(session.clientSocketPath, "compact_session", {}, session.sessionId);
			await this.deps.sendTextReply(route.chatId, route.messageThreadId, result.text);
		} catch (error) {
			session.status = "offline";
			await this.deps.persistBrokerState();
			await this.deps.sendTextReply(route.chatId, route.messageThreadId, `Failed to compact session: ${errorMessage(error)}`);
		}
	}

	private async disconnectSession(route: TelegramRoute, session: SessionRegistration): Promise<void> {
		await this.deps.sendTextReply(route.chatId, route.messageThreadId, "Disconnected this pi session from Telegram. Deleting this topic...").catch(() => undefined);
		await this.deps.postIpc(session.clientSocketPath, "shutdown_client_route", {}, session.sessionId).catch(() => undefined);
		await this.deps.unregisterSession(session.sessionId);
	}

	private async deliverTelegramTurn(messages: TelegramMessage[], command: string, rawText: string, route: TelegramRoute, session: SessionRegistration): Promise<void> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return;
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
			await this.queuedControls.retryStatus(turn.turnId);
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
				await this.queuedControls.offer(turn, delivery.queuedControl.targetActiveTurnId);
			} catch (error) {
				if (getTelegramRetryAfterMs(error) !== undefined) throw error;
			}
		}
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
		const config = this.deps.getConfig();
		if (!selectorRoutingAvailableForChat(config, message.chat.id)) {
			await this.deps.sendTextReply(message.chat.id, message.message_thread_id, config.topicMode === "disabled" ? "Telegram routing is disabled by config." : "Selector routing is not enabled for this chat. Use the session topic instead.");
			return;
		}
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
		const selectorRoute: TelegramRoute = { routeId: id, sessionId: session.sessionId, chatId: message.chat.id, routeMode: "single_chat_selector", topicName: session.topicName, createdAtMs: now(), updatedAtMs: now() };
		const routeKey = canonicalRouteKey(selectorRoute);
		const route = brokerState.routes[routeKey] ?? selectorRoute;
		route.topicName = session.topicName;
		route.updatedAtMs = now();
		replaceRoutesForSession(brokerState, session.sessionId, route, routeKey);
		await this.deps.persistBrokerState();
		await this.deps.sendTextReply(message.chat.id, message.message_thread_id, `Selected ${session.topicName} for 30 minutes.`);
	}

	private async trySendTextReply(chatId: number | string, messageThreadId: number | undefined, text: string): Promise<void> {
		await this.deps.sendTextReply(chatId, messageThreadId, text).catch((error) => {
			if (getTelegramRetryAfterMs(error) !== undefined) throw error;
		});
	}
}
