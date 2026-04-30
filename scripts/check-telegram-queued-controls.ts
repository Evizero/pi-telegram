import assert from "node:assert/strict";

import { TelegramApiError } from "../src/telegram/api.js";
import { routeTopicDeleteJobId } from "../src/broker/telegram-outbox.js";
import type { QueuedTurnControlState } from "../src/broker/types.js";
import type { PendingTelegramTurn } from "../src/client/types.js";
import { callbackQuery, createRouter, message, queuedControlCallbackDataByText, state } from "./support/telegram-command-fixtures.js";
import type { IpcCall, TelegramCall } from "./support/telegram-command-fixtures.js";

async function checkQueuedStatusRetryAfterRetriesWithoutRedeliveryDuplicate(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let failQueuedStatus = true;
	const sendText = async (_chatId: number | string, _threadId: number | undefined, text: string, options?: { disableNotification?: boolean; replyMarkup?: unknown }): Promise<number | undefined> => {
		sentReplies.push(text);
		if (text === "Queued as follow-up." && failQueuedStatus) {
			failQueuedStatus = false;
			throw new TelegramApiError("sendMessage", "Too Many Requests", 429, 2);
		}
		if (options?.replyMarkup) telegramCalls.push({ method: "sendMessageReplyMarkup", body: { reply_markup: options.replyMarkup } });
		return 99;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, undefined, sendText, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await assert.rejects(() => router.dispatch([message("queue retry", 44)]), /Too Many Requests/);
	await router.dispatch([message("queue retry", 44)]);

	assert.equal(ipcCalls.filter((call) => call.type === "deliver_turn").length, 1);
	assert.equal(sentReplies.filter((text) => text === "Queued as follow-up.").length, 2);
	assert.equal(telegramCalls.filter((call) => call.method === "sendMessageReplyMarkup").length, 1);
	assert.equal(Object.values(brokerState.queuedTurnControls ?? {})[0]?.statusMessageId, 99);
}

async function checkQueuedFollowUpSteerControlConvertsOnce(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let turnCounter = 0;
	const postIpc = async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string): Promise<TResponse> => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		if (type === "convert_queued_turn_to_steer") return { status: "converted", text: "Steered queued follow-up into the active turn.", turnId: (payload as { turnId: string }).turnId } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => ++turnCounter, undefined, undefined, postIpc);

	await router.dispatch([message("queue this", 41)]);

	const turn = ipcCalls.find((call) => call.type === "deliver_turn")!.payload as PendingTelegramTurn;
	assert.equal(brokerState.pendingTurns?.[turn.turnId]?.turn.turnId, turn.turnId);
	assert.equal(sentReplies.at(-1), "Queued as follow-up.");
	const callbackData = queuedControlCallbackDataByText(telegramCalls, "Steer now");
	const control = Object.values(brokerState.queuedTurnControls ?? {})[0]!;
	assert.equal(control.turnId, turn.turnId);
	assert.equal(control.targetActiveTurnId, "active-1");
	delete control.routeId;

	await router.dispatchCallback(callbackQuery(callbackData));
	await router.dispatchCallback(callbackQuery(callbackData));

	assert.equal(ipcCalls.filter((call) => call.type === "convert_queued_turn_to_steer").length, 1);
	assert.equal(brokerState.pendingTurns?.[turn.turnId], undefined);
	assert.equal(brokerState.completedTurnIds?.includes(turn.turnId), true);
	assert.equal(Object.values(brokerState.queuedTurnControls ?? {})[0]?.status, "converted");
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.text === "Steered queued follow-up into the active turn."), true);
	assert.equal(telegramCalls.filter((call) => call.method === "answerCallbackQuery").length, 2);
}

async function checkQueuedFollowUpControlFinalizesWhenTurnStartsNormally(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, undefined, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		if (type === "convert_queued_turn_to_steer") return { status: "converted", text: "should not happen", turnId: (payload as { turnId: string }).turnId } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("queued then starts", 47)]);
	const steerData = queuedControlCallbackDataByText(telegramCalls, "Steer now");
	const control = Object.values(brokerState.queuedTurnControls ?? {})[0]!;

	await router.finalizeQueuedTurnControls([control.turnId], "Queued follow-up has started.");
	await router.dispatchCallback(callbackQuery(steerData));

	assert.equal(control.status, "expired");
	assert.equal(control.completedText, "Queued follow-up has started.");
	assert.equal(typeof control.statusMessageFinalizedAtMs, "number");
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.text === "Queued follow-up has started." && call.body.reply_markup === undefined), true);
	assert.equal(ipcCalls.filter((call) => call.type === "convert_queued_turn_to_steer").length, 0);
	assert.equal(telegramCalls.some((call) => call.method === "answerCallbackQuery" && call.body.text === "This queued follow-up is no longer waiting."), true);
}

