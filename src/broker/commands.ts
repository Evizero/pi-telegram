import { MODEL_LIST_TTL_MS } from "../shared/config.js";
import { routeId } from "../shared/format.js";
import type { BrokerState, ModelSummary, PendingTelegramTurn, SessionRegistration, TelegramMessage, TelegramRoute } from "../shared/types.js";
import { errorMessage, now } from "../shared/utils.js";

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

export interface TelegramCommandRouterDeps {
	getBrokerState: () => BrokerState | undefined;
	persistBrokerState: () => Promise<void>;
	markOfflineSessions: () => Promise<void>;
	createTelegramTurnForSession: (messages: TelegramMessage[], sessionIdForTurn: string) => Promise<PendingTelegramTurn>;
	durableTelegramTurn: (turn: PendingTelegramTurn) => PendingTelegramTurn;
	sendTextReply: (chatId: number | string, messageThreadId: number | undefined, text: string) => Promise<number | undefined>;
	postIpc: <TResponse>(socketPath: string, type: string, payload: unknown, targetSessionId?: string) => Promise<TResponse>;
	stopTypingLoop: (turnId: string) => void;
	unregisterSession: (targetSessionId: string) => Promise<unknown>;
	brokerInfo: () => string;
}

export class TelegramCommandRouter {
	private readonly modelListCache = new Map<string, { expiresAt: number; models: ModelSummary[] }>();
	private readonly selectedSessionByChat = new Map<number, { sessionId: string; expiresAt: number }>();

	constructor(private readonly deps: TelegramCommandRouterDeps) {}

	routeForMessage(message: TelegramMessage): TelegramRoute | undefined {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return undefined;
		if (message.message_thread_id !== undefined) {
			return brokerState.routes[routeId(message.chat.id, message.message_thread_id)] ?? Object.values(brokerState.routes).find((route) => route.messageThreadId === message.message_thread_id && route.routeMode === "forum_supergroup_topic");
		}
		const selected = this.selectedSessionByChat.get(message.chat.id);
		if (selected && selected.expiresAt > now()) return Object.values(brokerState.routes).find((route) => route.sessionId === selected.sessionId);
		return undefined;
	}

