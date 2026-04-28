import assert from "node:assert/strict";

import { TelegramCommandRouter } from "../src/broker/commands.js";
import { TelegramApiError } from "../src/telegram/api.js";
import type { BrokerState, PendingTelegramTurn, QueuedTurnControlState, SessionRegistration, TelegramCallbackQuery, TelegramMessage } from "../src/shared/types.js";

type IpcCall = { type: string; payload: unknown; target?: string };
type TelegramCall = { method: string; body: Record<string, unknown> };

function session(): SessionRegistration {
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

function state(): BrokerState {
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
		completedTurnIds: [],
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
	};
}

function message(text: string, messageId = Math.floor(Math.random() * 1000)): TelegramMessage {
	return {
		message_id: messageId,
		message_thread_id: 9,
		chat: { id: 123, type: "supergroup", is_forum: true },
		from: { id: 456, is_bot: false, first_name: "User" },
		text,
	};
}

async function checkCommandRoutingPreservesCompactStopFollowSteerAndPlainTurns(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	let turnCounter = 0;
	const router = createRouter(brokerState, ipcCalls, sentReplies, [], () => ++turnCounter);

	await router.dispatch([message("/compact")]);
	await router.dispatch([message("/stop")]);
	await router.dispatch([message("/follow after this")]);
	await router.dispatch([message("/steer steer now")]);
	await router.dispatch([message("plain follow-up by default")]);

	assert.deepEqual(ipcCalls.map((call) => call.type), ["compact_session", "abort_turn", "deliver_turn", "deliver_turn", "deliver_turn"]);
	assert.deepEqual(sentReplies, ["Compaction started.", "Aborted current turn."]);
	const followTurn = ipcCalls[2]!.payload as PendingTelegramTurn;
	const steerTurn = ipcCalls[3]!.payload as PendingTelegramTurn;
	const plainTurn = ipcCalls[4]!.payload as PendingTelegramTurn;
	assert.equal(followTurn.deliveryMode, "followUp");
	assert.equal(followTurn.content[0]?.type, "text");
	assert.equal(followTurn.historyText, "after this");
	assert.equal(steerTurn.deliveryMode, "steer");
	assert.equal(steerTurn.historyText, "steer now");
	assert.equal(plainTurn.deliveryMode, undefined);
	assert.equal(plainTurn.historyText, "plain follow-up by default");
	assert.equal(ipcCalls.every((call) => call.target === "session-1"), true);
}