async function checkQueuedControlOutboxDrainDoesNotDeleteRouteTopics(): Promise<void> {
	const brokerState = state();
	const route = brokerState.routes["123:9"]!;
	brokerState.routes = {};
	brokerState.pendingRouteCleanups = { [route.routeId]: { route, createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000 } };
	brokerState.telegramOutbox = {
		[routeTopicDeleteJobId(route.routeId)]: {
			id: routeTopicDeleteJobId(route.routeId),
			kind: "route_topic_delete",
			status: "pending",
			cleanupId: route.routeId,
			route,
			createdAtMs: Date.now() - 10_000,
			updatedAtMs: Date.now() - 10_000,
			attempts: 0,
		},
	};
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, async <TResponse>(method: string, body: Record<string, unknown>) => {
		telegramCalls.push({ method, body });
		return true as TResponse;
	});

	await router.retryQueuedTurnControlFinalizations();

	assert.deepEqual(telegramCalls.filter((call) => call.method === "deleteForumTopic"), []);
	assert.equal(brokerState.pendingRouteCleanups[route.routeId] !== undefined, true);
	assert.equal(brokerState.telegramOutbox[routeTopicDeleteJobId(route.routeId)]?.status, "pending");
}

async function checkQueuedControlRetryAfterDoesNotBlockCommands(): Promise<void> {
	const brokerState = state();
	const control: QueuedTurnControlState = {
		token: "retry-block-token",
		turnId: "retry-block-turn",
		sessionId: "session-1",
		routeId: "123:9",
		chatId: 123,
		messageThreadId: 9,
		statusMessageId: 98,
		status: "expired",
		completedText: "Queued follow-up is no longer waiting.",
		createdAtMs: 1,
		updatedAtMs: 1,
		expiresAtMs: Date.now() + 60_000,
		statusMessageRetryAtMs: 0,
	};
	const secondControl: QueuedTurnControlState = {
		token: "retry-block-token-2",
		turnId: "retry-block-turn-2",
		sessionId: "session-1",
		routeId: "123:9",
		chatId: 123,
		messageThreadId: 9,
		statusMessageId: 97,
		status: "expired",
		completedText: "Queued follow-up is no longer waiting.",
		createdAtMs: 1,
		updatedAtMs: 1,
		expiresAtMs: Date.now() + 60_000,
		statusMessageRetryAtMs: 0,
	};
	brokerState.queuedTurnControls = { [control.token]: control, [secondControl.token]: secondControl };
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const callTelegram = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "editMessageText") throw new TelegramApiError("editMessageText", "Too Many Requests", 429, 2);
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, callTelegram, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "query_status") return { text: "busy" } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("/status", 63)]);

	assert.equal(telegramCalls.filter((call) => call.method === "editMessageText").length, 1);
	assert.equal(sentReplies.includes("busy"), true);
	assert.equal(control.statusMessageFinalizedAtMs, undefined);
	assert.equal(secondControl.statusMessageFinalizedAtMs, undefined);
	assert.ok((control.statusMessageRetryAtMs ?? 0) > Date.now());
	assert.ok((brokerState.queuedTurnControlCleanupRetryAtMs ?? 0) > Date.now());

	await router.dispatch([message("/status", 64)]);
	assert.equal(telegramCalls.filter((call) => call.method === "editMessageText").length, 1);
	assert.equal(secondControl.statusMessageFinalizedAtMs, undefined);
}

