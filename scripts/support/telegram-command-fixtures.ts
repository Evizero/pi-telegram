import assert from "node:assert/strict";

import { TelegramCommandRouter } from "../../src/broker/commands.js";
import type { BrokerState, PendingTelegramTurn, SessionRegistration, TelegramCallbackQuery, TelegramConfig, TelegramMessage } from "../../src/shared/types.js";

export type IpcCall = { type: string; payload: unknown; target?: string };
export type TelegramCall = { method: string; body: Record<string, unknown> };

export function session(): SessionRegistration {
	return {
		sessionId: "session-1",
		ownerId: "owner-1",
		pid: 123,
		cwd: "/tmp/project",
		projectName: "project",
		status: "busy",
		queuedTurnCount: 0,
		lastHeartbeatMs: Date.now(),
		connectedAtMs: Date.now(),
		connectionStartedAtMs: Date.now(),
		connectionNonce: "conn-1",
		clientSocketPath: "/tmp/client.sock",
		topicName: "project · main",
	};
}

export function state(): BrokerState {
	const currentSession = session();
	return {
		schemaVersion: 1,
		recentUpdateIds: [],
		sessions: { [currentSession.sessionId]: currentSession },
		routes: {
			"123:9": {
				routeId: "123:9",
				sessionId: currentSession.sessionId,
				chatId: 123,
				messageThreadId: 9,
				routeMode: "forum_supergroup_topic",
				topicName: currentSession.topicName,
				createdAtMs: Date.now(),
				updatedAtMs: Date.now(),
			},
		},
		pendingTurns: {},
		pendingAssistantFinals: {},
		pendingManualCompactions: {},
		completedTurnIds: [],
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
	};
}

export function message(text: string, messageId = Math.floor(Math.random() * 1000)): TelegramMessage {
	return {
		message_id: messageId,
		message_thread_id: 9,
		chat: { id: 123, type: "supergroup", is_forum: true },
		from: { id: 456, is_bot: false, first_name: "User" },
		text,
	};
}

export function createRouter(
	brokerState: BrokerState,
	ipcCalls: IpcCall[],
	sentReplies: string[],
	telegramCalls: TelegramCall[],
	nextTurnCounter = () => 1,
	callTelegramOverride?: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>,
	sendTextOverride?: (chatId: number | string, threadId: number | undefined, text: string, options?: { disableNotification?: boolean; replyMarkup?: unknown }) => Promise<number | undefined>,
	postIpcOverride?: <TResponse>(socketPath: string, type: string, payload: unknown, targetSessionId?: string) => Promise<TResponse>,
	config: TelegramConfig = { allowedChatId: 123, topicMode: "auto", fallbackMode: "single_chat_selector" },
): TelegramCommandRouter {
	return new TelegramCommandRouter({
		getBrokerState: () => brokerState,
		getConfig: () => config,
		persistBrokerState: async () => undefined,
		markOfflineSessions: async () => undefined,
		createTelegramTurnForSession: async (messages, sessionIdForTurn) => ({
			turnId: `turn-${nextTurnCounter()}`,
			sessionId: sessionIdForTurn,
			chatId: messages[0]!.chat.id,
			messageThreadId: messages[0]!.message_thread_id,
			replyToMessageId: messages[0]!.message_id,
			queuedAttachments: [],
			content: [{ type: "text", text: messages[0]!.text ?? "" }],
			historyText: messages[0]!.text ?? "",
		}) satisfies PendingTelegramTurn,
		durableTelegramTurn: (turn) => turn,
		sendTextReply: sendTextOverride ?? (async (_chatId, _threadId, text, options) => {
			sentReplies.push(text);
			if (options?.replyMarkup) telegramCalls.push({ method: "sendMessageReplyMarkup", body: { reply_markup: options.replyMarkup } });
			return 99;
		}),
		callTelegram: callTelegramOverride ?? (async <TResponse>(method: string, body: Record<string, unknown>) => {
			telegramCalls.push({ method, body });
			return { ok: true } as TResponse;
		}),
		postIpc: postIpcOverride ?? (async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
			ipcCalls.push({ type, payload, target: targetSessionId });
			if (type === "compact_session") return { text: "Compaction started." } as TResponse;
			if (type === "queue_or_start_compact_session") return { status: "started", text: "Compaction started.", operationId: (payload as { operation: { operationId: string } }).operation.operationId } as TResponse;
			if (type === "abort_turn") return { text: "Aborted current turn.", clearedTurnIds: ["active"] } as TResponse;
			if (type === "deliver_turn") return { accepted: true } as TResponse;
			if (type === "cancel_queued_turn") return { status: "cancelled", text: "Cancelled queued follow-up.", turnId: (payload as { turnId: string }).turnId } as TResponse;
			if (type === "query_models") return {
				current: "openai-codex/gpt-5.5",
				models: [
					{ provider: "openai-codex", id: "gpt-5.5", name: "GPT 5.5", input: ["text"], reasoning: true, label: "openai-codex/gpt-5.5 — GPT 5.5" },
					{ provider: "openai-codex-2", id: "gpt-5.5", name: "GPT 5.5 (#2 private)", input: ["text"], reasoning: true, label: "openai-codex-2/gpt-5.5 — GPT 5.5 (#2 private)" },
					{ provider: "openai-codex-3", id: "gpt-5.5", name: "GPT 5.5 (#3 vertify max)", input: ["text"], reasoning: true, label: "openai-codex-3/gpt-5.5 — GPT 5.5 (#3 vertify max)" },
				],
			} as TResponse;
			if (type === "set_model") return { text: `Model changed to ${(payload as { selector: string }).selector}` } as TResponse;
			if (type === "query_git_repository") return { text: `Git ${(payload as { action: string }).action} result` } as TResponse;
			throw new Error(`unexpected IPC type ${type}`);
		}),
		stopTypingLoop: () => undefined,
		unregisterSession: async () => undefined,
		brokerInfo: () => "broker",
	});
}

export function callbackQuery(data: string): TelegramCallbackQuery {
	return callbackQueryForMessage(data, message("/model", 99));
}

export function callbackQueryForMessage(data: string, originMessage: TelegramMessage): TelegramCallbackQuery {
	return {
		id: `cb-${Math.random()}`,
		from: { id: 456, is_bot: false, first_name: "User" },
		message: originMessage,
		data,
	};
}

export function queuedControlCallbackDataByText(telegramCalls: TelegramCall[], text: "Steer now" | "Cancel"): string {
	const keyboard = telegramCalls.find((call) => call.method === "sendMessageReplyMarkup")!.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
	const buttons = keyboard.inline_keyboard.flat();
	assert.deepEqual(buttons.map((button) => button.text), ["Steer now", "Cancel"]);
	return buttons.find((button) => button.text === text)!.callback_data;
}

export function gitCallbackDataByText(telegramCalls: TelegramCall[], text: "Status" | "Diffstat"): string {
	const keyboard = telegramCalls.find((call) => call.method === "sendMessageReplyMarkup")!.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
	const buttons = keyboard.inline_keyboard.flat();
	assert.deepEqual(buttons.map((button) => button.text), ["Status", "Diffstat"]);
	return buttons.find((button) => button.text === text)!.callback_data;
}

export {
	session as makeSession,
	state as makeBrokerState,
	message as makeMessage,
	createRouter as createCommandRouterHarness,
	callbackQuery as makeCallbackQuery,
};