function createRouter(
	brokerState: BrokerState,
	ipcCalls: IpcCall[],
	sentReplies: string[],
	telegramCalls: TelegramCall[],
	nextTurnCounter = () => 1,
	callTelegramOverride?: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>,
	sendTextOverride?: (chatId: number | string, threadId: number | undefined, text: string, options?: { disableNotification?: boolean; replyMarkup?: unknown }) => Promise<number | undefined>,
	postIpcOverride?: <TResponse>(socketPath: string, type: string, payload: unknown, targetSessionId?: string) => Promise<TResponse>,
): TelegramCommandRouter {
	return new TelegramCommandRouter({
		getBrokerState: () => brokerState,
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

function callbackQuery(data: string): TelegramCallbackQuery {
	return callbackQueryForMessage(data, message("/model", 99));
}

function callbackQueryForMessage(data: string, originMessage: TelegramMessage): TelegramCallbackQuery {
	return {
		id: `cb-${Math.random()}`,
		from: { id: 456, is_bot: false, first_name: "User" },
		message: originMessage,
		data,
	};
}

function queuedControlCallbackDataByText(telegramCalls: TelegramCall[], text: "Steer now" | "Cancel"): string {
	const keyboard = telegramCalls.find((call) => call.method === "sendMessageReplyMarkup")!.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
	const buttons = keyboard.inline_keyboard.flat();
	assert.deepEqual(buttons.map((button) => button.text), ["Steer now", "Cancel"]);
	return buttons.find((button) => button.text === text)!.callback_data;
}

function gitCallbackDataByText(telegramCalls: TelegramCall[], text: "Status" | "Diffstat"): string {
	const keyboard = telegramCalls.find((call) => call.method === "sendMessageReplyMarkup")!.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
	const buttons = keyboard.inline_keyboard.flat();
	assert.deepEqual(buttons.map((button) => button.text), ["Status", "Diffstat"]);
	return buttons.find((button) => button.text === text)!.callback_data;
}

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

async function checkTransientQueuedControlCleanupDefersRemainingSweep(): Promise<void> {
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

	assert.equal(telegramCalls.filter((call) => call.method === "editMessageText").length, 1);
	assert.equal(firstControl.statusMessageFinalizedAtMs, undefined);
	assert.equal(secondControl.statusMessageFinalizedAtMs, undefined);
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

	await assert.rejects(() => router.finalizeQueuedTurnControls([control.turnId], "Queued follow-up has started."), /Too Many Requests/);
	assert.equal(control.status, "expired");
	assert.equal(control.completedText, "Queued follow-up has started.");
	assert.equal(control.statusMessageFinalizedAtMs, undefined);
	assert.ok((brokerState.queuedTurnControlCleanupRetryAtMs ?? 0) > Date.now());
	await router.finalizeQueuedTurnControls([control.turnId], "Queued follow-up has started.");
	assert.equal(telegramCalls.filter((call) => call.method === "editMessageText" && call.body.text === "Queued follow-up has started.").length, 1);
	control.statusMessageRetryAtMs = 0;
	brokerState.queuedTurnControlCleanupRetryAtMs = 0;

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

	await assert.rejects(() => router.dispatchCallback(callbackQuery(cancelData)), /Too Many Requests/);
	Object.values(brokerState.queuedTurnControls ?? {})[0]!.statusMessageRetryAtMs = 0;
	brokerState.queuedTurnControlCleanupRetryAtMs = 0;
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

	await assert.rejects(() => router.dispatchCallback(callbackQuery(callbackData)), /Too Many Requests/);
	Object.values(brokerState.queuedTurnControls ?? {})[0]!.statusMessageRetryAtMs = 0;
	brokerState.queuedTurnControlCleanupRetryAtMs = 0;
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

async function checkGitCommandShowsInlineMenuWithoutAgentTurn(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls);

	await router.dispatch([message("/git")]);

	assert.deepEqual(ipcCalls, []);
	assert.equal(sentReplies[0], "Git repository tools\n\nChoose a read-only action:");
	assert.equal(telegramCalls[0]?.method, "sendMessageReplyMarkup");
	const control = Object.values(brokerState.gitControls ?? {})[0]!;
	assert.equal(control.sessionId, "session-1");
	assert.equal(control.chatId, 123);
	assert.equal(control.messageThreadId, 9);
	assert.equal(control.messageId, 99);
	gitCallbackDataByText(telegramCalls, "Status");
}

async function checkGitCallbacksQueryClientAndPreserveThread(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, undefined, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "query_git_repository") return { text: `Git ${(payload as { action: string }).action} result` } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("/git")]);
	const statusData = gitCallbackDataByText(telegramCalls, "Status");
	await router.dispatchCallback(callbackQuery(statusData));

	assert.deepEqual(ipcCalls, [{ type: "query_git_repository", payload: { action: "status" }, target: "session-1" }]);
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.chat_id === 123 && call.body.message_id === 99 && call.body.text === "Git status result"), true);
	assert.equal(telegramCalls.some((call) => call.method === "answerCallbackQuery" && call.body.text === "Git status ready."), true);
	assert.equal(Object.keys(brokerState.gitControls ?? {}).length, 0);

	await router.dispatch([message("/git")]);
	const diffstatData = gitCallbackDataByText(telegramCalls.slice(-1), "Diffstat");
	await router.dispatchCallback(callbackQuery(diffstatData));

	assert.equal(ipcCalls[1]?.type, "query_git_repository");
	assert.deepEqual(ipcCalls[1]?.payload, { action: "diffstat" });
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.text === "Git diffstat result"), true);
}