async function checkTransientQueuedControlCleanupDoesNotBlockRemainingSweep(): Promise<void> {
	const brokerState = state();
	const firstControl: QueuedTurnControlState = {
		token: "transient-first",
		turnId: "transient-first-turn",
		sessionId: "session-1",
		routeId: "123:9",
		chatId: 123,
		messageThreadId: 9,
		statusMessageId: 81,
		status: "expired",
		completedText: "Queued follow-up is no longer waiting.",
		createdAtMs: 1,
		updatedAtMs: 1,
		expiresAtMs: Date.now() + 60_000,
	};
	const secondControl: QueuedTurnControlState = {
		token: "transient-second",
		turnId: "transient-second-turn",
		sessionId: "session-1",
		routeId: "123:9",
		chatId: 123,
		messageThreadId: 9,
		statusMessageId: 82,
		status: "expired",
		completedText: "Queued follow-up is no longer waiting.",
		createdAtMs: 1,
		updatedAtMs: 1,
		expiresAtMs: Date.now() + 60_000,
	};
	brokerState.queuedTurnControls = { [firstControl.token]: firstControl, [secondControl.token]: secondControl };
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const callTelegram = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "editMessageText" && body.message_id === 81) throw new TelegramApiError("editMessageText", "Internal Server Error", 500, undefined);
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, callTelegram);

	await router.retryQueuedTurnControlFinalizations();

	assert.equal(telegramCalls.filter((call) => call.method === "editMessageText").length, 2);
	assert.equal(firstControl.statusMessageFinalizedAtMs, undefined);
	assert.equal(typeof secondControl.statusMessageFinalizedAtMs, "number");
	assert.ok((brokerState.queuedTurnControlCleanupRetryAtMs ?? 0) > Date.now());
}

async function checkQueuedControlCleanupRetryAfterIsRetried(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let failCleanupEdit = true;
	const callTelegram = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "editMessageText" && body.text === "Queued follow-up has started." && failCleanupEdit) {
			failCleanupEdit = false;
			throw new TelegramApiError("editMessageText", "Too Many Requests", 429, 2);
		}
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, callTelegram, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		if (type === "query_status") return { text: "busy" } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("queued cleanup retry", 48)]);
	const control = Object.values(brokerState.queuedTurnControls ?? {})[0]!;

	await router.finalizeQueuedTurnControls([control.turnId], "Queued follow-up has started.");
	assert.equal(control.status, "expired");
	assert.equal(control.completedText, "Queued follow-up has started.");
	assert.equal(control.statusMessageFinalizedAtMs, undefined);
	assert.ok((brokerState.queuedTurnControlCleanupRetryAtMs ?? 0) > Date.now());
	await router.finalizeQueuedTurnControls([control.turnId], "Queued follow-up has started.");
	assert.equal(telegramCalls.filter((call) => call.method === "editMessageText" && call.body.text === "Queued follow-up has started.").length, 1);
	control.statusMessageRetryAtMs = 0;
	brokerState.queuedTurnControlCleanupRetryAtMs = 0;
	brokerState.telegramOutboxRetryAtMs = 0;

	await router.dispatch([message("/status", 49)]);

	assert.equal(telegramCalls.filter((call) => call.method === "editMessageText" && call.body.text === "Queued follow-up has started.").length, 2);
	assert.equal(typeof control.statusMessageFinalizedAtMs, "number");
	assert.equal(ipcCalls.filter((call) => call.type === "deliver_turn").length, 1);
}

async function checkQueuedControlCleanupTransientEditFailureIsRetried(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let failCleanupEdit = true;
	const callTelegram = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "editMessageText" && body.text === "Queued follow-up has started." && failCleanupEdit) {
			failCleanupEdit = false;
			throw new TelegramApiError("editMessageText", "Internal Server Error", 500, undefined);
		}
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, callTelegram, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		if (type === "query_status") return { text: "busy" } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("queued cleanup transient", 61)]);
	const control = Object.values(brokerState.queuedTurnControls ?? {})[0]!;

	await router.finalizeQueuedTurnControls([control.turnId], "Queued follow-up has started.");
	assert.equal(control.status, "expired");
	assert.equal(control.completedText, "Queued follow-up has started.");
	assert.equal(control.statusMessageFinalizedAtMs, undefined);
	assert.ok((control.statusMessageRetryAtMs ?? 0) > Date.now());
	control.statusMessageRetryAtMs = 0;
	brokerState.queuedTurnControlCleanupRetryAtMs = 0;
	brokerState.telegramOutboxRetryAtMs = 0;

	await router.dispatch([message("/status", 62)]);

	assert.equal(telegramCalls.filter((call) => call.method === "editMessageText" && call.body.text === "Queued follow-up has started.").length, 2);
	assert.equal(typeof control.statusMessageFinalizedAtMs, "number");
}

