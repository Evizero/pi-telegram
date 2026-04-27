import assert from "node:assert/strict";

import { createRuntimeUpdateHandlers, type RuntimeUpdateDeps } from "../src/broker/updates.js";
import { TelegramApiError } from "../src/telegram/api.js";
import type { BrokerLease, BrokerState, TelegramConfig, TelegramMessage, TelegramUpdate } from "../src/shared/types.js";

function callbackUpdate(): TelegramUpdate {
	return {
		update_id: 1,
		callback_query: {
			id: "cb-1",
			from: { id: 999, is_bot: false, first_name: "Intruder" },
			message: {
				message_id: 10,
				chat: { id: 123, type: "private" },
				from: { id: 111, is_bot: false, first_name: "Owner" },
			} satisfies TelegramMessage,
			data: "unsupported",
		},
	};
}

function deps(callTelegram: RuntimeUpdateDeps["callTelegram"]): RuntimeUpdateDeps {
	const config: TelegramConfig = { allowedUserId: 111, allowedChatId: 123 };
	const brokerState: BrokerState = {
		schemaVersion: 1,
		recentUpdateIds: [],
		sessions: {},
		routes: {},
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
	};
	const lease: BrokerLease = {
		schemaVersion: 1,
		ownerId: "owner",
		pid: process.pid,
		startedAtMs: Date.now(),
		leaseEpoch: 1,
		socketPath: "/tmp/broker.sock",
		leaseUntilMs: Date.now() + 60_000,
		updatedAtMs: Date.now(),
	};
	return {
		getConfig: () => config,
		setConfig: () => undefined,
		getBrokerState: () => brokerState,
		setBrokerState: () => undefined,
		getBrokerLeaseEpoch: () => 1,
		getOwnerId: () => "owner",
		commandRouter: { dispatch: async () => undefined, dispatchCallback: async () => false } as any,
		mediaGroups: new Map(),
		callTelegram,
		writeConfig: async () => undefined,
		persistBrokerState: async () => undefined,
		loadBrokerState: async () => brokerState,
		readLease: async () => lease,
		stopBroker: async () => undefined,
		updateStatus: () => undefined,
		refreshTelegramStatus: () => undefined,
		sendTextReply: async () => undefined,
		ensureRoutesAfterPairing: async () => undefined,
		isAllowedTelegramChat: () => true,
		stopTypingLoop: () => undefined,
		dropAssistantPreviewState: async () => undefined,
		postIpc: async <TResponse>() => ({}) as TResponse,
		unregisterSession: async () => undefined,
		markSessionOffline: async () => undefined,
	};
}

async function checkNonRetryCallbackAnswerFailureIsHandled(): Promise<void> {
	const calls: string[] = [];
	const handlers = createRuntimeUpdateHandlers(deps(async (method) => {
		calls.push(method);
		throw new Error("callback query is too old");
	}));
	await handlers.handleUpdate(callbackUpdate(), {} as any);
	assert.deepEqual(calls, ["answerCallbackQuery"]);
}

async function checkRetryAfterCallbackAnswerFailurePropagates(): Promise<void> {
	const handlers = createRuntimeUpdateHandlers(deps(async () => {
		throw new TelegramApiError("answerCallbackQuery", "Too Many Requests", 429, 2);
	}));
	await assert.rejects(() => handlers.handleUpdate(callbackUpdate(), {} as any), /Too Many Requests/);
}

await checkNonRetryCallbackAnswerFailureIsHandled();
await checkRetryAfterCallbackAnswerFailurePropagates();
console.log("Callback update checks passed");
