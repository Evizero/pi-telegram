import type { BrokerState, InlineKeyboardMarkup, PendingTelegramTurn, TelegramConfig, TelegramMessage } from "../shared/types.js";
import type { TelegramOutboxRunnerState } from "./telegram-outbox.js";

export interface TelegramCommandRouterDeps {
	getBrokerState: () => BrokerState | undefined;
	getConfig: () => TelegramConfig;
	persistBrokerState: () => Promise<void>;
	markOfflineSessions: () => Promise<void>;
	createTelegramTurnForSession: (messages: TelegramMessage[], sessionIdForTurn: string) => Promise<PendingTelegramTurn>;
	durableTelegramTurn: (turn: PendingTelegramTurn) => PendingTelegramTurn;
	sendTextReply: (chatId: number | string, messageThreadId: number | undefined, text: string, options?: { disableNotification?: boolean; replyMarkup?: InlineKeyboardMarkup }) => Promise<number | undefined>;
	callTelegram: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
	callTelegramForQueuedControlCleanup?: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
	telegramOutbox?: TelegramOutboxRunnerState;
	postIpc: <TResponse>(socketPath: string, type: string, payload: unknown, targetSessionId?: string) => Promise<TResponse>;
	stopTypingLoop: (turnId: string) => void;
	unregisterSession: (targetSessionId: string) => Promise<unknown>;
	brokerInfo: () => string;
}
