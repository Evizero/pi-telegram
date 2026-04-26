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

async function checkClearPreservesPreviewStateOnDeleteFailure(): Promise<void> {
	const calls: string[] = [];
	let detachCalls = 0;
	const manager = new PreviewManager(
		async <TResponse>(method: string, body: Record<string, unknown>) => {
			calls.push(`${method}:${String(body.text ?? body.message_id ?? "")}`);
			if (method === "sendMessage") return ({ message_id: 77 } satisfies TelegramSentMessage) as TResponse;
			if (method === "deleteMessage") throw new Error(`delete failed: ${String(body.message_id)}`);
			if (method === "editMessageText") return undefined as TResponse;
			throw new Error(`unexpected method: ${method}`);
		},
		async () => 99,
		undefined,
		() => { detachCalls += 1; },
	);

	await manager.messageStart("turn", -100, 5);
	manager.preview("turn", -100, 5, "preview text");
	await flushNow(manager, "turn", -100, 5);
	await manager.clear("turn", -100, 5, { preserveOnFailure: true });
	assert.equal(managerInternals(manager).previews.has("turn"), true);
	assert.equal(detachCalls, 0);

	await manager.messageStart("turn", -100, 5);
	manager.preview("turn", -100, 5, "retry preview");
	await flushNow(manager, "turn", -100, 5);

	assert.deepEqual(calls, [
		"sendMessage:preview text",
		"deleteMessage:77",
		"editMessageText:retry preview",
	]);
	assert.equal(managerInternals(manager).previews.get("turn")?.messageId, 77);
}

async function checkTerminalDeleteFailureDropsPreviewStateForRetry(): Promise<void> {
	const calls: string[] = [];
	const manager = new PreviewManager(
		async <TResponse>(method: string, body: Record<string, unknown>) => {
			calls.push(`${method}:${String(body.text ?? body.message_id ?? "")}`);
			if (method === "sendMessage") return ({ message_id: calls.length === 1 ? 88 : 89 } satisfies TelegramSentMessage) as TResponse;
			if (method === "deleteMessage") throw new TelegramApiError(method, "Bad Request: message to delete not found", 400, undefined);
			if (method === "editMessageText") throw new Error("stale preview should not be reused after terminal delete failure");
			throw new Error(`unexpected method: ${method}`);
		},
		async () => 99,
	);

	await manager.messageStart("turn", -100, 5);
	manager.preview("turn", -100, 5, "preview text");
	await flushNow(manager, "turn", -100, 5);
	await manager.clear("turn", -100, 5, { preserveOnFailure: true });
	await manager.messageStart("turn", -100, 5);
	manager.preview("turn", -100, 5, "fresh retry preview");
	await flushNow(manager, "turn", -100, 5);

	assert.deepEqual(calls, [
		"sendMessage:preview text",
		"deleteMessage:88",
		"sendMessage:fresh retry preview",
	]);
	assert.equal(managerInternals(manager).previews.get("turn")?.messageId, 89);
}

async function checkTeardownClearDoesNotPreserveOnDeleteFailure(): Promise<void> {
	const calls: string[] = [];
	const manager = new PreviewManager(
		async <TResponse>(method: string, body: Record<string, unknown>) => {
			calls.push(`${method}:${String(body.text ?? body.message_id ?? "")}`);
			if (method === "sendMessage") return ({ message_id: 90 } satisfies TelegramSentMessage) as TResponse;
			if (method === "deleteMessage") throw new Error("transport failure");
			throw new Error(`unexpected method: ${method}`);
		},
		async () => 99,
	);

	await manager.messageStart("turn", -100, 5);
	manager.preview("turn", -100, 5, "preview text");
	await flushNow(manager, "turn", -100, 5);
	await manager.clear("turn", -100, 5);

	assert.deepEqual(calls, [
		"sendMessage:preview text",
		"deleteMessage:90",
	]);
	assert.equal(managerInternals(manager).previews.has("turn"), false);
}