async function checkLegacyExpiredControlFinalizesVisibleButtons(): Promise<void> {
	const brokerState = state();
	const control: QueuedTurnControlState = {
		token: "legacy-expired-token",
		turnId: "legacy-expired-turn",
		sessionId: "session-1",
		routeId: "123:9",
		chatId: 123,
		messageThreadId: 9,
		statusMessageId: 99,
		status: "expired",
		createdAtMs: 1,
		updatedAtMs: 1,
		expiresAtMs: 1,
	};
	brokerState.queuedTurnControls = { [control.token]: control };
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls);

	await router.dispatch([message("/status", 58)]);

	assert.equal(control.status, "expired");
	assert.equal(control.completedText, "Queued follow-up is no longer waiting.");
	assert.equal(typeof control.statusMessageFinalizedAtMs, "number");
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.text === "Queued follow-up is no longer waiting."), true);
}

async function checkQueuedControlExpiryFinalizesVisibleButtons(): Promise<void> {
	const brokerState = state();
	const control: QueuedTurnControlState = {
		token: "expired-token",
		turnId: "expired-turn",
		sessionId: "session-1",
		routeId: "123:9",
		chatId: 123,
		messageThreadId: 9,
		statusMessageId: 99,
		targetActiveTurnId: "active-1",
		status: "offered",
		createdAtMs: 1,
		updatedAtMs: 1,
		expiresAtMs: 1,
	};
	brokerState.queuedTurnControls = { [control.token]: control };
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls);

	await router.dispatch([message("/status", 50)]);

	assert.equal(control.status, "expired");
	assert.equal(control.completedText, "Queued follow-up is no longer waiting.");
	assert.equal(typeof control.statusMessageFinalizedAtMs, "number");
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.text === "Queued follow-up is no longer waiting." && call.body.reply_markup === undefined), true);
}

async function checkMissingPendingTurnFinalizesVisibleQueuedControl(): Promise<void> {
	const brokerState = state();
	const control: QueuedTurnControlState = {
		token: "missing-pending-token",
		turnId: "missing-pending-turn",
		sessionId: "session-1",
		routeId: "123:9",
		chatId: 123,
		messageThreadId: 9,
		statusMessageId: 99,
		targetActiveTurnId: "active-1",
		status: "offered",
		createdAtMs: 1,
		updatedAtMs: 1,
		expiresAtMs: Date.now() + 60_000,
	};
	brokerState.queuedTurnControls = { [control.token]: control };
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls);

	await router.dispatch([message("/status", 53)]);

	assert.equal(control.status, "expired");
	assert.equal(control.completedText, "Queued follow-up is no longer waiting.");
	assert.equal(typeof control.statusMessageFinalizedAtMs, "number");
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.text === "Queued follow-up is no longer waiting."), true);
}

async function checkStopFinalizesInProgressQueuedControls(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let queuedTurnId = "";
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, undefined, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
		ipcCalls.push({ type, payload });
		if (type === "deliver_turn") {
			queuedTurnId = (payload as PendingTelegramTurn).turnId;
			return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		}
		if (type === "abort_turn") return { text: "Suppressed 1 queued turn(s).", clearedTurnIds: [queuedTurnId] } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("queued then stop in progress", 59)]);
	const control = Object.values(brokerState.queuedTurnControls ?? {})[0]!;
	control.status = "cancelling";
	await router.dispatch([message("/stop", 60)]);

	assert.equal(control.status, "expired");
	assert.equal(control.completedText, "Queued follow-up was cleared.");
	assert.equal(typeof control.statusMessageFinalizedAtMs, "number");
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.text === "Queued follow-up was cleared."), true);
}

async function checkStopCleanupRetryAfterDoesNotReplayAbort(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let queuedTurnId = "";
	let failCleanupEdit = true;
	const callTelegram = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "editMessageText" && body.text === "Queued follow-up was cleared." && failCleanupEdit) {
			failCleanupEdit = false;
			throw new TelegramApiError("editMessageText", "Too Many Requests", 429, 2);
		}
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, callTelegram, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") {
			queuedTurnId = (payload as PendingTelegramTurn).turnId;
			return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		}
		if (type === "abort_turn") return { text: "Suppressed 1 queued turn(s).", clearedTurnIds: [queuedTurnId] } as TResponse;
		if (type === "query_status") return { text: "busy" } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("queued then stop retry", 54)]);
	await router.dispatch([message("/stop", 55)]);
	const control = Object.values(brokerState.queuedTurnControls ?? {})[0]!;
	assert.equal(control.status, "expired");
	assert.equal(control.completedText, "Queued follow-up was cleared.");
	assert.equal(control.statusMessageFinalizedAtMs, undefined);
	assert.equal(ipcCalls.filter((call) => call.type === "abort_turn").length, 1);
	control.statusMessageRetryAtMs = 0;
	brokerState.queuedTurnControlCleanupRetryAtMs = 0;
	brokerState.telegramOutboxRetryAtMs = 0;

	await router.dispatch([message("/status", 56)]);

	assert.equal(telegramCalls.filter((call) => call.method === "editMessageText" && call.body.text === "Queued follow-up was cleared.").length, 2);
	assert.equal(ipcCalls.filter((call) => call.type === "abort_turn").length, 1);
	assert.equal(typeof control.statusMessageFinalizedAtMs, "number");
}