async function checkGitCallbackRejectsStaleOfflineAndWrongRoute(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls);

	await router.dispatch([message("/git")]);
	const statusData = gitCallbackDataByText(telegramCalls, "Status");
	brokerState.sessions["session-1"]!.status = "offline";
	await router.dispatchCallback(callbackQuery(statusData));

	assert.equal(ipcCalls.length, 0);
	assert.equal(telegramCalls.some((call) => call.method === "answerCallbackQuery" && call.body.show_alert === true && String(call.body.text).includes("no longer matches")), true);

	await router.dispatchCallback(callbackQuery("git1:missing:s"));
	assert.equal(telegramCalls.some((call) => call.method === "answerCallbackQuery" && call.body.text === "Git menu expired. Send /git again."), true);
}

async function checkGitSelectorCallbackRejectsOldSelection(): Promise<void> {
	const brokerState = state();
	const secondSession = { ...session(), sessionId: "session-2", clientSocketPath: "/tmp/client-2.sock", topicName: "other" };
	brokerState.sessions[secondSession.sessionId] = secondSession;
	brokerState.selectorSelections = { "123": { chatId: 123, sessionId: "session-1", expiresAtMs: Date.now() + 60_000, updatedAtMs: Date.now() } };
	brokerState.routes["123:session-1"] = { routeId: "123", sessionId: "session-1", chatId: 123, routeMode: "single_chat_selector", topicName: "project · main", createdAtMs: Date.now(), updatedAtMs: Date.now() };
	brokerState.routes["123:session-2"] = { routeId: "123", sessionId: "session-2", chatId: 123, routeMode: "single_chat_selector", topicName: "other", createdAtMs: Date.now(), updatedAtMs: Date.now() };
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls);
	const selectorMessage: TelegramMessage = { ...message("/git", 77), message_thread_id: undefined };

	await router.dispatch([selectorMessage]);
	const statusData = gitCallbackDataByText(telegramCalls, "Status");
	brokerState.selectorSelections["123"] = { chatId: 123, sessionId: "session-2", expiresAtMs: Date.now() + 60_000, updatedAtMs: Date.now() };
	await router.dispatchCallback(callbackQueryForMessage(statusData, { ...selectorMessage, message_id: 99 }));

	brokerState.selectorSelections["123"] = { chatId: 123, sessionId: "session-1", expiresAtMs: Date.now() + 120_000, updatedAtMs: Date.now() + 1 };
	await router.dispatchCallback(callbackQueryForMessage(statusData, { ...selectorMessage, message_id: 99 }));

	assert.equal(ipcCalls.length, 0);
	assert.equal(telegramCalls.some((call) => call.method === "answerCallbackQuery" && call.body.show_alert === true && String(call.body.text).includes("no longer matches")), true);
}

async function checkGitRetryAfterPropagatesWithoutClientQueryReplay(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let failAnswer = true;
	const callTelegram = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "answerCallbackQuery" && body.text === "Git status ready." && failAnswer) {
			failAnswer = false;
			throw new TelegramApiError("answerCallbackQuery", "Too Many Requests", 429, 2);
		}
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, callTelegram, undefined, async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
		ipcCalls.push({ type, payload, target: targetSessionId });
		if (type === "query_git_repository") return { text: "Git status result" } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("/git")]);
	const statusData = gitCallbackDataByText(telegramCalls, "Status");
	await assert.rejects(() => router.dispatchCallback(callbackQuery(statusData)), /Too Many Requests/);
	assert.equal(ipcCalls.filter((call) => call.type === "query_git_repository").length, 1);
	const editCountAfterRetryAfter = telegramCalls.filter((call) => call.method === "editMessageText" && call.body.text === "Git status result").length;
	await router.dispatchCallback(callbackQuery(statusData));
	assert.equal(ipcCalls.filter((call) => call.type === "query_git_repository").length, 1);
	assert.equal(telegramCalls.filter((call) => call.method === "editMessageText" && call.body.text === "Git status result").length, editCountAfterRetryAfter);
	assert.equal(Object.keys(brokerState.gitControls ?? {}).length, 0);
}