async function checkRetryPreserveClearSurfacesPermanentDeleteFailure(): Promise<void> {
	const calls: string[] = [];
	const manager = new PreviewManager(
		async <TResponse>(method: string, body: Record<string, unknown>) => {
			calls.push(`${method}:${String(body.text ?? body.message_id ?? "")}`);
			if (method === "sendMessage") return ({ message_id: 93 } satisfies TelegramSentMessage) as TResponse;
			if (method === "deleteMessage") throw new TelegramApiError(method, "Bad Request: message can't be deleted", 400, undefined);
			throw new Error(`unexpected method: ${method}`);
		},
		async () => 99,
	);

	await manager.messageStart("turn", -100, 5);
	manager.preview("turn", -100, 5, "preview text");
	await flushNow(manager, "turn", -100, 5);
	await assert.rejects(() => manager.clear("turn", -100, 5, { preserveOnFailure: true }), /can't be deleted/i);
	assert.deepEqual(calls, [
		"sendMessage:preview text",
		"deleteMessage:93",
	]);
	assert.equal(managerInternals(manager).previews.has("turn"), true);
}

async function checkRetryPreviewRecoversWhenPreservedMessageWasAlreadyGone(): Promise<void> {
	const calls: string[] = [];
	let editAttempts = 0;
	const manager = new PreviewManager(
		async <TResponse>(method: string, body: Record<string, unknown>) => {
			calls.push(`${method}:${String(body.text ?? body.message_id ?? "")}`);
			if (method === "sendMessage") return ({ message_id: calls.length === 1 ? 91 : 92 } satisfies TelegramSentMessage) as TResponse;
			if (method === "deleteMessage") throw new Error("transport failure");
			if (method === "editMessageText") {
				editAttempts += 1;
				throw new TelegramApiError(method, "Bad Request: message to edit not found", 400, undefined);
			}
			throw new Error(`unexpected method: ${method}`);
		},
		async () => 99,
	);

	await manager.messageStart("turn", -100, 5);
	manager.preview("turn", -100, 5, "preview text");
	await flushNow(manager, "turn", -100, 5);
	await manager.clear("turn", -100, 5, { preserveOnFailure: true });
	await manager.messageStart("turn", -100, 5);
	manager.preview("turn", -100, 5, "fresh retry preview");
	await flushNow(manager, "turn", -100, 5);

	assert.equal(editAttempts, 1);
	assert.deepEqual(calls, [
		"sendMessage:preview text",
		"deleteMessage:91",
		"editMessageText:fresh retry preview",
		"sendMessage:fresh retry preview",
	]);
	assert.equal(managerInternals(manager).previews.get("turn")?.messageId, 92);
}

async function checkFinalizeDeletesStalePreviewBeforeSendingReplacementFinal(): Promise<void> {
	const calls: string[] = [];
	const manager = new PreviewManager(
		async <TResponse>(method: string, body: Record<string, unknown>) => {
			calls.push(`${method}:${String(body.text ?? body.message_id ?? "")}`);
			if (method === "sendMessage") return ({ message_id: calls.length === 1 ? 101 : 102 } satisfies TelegramSentMessage) as TResponse;
			if (method === "editMessageText") throw new TelegramApiError(method, "Bad Request: message can't be edited", 400, undefined);
			if (method === "deleteMessage") return true as TResponse;
			throw new Error(`unexpected method: ${method}`);
		},
		async (_chatId, _threadId, text) => {
			calls.push(`reply:${text}`);
			return 102;
		},
	);

	await manager.messageStart("turn", -100, 5);
	manager.preview("turn", -100, 5, "preview text");
	await flushNow(manager, "turn", -100, 5);
	const finalized = await manager.finalize("turn", -100, 5, "final text");

	assert.equal(finalized, true);
	assert.deepEqual(calls, [
		"sendMessage:preview text",
		"editMessageText:final text",
		"editMessageText:final text",
		"deleteMessage:101",
		"reply:final text",
	]);
	assert.equal(managerInternals(manager).previews.has("turn"), false);
}

async function checkFinalizeStopsOnPermanentDeleteFailure(): Promise<void> {
	const calls: string[] = [];
	const manager = new PreviewManager(
		async <TResponse>(method: string, body: Record<string, unknown>) => {
			calls.push(`${method}:${String(body.text ?? body.message_id ?? "")}`);
			if (method === "sendMessage") return ({ message_id: 105 } satisfies TelegramSentMessage) as TResponse;
			if (method === "editMessageText") throw new TelegramApiError(method, "Bad Request: message can't be edited", 400, undefined);
			if (method === "deleteMessage") throw new TelegramApiError(method, "Bad Request: message can't be deleted", 400, undefined);
			throw new Error(`unexpected method: ${method}`);
		},
		async () => {
			throw new Error("replacement final should not be sent when preview deletion is permanently blocked");
		},
	);

	await manager.messageStart("turn", -100, 5);
	manager.preview("turn", -100, 5, "preview text");
	await flushNow(manager, "turn", -100, 5);
	await assert.rejects(() => manager.finalize("turn", -100, 5, "final text"), /can't be deleted/i);
	assert.deepEqual(calls, [
		"sendMessage:preview text",
		"editMessageText:final text",
		"editMessageText:final text",
		"deleteMessage:105",
	]);
}

async function checkFinalizeDoesNotDuplicateWhenDeleteRetryableFails(): Promise<void> {
	const calls: string[] = [];
	const manager = new PreviewManager(
		async <TResponse>(method: string, body: Record<string, unknown>) => {
			calls.push(`${method}:${String(body.text ?? body.message_id ?? "")}`);
			if (method === "sendMessage") return ({ message_id: 111 } satisfies TelegramSentMessage) as TResponse;
			if (method === "editMessageText") throw new TelegramApiError(method, "Bad Request: message can't be edited", 400, undefined);
			if (method === "deleteMessage") throw new TelegramApiError(method, "Too Many Requests", 429, 2);
			throw new Error(`unexpected method: ${method}`);
		},
		async () => {
			throw new Error("replacement final should not be sent while preview delete is retryable");
		},
	);

	await manager.messageStart("turn", -100, 5);
	manager.preview("turn", -100, 5, "preview text");
	await flushNow(manager, "turn", -100, 5);
	await assert.rejects(() => manager.finalize("turn", -100, 5, "final text"), /Too Many Requests/);
	assert.deepEqual(calls, [
		"sendMessage:preview text",
		"editMessageText:final text",
		"editMessageText:final text",
		"deleteMessage:111",
	]);
}

async function checkPreviewRehydratesDurableMessageIdWithoutMessageStart(): Promise<void> {
	const calls: string[] = [];
	const manager = new PreviewManager(
		async <TResponse>(method: string, body: Record<string, unknown>) => {
			calls.push(`${method}:${String(body.text ?? body.message_id ?? "")}`);
			if (method === "editMessageText") return true as TResponse;
			if (method === "sendMessage") throw new Error("preview should edit durable message instead of sending a new one");
			throw new Error(`unexpected method: ${method}`);
		},
		async () => 99,
	);

	manager.preview("turn", -100, 5, "rehydrated text", 777);
	await flushNow(manager, "turn", -100, 5);

	assert.deepEqual(calls, ["editMessageText:rehydrated text"]);
	assert.equal(managerInternals(manager).previews.get("turn")?.messageId, 777);
}

await checkNotModifiedPreviewEditIsSuccess();
await checkRetryAfterStillPropagates();
await checkClearPreservesPreviewStateOnDeleteFailure();
await checkTerminalDeleteFailureDropsPreviewStateForRetry();
await checkTeardownClearDoesNotPreserveOnDeleteFailure();
await checkRetryPreserveClearSurfacesPermanentDeleteFailure();
await checkRetryPreviewRecoversWhenPreservedMessageWasAlreadyGone();
await checkFinalizeDeletesStalePreviewBeforeSendingReplacementFinal();
await checkFinalizeStopsOnPermanentDeleteFailure();
await checkFinalizeDoesNotDuplicateWhenDeleteRetryableFails();
await checkPreviewRehydratesDurableMessageIdWithoutMessageStart();
console.log("Preview manager checks passed");