	async dispatch(messages: TelegramMessage[]): Promise<void> {
		const firstMessage = messages[0];
		const brokerState = this.deps.getBrokerState();
		if (!firstMessage || !brokerState) return;
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).find((text) => text.length > 0) || "";
		const lower = rawText.toLowerCase();
		const command = telegramCommandName(rawText);
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
			await this.deps.sendTextReply(firstMessage.chat.id, firstMessage.message_thread_id, "Commands: /sessions, /use <number>, /status, /model, /compact, /follow, /stop, /disconnect, /broker.");
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
				session.status = "offline";
				await this.deps.persistBrokerState();
				await this.deps.sendTextReply(route.chatId, route.messageThreadId, `Failed to change model: ${errorMessage(error)}`);
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
			await this.deps.sendTextReply(route.chatId, route.messageThreadId, "Send a message to steer this pi session. Use /follow <message> to queue a follow-up. Commands: /status, /model, /compact, /follow, /stop, /disconnect, /sessions.");
			return;
		}
		let turnMessages = messages;
		let deliveryMode: PendingTelegramTurn["deliveryMode"];
		if (command === "/follow") {
			const followText = telegramCommandArgs(rawText);
			if (!followText) {
				await this.deps.sendTextReply(route.chatId, route.messageThreadId, "Usage: /follow <message>");
				return;
			}
			turnMessages = messagesWithFirstText(messages, followText);
			deliveryMode = "followUp";
		}
		let turn: PendingTelegramTurn;
		try {
			turn = await this.deps.createTelegramTurnForSession(turnMessages, route.sessionId);
			if (deliveryMode) turn.deliveryMode = deliveryMode;
		} catch (error) {
			await this.deps.sendTextReply(route.chatId, route.messageThreadId, `Failed to prepare Telegram message: ${errorMessage(error)}`);
			return;
		}
		brokerState.pendingTurns ??= {};
		brokerState.completedTurnIds ??= [];
		if (brokerState.completedTurnIds.includes(turn.turnId) || brokerState.pendingTurns[turn.turnId]) return;
		brokerState.pendingTurns[turn.turnId] = { turn: this.deps.durableTelegramTurn(turn), updatedAtMs: now() };
		await this.deps.persistBrokerState();
		try {
			await this.deps.postIpc(session.clientSocketPath, "deliver_turn", turn, session.sessionId);
		} catch (error) {
			this.deps.stopTypingLoop(turn.turnId);
			await this.deps.sendTextReply(route.chatId, route.messageThreadId, `Failed to deliver turn; will retry while the session is connected: ${errorMessage(error)}`);
		}
	}

	private async sendSessions(chatId: number, threadId?: number): Promise<void> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return;
		await this.deps.markOfflineSessions();
		const sessions = Object.values(brokerState.sessions);
		if (sessions.length === 0) {
			await this.deps.sendTextReply(chatId, threadId, "No connected pi sessions.");
			return;
		}
		const lines = ["Active pi sessions", ""];
		sessions.forEach((session, index) => {
			const queued = session.queuedTurnCount ? ` +${session.queuedTurnCount} queued` : "";
			lines.push(`${index + 1}. ${session.topicName} — ${session.status}${queued}`);
		});
		lines.push("", "Use /use <number> in selector mode, or open the session topic.");
		await this.deps.sendTextReply(chatId, threadId, lines.join("\n"));
	}

	private async handleUseCommand(message: TelegramMessage, text: string): Promise<void> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return;
		const arg = text.trim().split(/\s+/)[1];
		const sessions = Object.values(brokerState.sessions);
		const index = arg ? Number(arg) - 1 : Number.NaN;
		const session = Number.isInteger(index) ? sessions[index] : sessions.find((candidate) => candidate.sessionId === arg);
		if (!session) {
			await this.deps.sendTextReply(message.chat.id, message.message_thread_id, "Unknown session. Send /sessions.");
			return;
		}
		this.selectedSessionByChat.set(message.chat.id, { sessionId: session.sessionId, expiresAt: now() + MODEL_LIST_TTL_MS });
		await this.deps.sendTextReply(message.chat.id, message.message_thread_id, `Selected ${session.topicName} for 30 minutes.`);
	}

	private async handleModelCommand(route: TelegramRoute, session: SessionRegistration, text: string): Promise<void> {
		const args = text.trim().split(/\s+/).slice(1);
		if (args.length === 0 || args[0]?.toLowerCase() === "list") {
			const filter = args[0]?.toLowerCase() === "list" ? args.slice(1).join(" ").trim() : "";
			const result = await this.deps.postIpc<{ current?: string; models: ModelSummary[] }>(session.clientSocketPath, "query_models", { filter }, session.sessionId);
			const shownModels = result.models.slice(0, 30);
			this.modelListCache.set(`${route.routeId}:${route.sessionId}`, { expiresAt: now() + MODEL_LIST_TTL_MS, models: shownModels });
			const lines = [`Current: ${result.current ?? "unknown"}`, ""];
			if (shownModels.length === 0) lines.push("No available models matched.");
			else shownModels.forEach((model, index) => lines.push(`${index + 1}. ${model.label}`));
			await this.deps.sendTextReply(route.chatId, route.messageThreadId, lines.join("\n"));
			return;
		}
		let selector = args.join(" ").trim();
		if (/^\d+$/.test(selector)) {
			const cache = this.modelListCache.get(`${route.routeId}:${route.sessionId}`);
			const index = Number(selector) - 1;
			if (!cache || cache.expiresAt < now() || !cache.models[index]) {
				await this.deps.sendTextReply(route.chatId, route.messageThreadId, "Model list expired or number not found. Send /model first.");
				return;
			}
			selector = `${cache.models[index].provider}/${cache.models[index].id}`;
		}
		const result = await this.deps.postIpc<{ text: string }>(session.clientSocketPath, "set_model", { selector }, session.sessionId);
		await this.deps.sendTextReply(route.chatId, route.messageThreadId, result.text);
	}
}