async function checkMissingPendingInProgressControlFinalizesVisibleButtons(): Promise<void> {
	const brokerState = state();
	const control: QueuedTurnControlState = {
		token: "missing-cancelling-token",
		turnId: "missing-cancelling-turn",
		sessionId: "session-1",
		routeId: "123:9",
		chatId: 123,
		messageThreadId: 9,
		statusMessageId: 99,
		status: "cancelling",
		createdAtMs: 1,
		updatedAtMs: 1,
		expiresAtMs: Date.now() + 60_000,
	};
	brokerState.queuedTurnControls = { [control.token]: control };
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls);

	await router.dispatch([message("/status", 57)]);

	assert.equal(control.status, "cancelled");
	assert.equal(control.completedText, "Cancelled queued follow-up.");
	assert.equal(typeof control.statusMessageFinalizedAtMs, "number");
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.text === "Cancelled queued follow-up."), true);
}

async function checkStopFinalizesClearedQueuedControls(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let queuedTurnId = "";
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, undefined, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") {
			queuedTurnId = (payload as PendingTelegramTurn).turnId;
			return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		}
		if (type === "abort_turn") return { text: "Suppressed 1 queued turn(s).", clearedTurnIds: [queuedTurnId] } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("queued then stop", 51)]);
	await router.dispatch([message("/stop", 52)]);

	const control = Object.values(brokerState.queuedTurnControls ?? {})[0]!;
	assert.equal(control.status, "expired");
	assert.equal(control.completedText, "Queued follow-up was cleared.");
	assert.equal(typeof control.statusMessageFinalizedAtMs, "number");
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.text === "Queued follow-up was cleared." && call.body.reply_markup === undefined), true);
	assert.equal(sentReplies.at(-1), "Suppressed 1 queued turn(s).");
}

async function checkQueuedFollowUpCancelControlCancelsOnce(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let turnCounter = 0;
	const postIpc = async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string): Promise<TResponse> => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		if (type === "cancel_queued_turn") return { status: "cancelled", text: "Cancelled queued follow-up.", turnId: (payload as { turnId: string }).turnId } as TResponse;
		if (type === "convert_queued_turn_to_steer") return { status: "converted", text: "should not steer", turnId: (payload as { turnId: string }).turnId } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => ++turnCounter, undefined, undefined, postIpc);

	await router.dispatch([message("cancel this", 48)]);

	const turn = ipcCalls.find((call) => call.type === "deliver_turn")!.payload as PendingTelegramTurn;
	const cancelData = queuedControlCallbackDataByText(telegramCalls, "Cancel");
	const steerData = queuedControlCallbackDataByText(telegramCalls, "Steer now");

	await router.dispatchCallback(callbackQuery(cancelData));
	await router.dispatchCallback(callbackQuery(cancelData));
	await router.dispatchCallback(callbackQuery(steerData));

	assert.equal(ipcCalls.filter((call) => call.type === "cancel_queued_turn").length, 1);
	assert.equal(ipcCalls.filter((call) => call.type === "convert_queued_turn_to_steer").length, 0);
	assert.equal(brokerState.pendingTurns?.[turn.turnId], undefined);
	assert.equal(brokerState.completedTurnIds?.includes(turn.turnId), true);
	assert.equal(Object.values(brokerState.queuedTurnControls ?? {})[0]?.status, "cancelled");
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.text === "Cancelled queued follow-up."), true);
	assert.equal(telegramCalls.filter((call) => call.method === "answerCallbackQuery").length, 3);
}

