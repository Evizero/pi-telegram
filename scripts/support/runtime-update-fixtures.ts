import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { RuntimeUpdateDeps } from "../../src/broker/updates.js";
import { TelegramCommandRouter } from "../../src/broker/commands.js";
import type { TelegramCommandRouterDeps } from "../../src/broker/command-types.js";
import type { BrokerLease, BrokerState, PendingTelegramTurn, TelegramConfig, TelegramMessage } from "../../src/shared/types.js";
import { now } from "../../src/shared/utils.js";

export function brokerState(overrides: Partial<BrokerState> = {}): BrokerState {
	return {
		schemaVersion: 1,
		recentUpdateIds: [],
		sessions: {},
		routes: {},
		createdAtMs: now(),
		updatedAtMs: now(),
		...overrides,
	};
}

export function liveLease(overrides: Partial<BrokerLease> = {}): BrokerLease {
	return {
		schemaVersion: 1,
		ownerId: "owner",
		pid: process.pid,
		startedAtMs: now(),
		leaseEpoch: 1,
		socketPath: "/tmp/broker.sock",
		leaseUntilMs: now() + 60_000,
		updatedAtMs: now(),
		...overrides,
	};
}

function pendingTurnFromMessage(message: TelegramMessage | undefined, sessionId: string): PendingTelegramTurn {
	return {
		turnId: "turn-1",
		sessionId,
		chatId: message?.chat.id ?? 123,
		messageThreadId: message?.message_thread_id,
		replyToMessageId: message?.message_id ?? 0,
		queuedAttachments: [],
		content: [{ type: "text", text: message?.text ?? "" }],
		historyText: message?.text ?? "",
	};
}

export function noopCommandRouter(getBrokerState: () => BrokerState | undefined = () => undefined): TelegramCommandRouter {
	const deps: TelegramCommandRouterDeps = {
		getBrokerState,
		persistBrokerState: async () => undefined,
		markOfflineSessions: async () => undefined,
		createTelegramTurnForSession: async (messages, sessionId) => pendingTurnFromMessage(messages[0], sessionId),
		durableTelegramTurn: (turn) => turn,
		sendTextReply: async () => undefined,
		callTelegram: async <TResponse>() => ({} as TResponse),
		postIpc: async <TResponse>() => ({} as TResponse),
		stopTypingLoop: () => undefined,
		unregisterSession: async () => undefined,
		brokerInfo: () => "broker",
	};
	return new TelegramCommandRouter(deps);
}

export function runtimeUpdateDeps(options: {
	brokerState?: BrokerState;
	config?: TelegramConfig;
	lease?: BrokerLease | undefined;
	overrides?: Partial<RuntimeUpdateDeps>;
} = {}): RuntimeUpdateDeps {
	const state = options.brokerState ?? brokerState();
	const config = options.config ?? { allowedUserId: 111, allowedChatId: 123 };
	const lease = options.lease ?? liveLease();
	return {
		getConfig: () => config,
		setConfig: () => undefined,
		getBrokerState: () => state,
		setBrokerState: () => undefined,
		getBrokerLeaseEpoch: () => 1,
		getOwnerId: () => "owner",
		commandRouter: noopCommandRouter(() => state),
		mediaGroups: new Map(),
		callTelegram: async <TResponse>() => ({} as TResponse),
		writeConfig: async () => undefined,
		persistBrokerState: async () => undefined,
		loadBrokerState: async () => state,
		readLease: async () => lease,
		stopBroker: async () => undefined,
		updateStatus: () => undefined,
		refreshTelegramStatus: () => undefined,
		sendTextReply: async () => undefined,
		ensureRoutesAfterPairing: async () => undefined,
		isAllowedTelegramChat: () => true,
		stopTypingLoop: () => undefined,
		dropAssistantPreviewState: async () => undefined,
		postIpc: async <TResponse>() => ({} as TResponse),
		unregisterSession: async () => undefined,
		markSessionOffline: async () => undefined,
		...options.overrides,
	};
}

export function testExtensionContext(): ExtensionContext {
	return { ui: { theme: {} } } as ExtensionContext;
}
