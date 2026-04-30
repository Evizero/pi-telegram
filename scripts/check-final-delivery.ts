import { createHash } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import { AssistantFinalDeliveryLedger } from "../src/broker/finals.js";
import { TelegramApiError } from "../src/telegram/api-errors.js";
import type { BrokerState, PendingAssistantFinalDelivery } from "../src/broker/types.js";
import type { PendingTelegramTurn, QueuedAttachment } from "../src/client/types.js";
import type { TelegramSentMessage } from "../src/telegram/types.js";
import type { PreviewManager } from "../src/telegram/previews.js";
import { now } from "../src/shared/utils.js";

function turn(id: string): PendingTelegramTurn {
	return { turnId: id, sessionId: "s1", chatId: 123, messageThreadId: 9, replyToMessageId: 0, queuedAttachments: [], content: [], historyText: "" };
}

function emptyState(): BrokerState {
	return {
		schemaVersion: 1,
		recentUpdateIds: [],
		sessions: {
			s1: {
				sessionId: "s1",
				ownerId: "owner-1",
				pid: 123,
				cwd: "/tmp/project",
				projectName: "project",
				status: "busy",
				queuedTurnCount: 0,
				lastHeartbeatMs: now(),
				connectedAtMs: now(),
				connectionStartedAtMs: now(),
				connectionNonce: "conn-1",
				clientSocketPath: "/tmp/client.sock",
				topicName: "project · main",
			},
		},
		routes: { "123:9": { routeId: "123:9", sessionId: "s1", chatId: 123, messageThreadId: 9, routeMode: "forum_supergroup_topic", topicName: "project · main", createdAtMs: now(), updatedAtMs: now() } },
		pendingTurns: {},
		pendingAssistantFinals: {},
		completedTurnIds: [],
		createdAtMs: now(),
		updatedAtMs: now(),
	};
}

function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function entry(id: string, fields: Partial<PendingAssistantFinalDelivery>): PendingAssistantFinalDelivery {
	return {
		turn: turn(id),
		text: "final text",
		attachments: [],
		status: "pending",
		createdAtMs: now(),
		updatedAtMs: now(),
		progress: { activityCompleted: true, typingStopped: true, previewDetached: true, sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] },
		...fields,
	};
}

function fakePreview(): PreviewManager {
	return {
		clear: async () => undefined,
		detachForFinal: async () => undefined,
	} as unknown as PreviewManager;
}