async function checkCancelledCallbackAnswerRetryAfterIsRetried(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let failCancelledAnswer = true;
	const callTelegram = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "answerCallbackQuery" && body.text === "Cancelled queued follow-up." && failCancelledAnswer) {
			failCancelledAnswer = false;
			throw new TelegramApiError("answerCallbackQuery", "Too Many Requests", 429, 2);
		}
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, callTelegram, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		if (type === "cancel_queued_turn") return { status: "cancelled", text: "Cancelled queued follow-up.", turnId: (payload as { turnId: string }).turnId } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("cancel answer retry", 52)]);
	const cancelData = queuedControlCallbackDataByText(telegramCalls, "Cancel");

	await assert.rejects(() => router.dispatchCallback(callbackQuery(cancelData)), /Too Many Requests/);
	await router.dispatchCallback(callbackQuery(cancelData));

	assert.equal(ipcCalls.filter((call) => call.type === "cancel_queued_turn").length, 1);
	assert.equal(telegramCalls.filter((call) => call.method === "answerCallbackQuery").length, 2);
	assert.equal(telegramCalls.some((call) => call.method === "answerCallbackQuery" && call.body.text === "Queued follow-up already cancelled."), true);
	assert.equal(Object.values(brokerState.queuedTurnControls ?? {})[0]?.status, "cancelled");
}

async function checkCancelledControlEditRetryAfterIsRetried(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let failCancelledEdit = true;
	const callTelegram = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "editMessageText" && body.text === "Cancelled queued follow-up." && failCancelledEdit) {
			failCancelledEdit = false;
			throw new TelegramApiError("editMessageText", "Too Many Requests", 429, 2);
		}
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, callTelegram, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		if (type === "cancel_queued_turn") return { status: "cancelled", text: "Cancelled queued follow-up.", turnId: (payload as { turnId: string }).turnId } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("cancel edit retry", 49)]);
	const cancelData = queuedControlCallbackDataByText(telegramCalls, "Cancel");

	await router.dispatchCallback(callbackQuery(cancelData));
	Object.values(brokerState.queuedTurnControls ?? {})[0]!.statusMessageRetryAtMs = 0;
	brokerState.queuedTurnControlCleanupRetryAtMs = 0;
	brokerState.telegramOutboxRetryAtMs = 0;
	await router.dispatchCallback(callbackQuery(cancelData));

	assert.equal(ipcCalls.filter((call) => call.type === "cancel_queued_turn").length, 1);
	assert.equal(telegramCalls.filter((call) => call.method === "editMessageText" && call.body.text === "Cancelled queued follow-up.").length, 2);
	assert.equal(Object.values(brokerState.queuedTurnControls ?? {})[0]?.status, "cancelled");
}

async function checkCancellingControlRecoversAcrossBrokerFailover(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, undefined, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		if (type === "cancel_queued_turn") return { status: "already_handled", text: "This queued follow-up was already handled.", turnId: (payload as { turnId: string }).turnId } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("queue cancelling", 50)]);
	const cancelData = queuedControlCallbackDataByText(telegramCalls, "Cancel");
	const control = Object.values(brokerState.queuedTurnControls ?? {})[0]!;
	control.status = "cancelling";
	control.updatedAtMs = Date.now() - 1000;

	await router.dispatchCallback(callbackQuery(cancelData));

	assert.equal(ipcCalls.filter((call) => call.type === "cancel_queued_turn").length, 1);
	assert.equal(control.status, "cancelled");
	assert.equal(control.completedText, "Cancelled queued follow-up.");
	assert.equal(brokerState.pendingTurns?.[control.turnId], undefined);
	assert.equal(brokerState.completedTurnIds?.includes(control.turnId), true);
}

async function checkCancelCallbackRejectsOfflineAndWrongRoute(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, undefined, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		if (type === "cancel_queued_turn") return { status: "cancelled", text: "should not happen", turnId: (payload as { turnId: string }).turnId } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("cancel wrong route", 51)]);
	const cancelData = queuedControlCallbackDataByText(telegramCalls, "Cancel");

	await router.dispatchCallback({ ...callbackQuery(cancelData), message: message("button moved", 100) });
	const route = brokerState.routes["123:9"]!;
	delete brokerState.routes["123:9"];
	await router.dispatchCallback(callbackQuery(cancelData));
	brokerState.routes["123:9"] = route;
	brokerState.sessions["session-1"]!.status = "offline";
	await router.dispatchCallback(callbackQuery(cancelData));

	assert.equal(ipcCalls.filter((call) => call.type === "cancel_queued_turn").length, 0);
	assert.equal(telegramCalls.filter((call) => call.method === "answerCallbackQuery" && call.body.show_alert === true).length, 3);
}