async function checkBareModelUsesTwoStageInlinePickerAndExactSelection(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls);

	await router.dispatch([message("/model")]);

	assert.equal(ipcCalls[0]?.type, "query_models");
	assert.equal(sentReplies[0]?.includes("Choose a model subscription/provider"), true);
	const picker = Object.values(brokerState.modelPickers ?? {})[0]!;
	assert.equal(picker.groups.length, 3);
	assert.equal(telegramCalls[0]?.method, "sendMessageReplyMarkup");
	const providerKeyboard = telegramCalls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
	assert.equal(providerKeyboard.inline_keyboard.some((row) => row[0]?.text.includes("private")), true);

	await router.dispatchCallback(callbackQuery(providerKeyboard.inline_keyboard[1]![0]!.callback_data));
	const edit = telegramCalls.find((call) => call.method === "editMessageText")!;
	assert.equal((edit.body.text as string).includes("Provider: private"), true);
	const modelKeyboard = edit.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };

	await router.dispatchCallback(callbackQuery(modelKeyboard.inline_keyboard[0]![0]!.callback_data));

	const setModelCall = ipcCalls.find((call) => call.type === "set_model")!;
	assert.deepEqual(setModelCall.payload, { selector: "openai-codex-2/gpt-5.5", exact: true });
	assert.equal(Object.keys(brokerState.modelPickers ?? {}).length, 0);
}

async function checkModelListNumberCompatibilityRemains(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, []);

	await router.dispatch([message("/model list")]);
	await router.dispatch([message("/model 2")]);

	assert.equal(sentReplies[0]?.includes("1. openai-codex/gpt-5.5"), true);
	const setModelCall = ipcCalls.find((call) => call.type === "set_model")!;
	assert.deepEqual(setModelCall.payload, { selector: "openai-codex-2/gpt-5.5", exact: true });
}

async function checkProviderCallbackUiFailuresAreNonCritical(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let failAnswer = true;
	const callTelegram = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "answerCallbackQuery" && failAnswer) throw new Error("callback query is too old");
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, callTelegram);

	await router.dispatch([message("/model")]);
	const providerKeyboard = telegramCalls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
	await router.dispatchCallback(callbackQuery(providerKeyboard.inline_keyboard[1]![0]!.callback_data));
	failAnswer = false;

	assert.equal(Object.keys(brokerState.modelPickers ?? {}).length, 1);
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText"), true);
}

async function checkTelegramUiFailureAfterSuccessfulSelectionDoesNotMarkOffline(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	const failingEditCall = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "editMessageText" && String(body.text).startsWith("Model changed")) throw new Error("message to edit not found");
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, failingEditCall);

	await router.dispatch([message("/model")]);
	const providerKeyboard = telegramCalls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
	await router.dispatchCallback(callbackQuery(providerKeyboard.inline_keyboard[1]![0]!.callback_data));
	const edit = telegramCalls.find((call) => call.method === "editMessageText")!;
	const modelKeyboard = edit.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
	await router.dispatchCallback(callbackQuery(modelKeyboard.inline_keyboard[0]![0]!.callback_data));

	assert.equal(brokerState.sessions["session-1"]!.status, "busy");
	assert.equal(sentReplies.at(-1), "Model changed to openai-codex-2/gpt-5.5");
}

