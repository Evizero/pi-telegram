import assert from "node:assert/strict";

import type { TelegramPreviewState, TelegramSentMessage } from "../src/shared/types.js";
import { PreviewManager } from "../src/telegram/previews.js";
import { TelegramApiError } from "../src/telegram/api.js";

interface PreviewManagerInternals {
	previews: Map<string, TelegramPreviewState>;
	flush(turnId: string, chatId: number | string, messageThreadId: number | undefined): Promise<void>;
}

function managerInternals(manager: PreviewManager): PreviewManagerInternals {
	return manager as unknown as PreviewManagerInternals;
}

async function flushNow(manager: PreviewManager, turnId: string, chatId: number | string, messageThreadId?: number): Promise<void> {
	const state = managerInternals(manager).previews.get(turnId);
	if (state?.flushTimer) clearTimeout(state.flushTimer);
	if (state) state.flushTimer = undefined;
	await managerInternals(manager).flush(turnId, chatId, messageThreadId);
}

async function checkNotModifiedPreviewEditIsSuccess(): Promise<void> {
	const calls: Array<{ method: string; text?: unknown }> = [];
	let editCalls = 0;
	const manager = new PreviewManager(
		async <TResponse>(method: string, body: Record<string, unknown>) => {
			calls.push({ method, text: body.text });
			if (method === "sendMessage") return { message_id: 42 } as TResponse;
			if (method === "editMessageText") {
				editCalls += 1;
				throw new TelegramApiError(
					method,
					"Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
					400,
					undefined,
				);
			}
			throw new Error(`unexpected method: ${method}`);
		},
		async () => 99,
	);

	await manager.messageStart("turn", -100, 7);
	manager.preview("turn", -100, 7, "first");
	await flushNow(manager, "turn", -100, 7);
	manager.preview("turn", -100, 7, "second");
	await flushNow(manager, "turn", -100, 7);
	manager.preview("turn", -100, 7, "second");
	await flushNow(manager, "turn", -100, 7);

	assert.deepEqual(calls.map((call) => call.method), ["sendMessage", "editMessageText"]);
	assert.equal(editCalls, 1);
	assert.equal(managerInternals(manager).previews.get("turn")?.lastSentText, "second");
}

async function checkRetryAfterStillPropagates(): Promise<void> {
	const manager = new PreviewManager(
		async <TResponse>(method: string, _body: Record<string, unknown>) => {
			if (method === "sendMessage") return ({ message_id: 42 } satisfies TelegramSentMessage) as TResponse;
			throw new TelegramApiError(method, "Too Many Requests", 429, 2);
		},
		async () => 99,
	);

	await manager.messageStart("turn", -100, undefined);
	manager.preview("turn", -100, undefined, "first");
	await flushNow(manager, "turn", -100);
	manager.preview("turn", -100, undefined, "second");
	await assert.rejects(() => flushNow(manager, "turn", -100), /Too Many Requests/);
}

await checkNotModifiedPreviewEditIsSuccess();
await checkRetryAfterStillPropagates();
console.log("Preview manager checks passed");