async function checkConvertedSteerControlEditRetryAfterIsRetried(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let failConvertedEdit = true;
	const callTelegram = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "editMessageText" && body.text === "Steered queued follow-up into the active turn." && failConvertedEdit) {
			failConvertedEdit = false;
			throw new TelegramApiError("editMessageText", "Too Many Requests", 429, 2);
		}
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, callTelegram, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		if (type === "convert_queued_turn_to_steer") return { status: "converted", text: "Steered queued follow-up into the active turn.", turnId: (payload as { turnId: string }).turnId } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("queue edit retry", 43)]);
	const callbackData = queuedControlCallbackDataByText(telegramCalls, "Steer now");

	await router.dispatchCallback(callbackQuery(callbackData));
	Object.values(brokerState.queuedTurnControls ?? {})[0]!.statusMessageRetryAtMs = 0;
	brokerState.queuedTurnControlCleanupRetryAtMs = 0;
	brokerState.telegramOutboxRetryAtMs = 0;
	await router.dispatchCallback(callbackQuery(callbackData));

	assert.equal(ipcCalls.filter((call) => call.type === "convert_queued_turn_to_steer").length, 1);
	assert.equal(telegramCalls.filter((call) => call.method === "editMessageText" && call.body.text === "Steered queued follow-up into the active turn.").length, 2);
	assert.equal(Object.values(brokerState.queuedTurnControls ?? {})[0]?.status, "converted");
}

async function checkQueuedSteerCallbackRejectsOfflineAndWrongRoute(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, undefined, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		if (type === "convert_queued_turn_to_steer") return { status: "converted", text: "should not happen", turnId: (payload as { turnId: string }).turnId } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("queue wrong route", 45)]);
	const callbackData = queuedControlCallbackDataByText(telegramCalls, "Steer now");

	await router.dispatchCallback({ ...callbackQuery(callbackData), message: message("button moved", 100) });
	const route = brokerState.routes["123:9"]!;
	delete brokerState.routes["123:9"];
	await router.dispatchCallback(callbackQuery(callbackData));
	brokerState.routes["123:9"] = route;
	brokerState.sessions["session-1"]!.status = "offline";
	await router.dispatchCallback(callbackQuery(callbackData));

	assert.equal(ipcCalls.filter((call) => call.type === "convert_queued_turn_to_steer").length, 0);
	assert.equal(telegramCalls.filter((call) => call.method === "answerCallbackQuery" && call.body.show_alert === true).length, 3);
}

async function checkConvertingSteerControlRecoversAcrossBrokerFailover(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, undefined, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		if (type === "convert_queued_turn_to_steer") return { status: "already_handled", text: "This queued follow-up was already handled.", turnId: (payload as { turnId: string }).turnId } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("queue converting", 46)]);
	const callbackData = queuedControlCallbackDataByText(telegramCalls, "Steer now");
	const control = Object.values(brokerState.queuedTurnControls ?? {})[0]!;
	control.status = "converting";
	control.updatedAtMs = Date.now() - 1000;

	await router.dispatchCallback(callbackQuery(callbackData));

	assert.equal(ipcCalls.filter((call) => call.type === "convert_queued_turn_to_steer").length, 1);
	assert.equal(control.status, "converted");
	assert.equal(control.completedText, "Steered queued follow-up into the active turn.");
	assert.equal(brokerState.pendingTurns?.[control.turnId], undefined);
	assert.equal(brokerState.completedTurnIds?.includes(control.turnId), true);
}

async function checkConvertingSteerControlWithMissingPendingCompletesIdempotently(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, undefined, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("queue consumed converting", 47)]);
	const callbackData = queuedControlCallbackDataByText(telegramCalls, "Steer now");
	const control = Object.values(brokerState.queuedTurnControls ?? {})[0]!;
	control.status = "converting";
	control.expiresAtMs = Date.now() - 1;
	delete brokerState.pendingTurns?.[control.turnId];
	brokerState.queuedTurnControlCleanupRetryAtMs = Date.now() + 60_000;

	await router.dispatchCallback(callbackQuery(callbackData));

	assert.equal(ipcCalls.filter((call) => call.type === "convert_queued_turn_to_steer").length, 0);
	assert.equal(control.status, "converted");
	assert.equal(control.completedText, "Steered queued follow-up into the active turn.");
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.text === "Queued follow-up is no longer waiting."), false);
	assert.equal(telegramCalls.some((call) => call.method === "answerCallbackQuery" && call.body.text === "Queued follow-up already steered."), true);

	brokerState.queuedTurnControlCleanupRetryAtMs = 0;
	await router.retryQueuedTurnControlFinalizations();
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.text === "Steered queued follow-up into the active turn."), true);
}

