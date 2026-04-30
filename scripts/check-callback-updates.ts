import assert from "node:assert/strict";

import { createRuntimeUpdateHandlers, type RuntimeUpdateDeps } from "../src/broker/updates.js";
import { TelegramApiError } from "../src/telegram/api-errors.js";
import type { TelegramMessage, TelegramUpdate } from "../src/telegram/types.js";
import { brokerState, liveLease, runtimeUpdateDeps, testExtensionContext } from "./support/runtime-update-fixtures.js";

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
	const state = brokerState();
	return runtimeUpdateDeps({
		brokerState: state,
		config: { allowedUserId: 111, allowedChatId: 123 },
		lease: liveLease(),
		overrides: { callTelegram },
	});
}

async function checkNonRetryCallbackAnswerFailureIsHandled(): Promise<void> {
	const calls: string[] = [];
	const handlers = createRuntimeUpdateHandlers(deps(async (method) => {
		calls.push(method);
		throw new Error("callback query is too old");
	}));
	await handlers.handleUpdate(callbackUpdate(), testExtensionContext());
	assert.deepEqual(calls, ["answerCallbackQuery"]);
}

async function checkRetryAfterCallbackAnswerFailurePropagates(): Promise<void> {
	const handlers = createRuntimeUpdateHandlers(deps(async () => {
		throw new TelegramApiError("answerCallbackQuery", "Too Many Requests", 429, 2);
	}));
	await assert.rejects(() => handlers.handleUpdate(callbackUpdate(), testExtensionContext()), /Too Many Requests/);
}

await checkNonRetryCallbackAnswerFailureIsHandled();
await checkRetryAfterCallbackAnswerFailurePropagates();
console.log("Callback update checks passed");