async function checkRetryAfterAfterSuccessfulSelectionRetriesConfirmationWithoutRepeatingSetModel(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const telegramCalls: TelegramCall[] = [];
	let failSelectionAnswer = true;
	const callTelegram = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
		telegramCalls.push({ method, body });
		if (method === "answerCallbackQuery" && String(body.text) === "Model selection handled." && failSelectionAnswer) {
			failSelectionAnswer = false;
			throw new TelegramApiError("answerCallbackQuery", "Too Many Requests", 429, 2);
		}
		return { ok: true } as TResponse;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, telegramCalls, () => 1, callTelegram);

	await router.dispatch([message("/model")]);
	const providerKeyboard = telegramCalls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
	await router.dispatchCallback(callbackQuery(providerKeyboard.inline_keyboard[1]![0]!.callback_data));
	const edit = telegramCalls.find((call) => call.method === "editMessageText")!;
	const modelKeyboard = edit.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
	const selectData = modelKeyboard.inline_keyboard[0]![0]!.callback_data;

	await assert.rejects(() => router.dispatchCallback(callbackQuery(selectData)), /Too Many Requests/);
	assert.equal(ipcCalls.filter((call) => call.type === "set_model").length, 1);
	const completedPicker = Object.values(brokerState.modelPickers ?? {})[0]!;
	assert.equal(completedPicker.completedText, "Model changed to openai-codex-2/gpt-5.5");
	completedPicker.expiresAtMs = Date.now() - 1;

	await router.dispatchCallback(callbackQuery(selectData));
	assert.equal(ipcCalls.filter((call) => call.type === "set_model").length, 1);
	assert.equal(Object.keys(brokerState.modelPickers ?? {}).length, 0);
}

async function checkNumericModelReplyFailureDoesNotMarkOfflineAfterSetModel(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	let failNextModelReply = false;
	const sendText = async (_chatId: number | string, _threadId: number | undefined, text: string): Promise<number | undefined> => {
		sentReplies.push(text);
		if (failNextModelReply && text.startsWith("Model changed")) throw new Error("telegram reply failed");
		return 99;
	};
	const router = createRouter(brokerState, ipcCalls, sentReplies, [], () => 1, undefined, sendText);

	await router.dispatch([message("/model list")]);
	failNextModelReply = true;
	await router.dispatch([message("/model 2")]);

	assert.equal(brokerState.sessions["session-1"]!.status, "busy");
	assert.equal(ipcCalls.filter((call) => call.type === "set_model").length, 1);
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

async function checkBareModelAlsoKeepsNumberCompatibility(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, []);

	await router.dispatch([message("/model")]);
	await router.dispatch([message("/model 3")]);

	const setModelCall = ipcCalls.find((call) => call.type === "set_model")!;
	assert.deepEqual(setModelCall.payload, { selector: "openai-codex-3/gpt-5.5", exact: true });
}

await checkCommandRoutingPreservesCompactStopFollowSteerAndPlainTurns();
await checkQueuedStatusRetryAfterRetriesWithoutRedeliveryDuplicate();
await checkQueuedFollowUpSteerControlConvertsOnce();
await checkQueuedFollowUpControlFinalizesWhenTurnStartsNormally();
await checkQueuedControlRetryAfterDoesNotBlockCommands();
await checkTransientQueuedControlCleanupDefersRemainingSweep();
await checkQueuedControlCleanupRetryAfterIsRetried();
await checkQueuedControlCleanupTransientEditFailureIsRetried();
await checkLegacyExpiredControlFinalizesVisibleButtons();
await checkQueuedControlExpiryFinalizesVisibleButtons();
await checkMissingPendingTurnFinalizesVisibleQueuedControl();
await checkMissingPendingInProgressControlFinalizesVisibleButtons();
await checkStopFinalizesInProgressQueuedControls();
await checkStopCleanupRetryAfterDoesNotReplayAbort();
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
await checkGitCommandShowsInlineMenuWithoutAgentTurn();
await checkGitCallbacksQueryClientAndPreserveThread();
await checkGitCallbackRejectsStaleOfflineAndWrongRoute();
await checkGitSelectorCallbackRejectsOldSelection();
await checkGitRetryAfterPropagatesWithoutClientQueryReplay();
await checkBareModelUsesTwoStageInlinePickerAndExactSelection();
await checkModelListNumberCompatibilityRemains();
await checkProviderCallbackUiFailuresAreNonCritical();
await checkTelegramUiFailureAfterSuccessfulSelectionDoesNotMarkOffline();
await checkRetryAfterAfterSuccessfulSelectionRetriesConfirmationWithoutRepeatingSetModel();
await checkNumericModelReplyFailureDoesNotMarkOfflineAfterSetModel();
await checkBareModelAlsoKeepsNumberCompatibility();
console.log("Telegram command routing checks passed");