function makeLedger(options?: {
	state?: BrokerState;
	previewManager?: PreviewManager;
	callTelegram?: (method: string, body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>;
	callTelegramMultipart?: (method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string) => Promise<unknown>;
}) {
	let state = options?.state ?? emptyState();
	let persists = 0;
	const completed: string[] = [];
	const terminalFailures: string[] = [];
	const ledger = new AssistantFinalDeliveryLedger({
		getBrokerState: () => state,
		setBrokerState: (next) => { state = next; },
		loadBrokerState: async () => state,
		persistBrokerState: async () => { persists += 1; },
		activityComplete: async () => undefined,
		stopTypingLoop: () => undefined,
		previewManager: options?.previewManager ?? fakePreview(),
		callTelegram: async <TResponse>(method: string, body: Record<string, unknown>, requestOptions?: { signal?: AbortSignal }) => (options?.callTelegram ? await options.callTelegram(method, body, requestOptions) : { message_id: 1 }) as TResponse,
		callTelegramMultipart: async <TResponse>(method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string) => (options?.callTelegramMultipart ? await options.callTelegramMultipart(method, fields, fileField, filePath, fileName) : { message_id: 1 }) as TResponse,
		isBrokerActive: () => true,
		rememberCompletedBrokerTurn: async (turnId) => { if (!state.completedTurnIds?.includes(turnId)) state.completedTurnIds?.push(turnId); completed.push(turnId); },
		logTerminalFailure: (_turnId, reason) => { terminalFailures.push(reason); },
	});
	return { ledger, get state() { return state; }, get persists() { return persists; }, completed, terminalFailures };
}

async function checkOrdinaryFinalOnlyDeliveryDoesNotTouchPreviewState(): Promise<void> {
	const calls: Array<{ method: string; text?: unknown; disableNotification?: unknown; messageThreadId?: unknown }> = [];
	let previewCalls = 0;
	const state = emptyState();
	state.pendingAssistantFinals = {
		ordinary: entry("ordinary", { text: "final only" }),
	};
	const env = makeLedger({
		state,
		previewManager: {
			clear: async () => { previewCalls += 1; },
			detachForFinal: async () => {
				previewCalls += 1;
				return undefined;
			},
		} as unknown as PreviewManager,
		callTelegram: async (method, body) => {
			calls.push({ method, text: body.text, disableNotification: body.disable_notification, messageThreadId: body.message_thread_id });
			return { message_id: 41 } satisfies TelegramSentMessage;
		},
	});

	await env.ledger.drainReady();

	assert.equal(previewCalls, 0);
	assert.deepEqual(calls, [{ method: "sendMessage", text: "final only", disableNotification: undefined, messageThreadId: 9 }]);
	assert.deepEqual(env.state.completedTurnIds, ["ordinary"]);
}

async function checkAssistantFinalAcceptsWithoutLiveSessionOrRoute(): Promise<void> {
	const state = emptyState();
	state.sessions = {};
	state.routes = {};
	const env = makeLedger({ state, callTelegram: async () => new Promise(() => undefined) });
	await env.ledger.accept({ turn: turn("orphan"), text: "hello", attachments: [] });
	assert.equal(env.state.pendingAssistantFinals?.orphan?.text, "hello");
	assert.ok(env.persists >= 1);
}

async function checkDuplicateAssistantFinalHandoff(): Promise<void> {
	const state = emptyState();
	state.pendingTurns = { dup: { turn: turn("dup"), updatedAtMs: now() } };
	const env = makeLedger({ state, callTelegram: async () => new Promise(() => undefined) });
	await env.ledger.accept({ turn: turn("dup"), text: "hello", attachments: [] });
	await env.ledger.accept({ turn: turn("dup"), text: "hello again", attachments: [] });
	assert.equal(Object.keys(env.state.pendingAssistantFinals ?? {}).length, 1);
	assert.equal(env.state.pendingAssistantFinals?.dup?.text, "hello");
	assert.equal(env.state.pendingTurns?.dup, undefined);
	assert.ok(env.persists >= 1);
}

async function checkChunkResumeSkipsSentChunks(): Promise<void> {
	const sentTexts: string[] = [];
	const chunks = ["already 0", "already 1", "send 2"];
	const state = emptyState();
	state.pendingAssistantFinals = {
		chunky: entry("chunky", {
			text: chunks.join("\n\n"),
			progress: { activityCompleted: true, typingStopped: true, previewDetached: true, textHash: hash(chunks.join("\n\n")), chunks, sentChunkIndexes: [0, 1], sentChunkMessageIds: { "0": 10, "1": 11 }, sentAttachmentIndexes: [] },
		}),
	};
	const env = makeLedger({
		state,
		callTelegram: async (_method, body) => {
			sentTexts.push(String(body.text));
			return { message_id: 12 } satisfies TelegramSentMessage;
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(sentTexts, ["send 2"]);
	assert.deepEqual(env.state.completedTurnIds, ["chunky"]);
	assert.equal(env.state.pendingAssistantFinals?.chunky, undefined);
}

async function checkAttachmentRetryDoesNotResendText(): Promise<void> {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-telegram-final-check-"));
	try {
		const attachmentPath = join(tempDir, "artifact.txt");
		writeFileSync(attachmentPath, "artifact");
		const attachment: QueuedAttachment = { path: attachmentPath, fileName: "artifact.txt" };
		const textCalls: string[] = [];
		const uploads: string[] = [];
		const state = emptyState();
		state.pendingAssistantFinals = {
			attach: entry("attach", {
				text: "done",
				attachments: [attachment],
				progress: { activityCompleted: true, typingStopped: true, previewDetached: true, textHash: hash("done"), chunks: ["done"], sentChunkIndexes: [0], sentChunkMessageIds: { "0": 10 }, sentAttachmentIndexes: [] },
			}),
		};
		const env = makeLedger({
			state,
			callTelegram: async (_method, body) => {
				textCalls.push(String(body.text));
				return { message_id: 20 } satisfies TelegramSentMessage;
			},
			callTelegramMultipart: async (method) => {
				uploads.push(method);
				return { message_id: 21 } satisfies TelegramSentMessage;
			},
		});
		await env.ledger.drainReady();
		assert.deepEqual(textCalls, []);
		assert.deepEqual(uploads, ["sendDocument"]);
		assert.deepEqual(env.state.completedTurnIds, ["attach"]);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

async function checkDurablePreviewMessageIsReplacedAfterRestart(): Promise<void> {
	const calls: Array<{ method: string; messageId?: unknown; text?: unknown }> = [];
	const state = emptyState();
	state.assistantPreviewMessages = { previewed: { chatId: 123, messageThreadId: 9, messageId: 44, updatedAtMs: now() } };
	state.pendingAssistantFinals = {
		previewed: entry("previewed", { text: "final", progress: { activityCompleted: true, typingStopped: true, sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] } }),
	};
	const env = makeLedger({
		state,
		callTelegram: async (method, body) => {
			calls.push({ method, messageId: body.message_id, text: body.text });
			return { message_id: Number(body.message_id ?? 45) } satisfies TelegramSentMessage;
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(calls, [
		{ method: "deleteMessage", messageId: 44, text: undefined },
		{ method: "sendMessage", messageId: undefined, text: "final" },
	]);
	assert.equal(env.state.assistantPreviewMessages?.previewed, undefined);
	assert.deepEqual(env.state.completedTurnIds, ["previewed"]);
}

async function checkLegacyPreviewEditedFirstChunkIsResentFreshAfterCleanup(): Promise<void> {
	const calls: Array<{ method: string; messageId?: unknown; text?: unknown }> = [];
	const state = emptyState();
	state.pendingAssistantFinals = {
		legacyPreviewEdit: entry("legacyPreviewEdit", {
			text: "first\n\nsecond",
			progress: {
				activityCompleted: true,
				typingStopped: true,
				previewDetached: true,
				previewMode: "message",
				previewMessageId: 44,
				textHash: hash("first\n\nsecond"),
				chunks: ["first", "second"],
				sentChunkIndexes: [0],
				sentChunkMessageIds: { "0": 44 },
				sentAttachmentIndexes: [],
			},
		}),
	};
	const env = makeLedger({
		state,
		callTelegram: async (method, body) => {
			calls.push({ method, messageId: body.message_id, text: body.text });
			return { message_id: method === "sendMessage" && body.text === "first" ? 45 : 46 } satisfies TelegramSentMessage;
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(calls, [
		{ method: "deleteMessage", messageId: 44, text: undefined },
		{ method: "sendMessage", messageId: undefined, text: "first" },
		{ method: "sendMessage", messageId: undefined, text: "second" },
	]);
	assert.deepEqual(env.state.completedTurnIds, ["legacyPreviewEdit"]);
}

async function checkLegacyPreviewEditedFinalResendsAlreadySentChunksInOrder(): Promise<void> {
	const calls: Array<{ method: string; messageId?: unknown; text?: unknown }> = [];
	const state = emptyState();
	state.pendingAssistantFinals = {
		legacySentSecond: entry("legacySentSecond", {
			text: "first\n\nsecond",
			progress: {
				activityCompleted: true,
				typingStopped: true,
				previewDetached: true,
				previewMode: "message",
				previewMessageId: 44,
				textHash: hash("first\n\nsecond"),
				chunks: ["first", "second"],
				sentChunkIndexes: [0, 1],
				sentChunkMessageIds: { "0": 44, "1": 47 },
				sentAttachmentIndexes: [],
			},
		}),
	};
	const env = makeLedger({
		state,
		callTelegram: async (method, body) => {
			calls.push({ method, messageId: body.message_id, text: body.text });
			return { message_id: method === "sendMessage" && body.text === "first" ? 45 : 46 } satisfies TelegramSentMessage;
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(calls, [
		{ method: "deleteMessage", messageId: 44, text: undefined },
		{ method: "deleteMessage", messageId: 47, text: undefined },
		{ method: "sendMessage", messageId: undefined, text: "first" },
		{ method: "sendMessage", messageId: undefined, text: "second" },
	]);
	assert.deepEqual(env.state.completedTurnIds, ["legacySentSecond"]);
}

async function checkLegacyPreviewEditedFirstChunkSurvivesStopAfterCleanup(): Promise<void> {
	const calls: Array<{ method: string; messageId?: unknown; text?: unknown }> = [];
	const state = emptyState();
	state.pendingAssistantFinals = {
		legacyStop: entry("legacyStop", {
			text: "first\n\nsecond",
			progress: {
				activityCompleted: true,
				typingStopped: true,
				previewDetached: true,
				previewMode: "message",
				previewMessageId: 44,
				textHash: hash("first\n\nsecond"),
				chunks: ["first", "second"],
				sentChunkIndexes: [0],
				sentChunkMessageIds: { "0": 44 },
				sentAttachmentIndexes: [],
			},
		}),
	};
	let stopAfterDelete = true;
	const env = makeLedger({
		state,
		callTelegram: async (method, body) => {
			calls.push({ method, messageId: body.message_id, text: body.text });
			if (method === "deleteMessage" && stopAfterDelete) {
				stopAfterDelete = false;
				env.ledger.stop();
			}
			return { message_id: method === "sendMessage" && body.text === "first" ? 45 : 46 } satisfies TelegramSentMessage;
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(calls, [{ method: "deleteMessage", messageId: 44, text: undefined }]);
	assert.deepEqual(env.state.pendingAssistantFinals?.legacyStop?.progress.sentChunkIndexes, []);
	assert.equal(env.state.pendingAssistantFinals?.legacyStop?.progress.previewCleanupDone, true);
	env.ledger.start();
	await env.ledger.drainReady();
	assert.deepEqual(calls, [
		{ method: "deleteMessage", messageId: 44, text: undefined },
		{ method: "sendMessage", messageId: undefined, text: "first" },
		{ method: "sendMessage", messageId: undefined, text: "second" },
	]);
	assert.deepEqual(env.state.completedTurnIds, ["legacyStop"]);
}

async function checkOfflineSessionFinalCompletionQueuesRouteCleanup(): Promise<void> {
	const state = emptyState();
	delete state.sessions.s1;
	state.pendingAssistantFinals = {
		offline: entry("offline", { text: "final" }),
	};
	const env = makeLedger({
		state,
		callTelegram: async (_method, body) => ({ message_id: typeof body.message_id === "number" ? body.message_id : 55 } satisfies TelegramSentMessage),
	});
	await env.ledger.drainReady();
	assert.equal(env.state.pendingAssistantFinals?.offline, undefined);
	assert.equal(env.state.routes["123:9"], undefined);
	assert.ok(env.state.pendingRouteCleanups?.["123:9"]);
	assert.deepEqual(env.state.completedTurnIds, ["offline"]);
}

async function checkOfflineSessionFinalCompletionAlsoCleansPendingTurnPreviewState(): Promise<void> {
	const state = emptyState();
	delete state.sessions.s1;
	state.pendingTurns = { hold: { turn: turn("hold"), updatedAtMs: now() } };
	state.assistantPreviewMessages = { hold: { chatId: 123, messageThreadId: 9, messageId: 66, updatedAtMs: now() } };
	state.pendingAssistantFinals = {
		offline: entry("offline", { text: "final" }),
	};
	const env = makeLedger({
		state,
		callTelegram: async (_method, body) => ({ message_id: typeof body.message_id === "number" ? body.message_id : 55 } satisfies TelegramSentMessage),
	});
	await env.ledger.drainReady();
	assert.equal(env.state.pendingAssistantFinals?.offline, undefined);
	assert.ok(env.state.pendingTurns?.hold);
	assert.equal(env.state.assistantPreviewMessages?.hold, undefined);
	assert.equal(env.state.routes["123:9"], undefined);
	assert.ok(env.state.pendingRouteCleanups?.["123:9"]);
	assert.deepEqual(env.state.completedTurnIds, ["offline"]);
}

async function checkOfflineSessionFinalCompletionPreservesPreviewRefWhenDeleteRetryableFails(): Promise<void> {
	const state = emptyState();
	delete state.sessions.s1;
	state.pendingTurns = { hold: { turn: turn("hold"), updatedAtMs: now() } };
	state.assistantPreviewMessages = { hold: { chatId: 123, messageThreadId: 9, messageId: 66, updatedAtMs: now() } };
	state.pendingAssistantFinals = {
		offline: entry("offline", { text: "final" }),
	};
	const env = makeLedger({
		state,
		callTelegram: async (method, body) => {
			if (method === "deleteMessage") throw new TelegramApiError(method, "Too Many Requests", 429, 2);
			return { message_id: typeof body.message_id === "number" ? body.message_id : 55 } satisfies TelegramSentMessage;
		},
	});
	await env.ledger.drainReady();
	assert.ok(env.state.assistantPreviewMessages?.hold);
	assert.equal(env.state.pendingAssistantFinals?.offline, undefined);
}

async function checkBrokerStopPreventsFurtherDelivery(): Promise<void> {
	const sentTexts: string[] = [];
	const chunks = ["first", "second"];
	const state = emptyState();
	state.pendingAssistantFinals = {
		stopped: entry("stopped", {
			text: chunks.join("\n\n"),
			progress: { activityCompleted: true, typingStopped: true, previewDetached: true, textHash: hash(chunks.join("\n\n")), chunks, sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] },
		}),
	};
	const env = makeLedger({
		state,
		callTelegram: async (_method, body) => {
			sentTexts.push(String(body.text));
			env.ledger.stop();
			return { message_id: 30 } satisfies TelegramSentMessage;
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(sentTexts, ["first"]);
	assert.deepEqual(env.state.pendingAssistantFinals?.stopped?.progress.sentChunkIndexes, [0]);
	assert.equal(env.state.pendingAssistantFinals?.stopped !== undefined, true);
}

async function checkClearPreviewRetryAfterStaysPending(): Promise<void> {
	const calls: string[] = [];
	const state = emptyState();
	state.assistantPreviewMessages = { aborted: { chatId: 123, messageThreadId: 9, messageId: 77, updatedAtMs: now() } };
	state.pendingAssistantFinals = {
		aborted: entry("aborted", { text: undefined, stopReason: "aborted", progress: { activityCompleted: true, typingStopped: true, sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] } }),
	};
	const env = makeLedger({
		state,
		callTelegram: async (method) => {
			calls.push(method);
			throw new TelegramApiError(method, "Too Many Requests", 429, 60);
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(calls, ["deleteMessage"]);
	assert.equal(env.state.pendingAssistantFinals?.aborted?.progress.previewCleared, undefined);
	assert.ok((env.state.pendingAssistantFinals?.aborted?.retryAtMs ?? 0) > now());
	env.ledger.clearTimer();
}

async function checkDeletePreviewRetryAfterStopsReplacementSend(): Promise<void> {
	const calls: string[] = [];
	const state = emptyState();
	state.pendingAssistantFinals = {
		deleteRetry: entry("deleteRetry", {
			text: "replacement",
			progress: { activityCompleted: true, typingStopped: true, previewDetached: true, previewMode: "message", previewMessageId: 99, textHash: hash("replacement"), chunks: ["replacement"], sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] },
		}),
	};
	const env = makeLedger({
		state,
		callTelegram: async (method) => {
			calls.push(method);
			if (method === "deleteMessage") throw new TelegramApiError(method, "Too Many Requests", 429, 60);
			throw new TelegramApiError(method, "Bad Request", 400, undefined);
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(calls, ["deleteMessage"]);
	assert.deepEqual(env.state.pendingAssistantFinals?.deleteRetry?.progress.sentChunkIndexes, []);
	assert.ok((env.state.pendingAssistantFinals?.deleteRetry?.retryAtMs ?? 0) > now());
	env.ledger.clearTimer();
}

async function checkDeletePreviewTransportFailureStopsReplacementSend(): Promise<void> {
	const calls: string[] = [];
	const state = emptyState();
	state.pendingAssistantFinals = {
		deleteTransport: entry("deleteTransport", {
			text: "replacement",
			progress: { activityCompleted: true, typingStopped: true, previewDetached: true, previewMode: "message", previewMessageId: 99, textHash: hash("replacement"), chunks: ["replacement"], sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] },
		}),
	};
	const env = makeLedger({
		state,
		callTelegram: async (method) => {
			calls.push(method);
			if (method === "deleteMessage") throw new Error("fetch failed");
			throw new TelegramApiError(method, "Bad Request", 400, undefined);
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(calls, ["deleteMessage"]);
	assert.deepEqual(env.state.pendingAssistantFinals?.deleteTransport?.progress.sentChunkIndexes, []);
	assert.ok((env.state.pendingAssistantFinals?.deleteTransport?.retryAtMs ?? 0) > now());
	env.ledger.clearTimer();
}

async function checkDeletePreviewMissingStillSendsReplacementFinal(): Promise<void> {
	const calls: string[] = [];
	const state = emptyState();
	state.pendingAssistantFinals = {
		deleteMissing: entry("deleteMissing", {
			text: "replacement",
			progress: { activityCompleted: true, typingStopped: true, previewDetached: true, previewMode: "message", previewMessageId: 99, textHash: hash("replacement"), chunks: ["replacement"], sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] },
		}),
	};
	const env = makeLedger({
		state,
		callTelegram: async (method, body) => {
			calls.push(`${method}:${String(body.text ?? body.message_id ?? "")}`);
			if (method === "deleteMessage") throw new TelegramApiError(method, "Bad Request: message to delete not found", 400, undefined);
			return { message_id: 100 } satisfies TelegramSentMessage;
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(calls, ["deleteMessage:99", "sendMessage:replacement"]);
	assert.equal(env.state.pendingAssistantFinals?.deleteMissing, undefined);
	assert.deepEqual(env.state.completedTurnIds, ["deleteMissing"]);
}

async function checkPermanentDeletePreviewErrorAppendsFreshFinal(): Promise<void> {
	const calls: string[] = [];
	const state = emptyState();
	state.pendingAssistantFinals = {
		deletePermanent: entry("deletePermanent", {
			text: "replacement",
			progress: { activityCompleted: true, typingStopped: true, previewDetached: true, previewMode: "message", previewMessageId: 99, textHash: hash("replacement"), chunks: ["replacement"], sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] },
		}),
	};
	const env = makeLedger({
		state,
		callTelegram: async (method, body) => {
			calls.push(`${method}:${String(body.text ?? body.message_id ?? "")}`);
			if (method === "deleteMessage") throw new TelegramApiError(method, "Bad Request: message can't be deleted", 400, undefined);
			return { message_id: 100 } satisfies TelegramSentMessage;
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(calls, ["deleteMessage:99", "sendMessage:replacement"]);
	assert.equal(env.state.pendingAssistantFinals?.deletePermanent, undefined);
	assert.deepEqual(env.state.completedTurnIds, ["deletePermanent"]);
	assert.deepEqual(env.terminalFailures, []);
}

async function checkDetachedSessionFinalIsQueuedWithoutLiveSession(): Promise<void> {
	const state = { ...emptyState(), sessions: {}, routes: {} };
	const env = makeLedger({ state });
	await env.ledger.accept({ turn: turn("ignored"), text: "ignored", attachments: [] });
	assert.equal(env.state.pendingAssistantFinals?.ignored?.text, "ignored");
	assert.deepEqual(env.state.completedTurnIds, []);
}

async function checkDisconnectCancelsInFlightFinalDelivery(): Promise<void> {
	const state = emptyState();
	state.pendingAssistantFinals = {
		cancel: entry("cancel", { text: "final" }),
	};
	let started = false;
	let aborted = false;
	const env = makeLedger({
		state,
		callTelegram: async (_method, _body, options) => {
			started = true;
			await new Promise<never>((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => {
					aborted = true;
					reject(new DOMException("Aborted", "AbortError"));
				});
			});
		},
	});
	const draining = env.ledger.drainReady();
	while (!started) await new Promise((resolveValue) => setTimeout(resolveValue, 0));
	await env.ledger.cancelSession("s1");
	delete env.state.pendingAssistantFinals?.cancel;
	await draining;
	assert.equal(aborted, true);
	assert.equal(env.completed.includes("cancel"), false);
	assert.equal(env.state.pendingAssistantFinals?.cancel, undefined);
}

async function checkRetryAfterBlocksNewerFinals(): Promise<void> {
	const textCalls: string[] = [];
	const state = emptyState();
	state.pendingAssistantFinals = {
		first: entry("first", { text: "first", createdAtMs: now() }),
		second: entry("second", { text: "second", createdAtMs: now() + 1 }),
	};
	const env = makeLedger({
		state,
		callTelegram: async (_method, body) => {
			textCalls.push(String(body.text));
			throw new TelegramApiError("sendMessage", "Too Many Requests", 429, 60);
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(textCalls, ["first"]);
	assert.equal(env.state.pendingAssistantFinals?.first?.status, "pending");
	assert.ok((env.state.pendingAssistantFinals?.first?.retryAtMs ?? 0) > now());
	assert.equal(env.state.pendingAssistantFinals?.second?.progress.sentChunkIndexes?.length, 0);
	env.ledger.clearTimer();
}

async function checkErrorFinalWithTextPrefersText(): Promise<void> {
	const textCalls: string[] = [];
	const state = emptyState();
	state.pendingAssistantFinals = {
		errorText: entry("errorText", { text: "useful final text", stopReason: "error", errorMessage: "fetch failed" }),
	};
	const env = makeLedger({
		state,
		callTelegram: async (_method, body) => {
			textCalls.push(String(body.text));
			return { message_id: 61 } satisfies TelegramSentMessage;
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(textCalls, ["useful final text"]);
	assert.deepEqual(env.state.completedTurnIds, ["errorText"]);
}

async function checkErrorOnlyFinalUsesClearFailureText(): Promise<void> {
	const textCalls: string[] = [];
	const state = emptyState();
	state.pendingAssistantFinals = {
		errorOnly: entry("errorOnly", { text: undefined, stopReason: "error", errorMessage: "terminated" }),
	};
	const env = makeLedger({
		state,
		callTelegram: async (_method, body) => {
			textCalls.push(String(body.text));
			return { message_id: 62 } satisfies TelegramSentMessage;
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(textCalls, ["Telegram bridge: pi failed while processing the request: terminated"]);
	assert.deepEqual(env.state.completedTurnIds, ["errorOnly"]);
}

async function checkErrorOnlyFinalAppendsAfterPermanentPreviewCleanupFailure(): Promise<void> {
	const calls: string[] = [];
	const state = emptyState();
	state.pendingAssistantFinals = {
		errorPreview: entry("errorPreview", {
			text: undefined,
			stopReason: "error",
			errorMessage: "terminated",
			progress: { activityCompleted: true, typingStopped: true, previewDetached: true, previewMode: "message", previewMessageId: 99, sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] },
		}),
	};
	const env = makeLedger({
		state,
		callTelegram: async (method, body) => {
			calls.push(`${method}:${String(body.text ?? body.message_id ?? "")}`);
			if (method === "deleteMessage") throw new TelegramApiError(method, "Bad Request: message can't be deleted", 400, undefined);
			return { message_id: 63 } satisfies TelegramSentMessage;
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(calls, ["deleteMessage:99", "sendMessage:Telegram bridge: pi failed while processing the request: terminated"]);
	assert.deepEqual(env.state.completedTurnIds, ["errorPreview"]);
	assert.deepEqual(env.terminalFailures, []);
}

async function checkAttachmentOnlyFinalAppendsNoticeAfterPermanentPreviewCleanupFailure(): Promise<void> {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-telegram-final-check-"));
	try {
		const attachmentPath = join(tempDir, "artifact.txt");
		writeFileSync(attachmentPath, "artifact");
		const calls: string[] = [];
		const uploads: string[] = [];
		const state = emptyState();
		state.pendingAssistantFinals = {
			attachmentPreview: entry("attachmentPreview", {
				text: undefined,
				attachments: [{ path: attachmentPath, fileName: "artifact.txt" }],
				progress: { activityCompleted: true, typingStopped: true, previewDetached: true, previewMode: "message", previewMessageId: 99, sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] },
			}),
		};
		const env = makeLedger({
			state,
			callTelegram: async (method, body) => {
				calls.push(`${method}:${String(body.text ?? body.message_id ?? "")}`);
				if (method === "deleteMessage") throw new TelegramApiError(method, "Bad Request: message can't be deleted", 400, undefined);
				return { message_id: 64 } satisfies TelegramSentMessage;
			},
			callTelegramMultipart: async (method) => {
				uploads.push(method);
				return { message_id: 65 } satisfies TelegramSentMessage;
			},
		});
		await env.ledger.drainReady();
		assert.deepEqual(calls, ["deleteMessage:99", "sendMessage:Attached requested file(s)."]);
		assert.deepEqual(uploads, ["sendDocument"]);
		assert.deepEqual(env.state.completedTurnIds, ["attachmentPreview"]);
		assert.deepEqual(env.terminalFailures, []);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

async function checkTransportFetchFailedStaysPending(): Promise<void> {
	const textCalls: string[] = [];
	const state = emptyState();
	state.pendingAssistantFinals = {
		transport: entry("transport", { text: "final text" }),
	};
	const env = makeLedger({
		state,
		callTelegram: async (_method, body) => {
			textCalls.push(String(body.text));
			throw new Error("fetch failed");
		},
	});
	await env.ledger.drainReady();
	assert.deepEqual(textCalls, ["final text"]);
	assert.equal(env.state.pendingAssistantFinals?.transport?.status, "pending");
	assert.ok((env.state.pendingAssistantFinals?.transport?.retryAtMs ?? 0) > now());
	assert.deepEqual(env.state.completedTurnIds, []);
	env.ledger.clearTimer();
}

async function checkUnauthorizedTelegramFailureGoesTerminal(): Promise<void> {
	const state = emptyState();
	state.pendingAssistantFinals = {
		unauthorized: entry("unauthorized", { text: "final text" }),
	};
	const env = makeLedger({
		state,
		callTelegram: async (method) => {
			throw new TelegramApiError(method, "Unauthorized", 401, undefined);
		},
	});
	await env.ledger.drainReady();
	assert.equal(env.state.pendingAssistantFinals?.unauthorized, undefined);
	assert.deepEqual(env.state.completedTurnIds, ["unauthorized"]);
	assert.match(env.terminalFailures[0] ?? "", /unauthorized/i);
}

await checkOrdinaryFinalOnlyDeliveryDoesNotTouchPreviewState();
await checkAssistantFinalAcceptsWithoutLiveSessionOrRoute();
await checkDuplicateAssistantFinalHandoff();
await checkChunkResumeSkipsSentChunks();
await checkAttachmentRetryDoesNotResendText();
await checkDurablePreviewMessageIsReplacedAfterRestart();
await checkLegacyPreviewEditedFirstChunkIsResentFreshAfterCleanup();
await checkLegacyPreviewEditedFinalResendsAlreadySentChunksInOrder();
await checkLegacyPreviewEditedFirstChunkSurvivesStopAfterCleanup();
await checkOfflineSessionFinalCompletionQueuesRouteCleanup();
await checkOfflineSessionFinalCompletionAlsoCleansPendingTurnPreviewState();
await checkOfflineSessionFinalCompletionPreservesPreviewRefWhenDeleteRetryableFails();
await checkBrokerStopPreventsFurtherDelivery();
await checkClearPreviewRetryAfterStaysPending();
await checkDeletePreviewRetryAfterStopsReplacementSend();
await checkDeletePreviewTransportFailureStopsReplacementSend();
await checkDeletePreviewMissingStillSendsReplacementFinal();
await checkPermanentDeletePreviewErrorAppendsFreshFinal();
await checkDetachedSessionFinalIsQueuedWithoutLiveSession();
await checkDisconnectCancelsInFlightFinalDelivery();
await checkRetryAfterBlocksNewerFinals();
await checkErrorFinalWithTextPrefersText();
await checkErrorOnlyFinalUsesClearFailureText();
await checkErrorOnlyFinalAppendsAfterPermanentPreviewCleanupFailure();
await checkAttachmentOnlyFinalAppendsNoticeAfterPermanentPreviewCleanupFailure();
await checkTransportFetchFailedStaysPending();
await checkUnauthorizedTelegramFailureGoesTerminal();
console.log("Final delivery ledger checks passed");