async function checkConsumedInFlightControlUsesAuthoritativeTerminalText(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, undefined, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("queue consumed in flight", 43)]);
	const control = Object.values(brokerState.queuedTurnControls ?? {})[0]!;
	control.status = "cancelling";

	router.markQueuedTurnControlsConsumed([control.turnId], "Cancelled queued follow-up.");
	await router.retryQueuedTurnControlFinalizations();

	assert.equal(control.status, "cancelled");
	assert.equal(control.completedText, "Cancelled queued follow-up.");
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.text === "Queued follow-up is no longer waiting."), false);
	assert.equal(telegramCalls.filter((call) => call.method === "editMessageText" && call.body.text === "Cancelled queued follow-up.").length, 1);

	const convertingControl: QueuedTurnControlState = {
		token: "converting-default-text",
		turnId: "turn-default-text",
		sessionId: "session-1",
		routeId: "123:9",
		chatId: 123,
		messageThreadId: 9,
		statusMessageId: 100,
		targetActiveTurnId: "active-1",
		status: "converting",
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
		expiresAtMs: Date.now() + 60_000,
	};
	brokerState.queuedTurnControls![convertingControl.token] = convertingControl;

	router.markQueuedTurnControlsConsumed([convertingControl.turnId]);
	await router.retryQueuedTurnControlFinalizations();

	assert.equal(convertingControl.status, "converted");
	assert.equal(convertingControl.completedText, "Steered queued follow-up into the active turn.");
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.message_id === 100 && call.body.text === "Queued follow-up is no longer waiting."), false);
	assert.equal(telegramCalls.filter((call) => call.method === "editMessageText" && call.body.message_id === 100 && call.body.text === "Steered queued follow-up into the active turn.").length, 1);
}

async function checkStaleQueuedFollowUpControlDoesNotConvert(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, undefined, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "deliver_turn") return { accepted: true, disposition: "queued", queuedControl: { canSteer: true, targetActiveTurnId: "active-1" } } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("queue stale", 42)]);
	const turn = ipcCalls.find((call) => call.type === "deliver_turn")!.payload as PendingTelegramTurn;
	delete brokerState.pendingTurns?.[turn.turnId];
	const callbackData = queuedControlCallbackDataByText(telegramCalls, "Steer now");

	await router.dispatchCallback(callbackQuery(callbackData));

	assert.equal(ipcCalls.filter((call) => call.type === "convert_queued_turn_to_steer").length, 0);
	assert.equal(Object.values(brokerState.queuedTurnControls ?? {})[0]?.status, "expired");
	assert.equal(telegramCalls.some((call) => call.method === "answerCallbackQuery" && call.body.show_alert === true), true);
}

await checkQueuedControlOutboxDrainDoesNotDeleteRouteTopics();
await checkQueuedStatusRetryAfterRetriesWithoutRedeliveryDuplicate();
await checkQueuedFollowUpSteerControlConvertsOnce();
await checkQueuedFollowUpControlFinalizesWhenTurnStartsNormally();
await checkQueuedControlRetryAfterDoesNotBlockCommands();
await checkTransientQueuedControlCleanupDoesNotBlockRemainingSweep();
await checkQueuedControlCleanupRetryAfterIsRetried();
await checkQueuedControlCleanupTransientEditFailureIsRetried();
await checkLegacyExpiredControlFinalizesVisibleButtons();
await checkQueuedControlExpiryFinalizesVisibleButtons();
await checkMissingPendingTurnFinalizesVisibleQueuedControl();
await checkStopFinalizesInProgressQueuedControls();
await checkStopCleanupRetryAfterDoesNotReplayAbort();
await checkMissingPendingInProgressControlFinalizesVisibleButtons();
await checkStopFinalizesClearedQueuedControls();
await checkQueuedFollowUpCancelControlCancelsOnce();
await checkCancelledCallbackAnswerRetryAfterIsRetried();
await checkCancelledControlEditRetryAfterIsRetried();
await checkCancellingControlRecoversAcrossBrokerFailover();
await checkCancelCallbackRejectsOfflineAndWrongRoute();
await checkConvertedSteerControlEditRetryAfterIsRetried();
await checkQueuedSteerCallbackRejectsOfflineAndWrongRoute();
await checkConvertingSteerControlRecoversAcrossBrokerFailover();
await checkConvertingSteerControlWithMissingPendingCompletesIdempotently();
await checkConsumedInFlightControlUsesAuthoritativeTerminalText();
await checkStaleQueuedFollowUpControlDoesNotConvert();
console.log("Telegram queued control checks passed");
