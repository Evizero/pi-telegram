import assert from "node:assert/strict";

import { TelegramCommandRouter } from "../src/broker/commands.js";
import { TelegramApiError } from "../src/telegram/api.js";
import type { BrokerState, PendingTelegramTurn, SessionRegistration, TelegramCallbackQuery, TelegramMessage } from "../src/shared/types.js";

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
			if (type === "query_models") return {
				current: "openai-codex/gpt-5.5",
				models: [
					{ provider: "openai-codex", id: "gpt-5.5", name: "GPT 5.5", input: ["text"], reasoning: true, label: "openai-codex/gpt-5.5 — GPT 5.5" },
					{ provider: "openai-codex-2", id: "gpt-5.5", name: "GPT 5.5 (#2 private)", input: ["text"], reasoning: true, label: "openai-codex-2/gpt-5.5 — GPT 5.5 (#2 private)" },
					{ provider: "openai-codex-3", id: "gpt-5.5", name: "GPT 5.5 (#3 vertify max)", input: ["text"], reasoning: true, label: "openai-codex-3/gpt-5.5 — GPT 5.5 (#3 vertify max)" },
				],
			} as TResponse;
			if (type === "set_model") return { text: `Model changed to ${(payload as { selector: string }).selector}` } as TResponse;
			throw new Error(`unexpected IPC type ${type}`);
		}),
		stopTypingLoop: () => undefined,
		unregisterSession: async () => undefined,
		brokerInfo: () => "broker",
	});
}

function callbackQuery(data: string): TelegramCallbackQuery {
	return {
		id: `cb-${Math.random()}`,
		from: { id: 456, is_bot: false, first_name: "User" },
		message: message("/model", 99),
		data,
	};
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
	const statusKeyboard = telegramCalls.find((call) => call.method === "sendMessageReplyMarkup")!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
	const callbackData = statusKeyboard.inline_keyboard[0]![0]!.callback_data;
	const control = Object.values(brokerState.queuedTurnControls ?? {})[0]!;
	assert.equal(control.turnId, turn.turnId);
	assert.equal(control.targetActiveTurnId, "active-1");

	await router.dispatchCallback(callbackQuery(callbackData));
	await router.dispatchCallback(callbackQuery(callbackData));

	assert.equal(ipcCalls.filter((call) => call.type === "convert_queued_turn_to_steer").length, 1);
	assert.equal(brokerState.pendingTurns?.[turn.turnId], undefined);
	assert.equal(brokerState.completedTurnIds?.includes(turn.turnId), true);
	assert.equal(Object.values(brokerState.queuedTurnControls ?? {})[0]?.status, "converted");
	assert.equal(telegramCalls.some((call) => call.method === "editMessageText" && call.body.text === "Steered queued follow-up into the active turn."), true);
	assert.equal(telegramCalls.filter((call) => call.method === "answerCallbackQuery").length, 2);
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
	const statusKeyboard = telegramCalls.find((call) => call.method === "sendMessageReplyMarkup")!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
	const callbackData = statusKeyboard.inline_keyboard[0]![0]!.callback_data;

	await assert.rejects(() => router.dispatchCallback(callbackQuery(callbackData)), /Too Many Requests/);
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
	const callbackData = (telegramCalls.find((call) => call.method === "sendMessageReplyMarkup")!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!.callback_data;

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
		if (type === "convert_queued_turn_to_steer") return { status: "converted", text: "Recovered conversion.", turnId: (payload as { turnId: string }).turnId } as TResponse;
		throw new Error(`unexpected IPC type ${type}`);
	});

	await router.dispatch([message("queue converting", 46)]);
	const callbackData = (telegramCalls.find((call) => call.method === "sendMessageReplyMarkup")!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!.callback_data;
	const control = Object.values(brokerState.queuedTurnControls ?? {})[0]!;
	control.status = "converting";
	control.updatedAtMs = Date.now() - 1000;

	await router.dispatchCallback(callbackQuery(callbackData));

	assert.equal(ipcCalls.filter((call) => call.type === "convert_queued_turn_to_steer").length, 1);
	assert.equal(control.status, "converted");
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
	const callbackData = (telegramCalls.find((call) => call.method === "sendMessageReplyMarkup")!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!.callback_data;
	const control = Object.values(brokerState.queuedTurnControls ?? {})[0]!;
	control.status = "converting";
	delete brokerState.pendingTurns?.[control.turnId];

	await router.dispatchCallback(callbackQuery(callbackData));

	assert.equal(ipcCalls.filter((call) => call.type === "convert_queued_turn_to_steer").length, 0);
	assert.equal(control.status, "converted");
	assert.equal(telegramCalls.some((call) => call.method === "answerCallbackQuery" && call.body.text === "Queued follow-up already handled."), true);
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
	const statusKeyboard = telegramCalls.find((call) => call.method === "sendMessageReplyMarkup")!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };

	await router.dispatchCallback(callbackQuery(statusKeyboard.inline_keyboard[0]![0]!.callback_data));

	assert.equal(ipcCalls.filter((call) => call.type === "convert_queued_turn_to_steer").length, 0);
	assert.equal(Object.values(brokerState.queuedTurnControls ?? {})[0]?.status, "expired");
	assert.equal(telegramCalls.some((call) => call.method === "answerCallbackQuery" && call.body.show_alert === true), true);
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
await checkConvertedSteerControlEditRetryAfterIsRetried();
await checkQueuedSteerCallbackRejectsOfflineAndWrongRoute();
await checkConvertingSteerControlRecoversAcrossBrokerFailover();
await checkConvertingSteerControlWithMissingPendingCompletesIdempotently();
await checkStaleQueuedFollowUpControlDoesNotConvert();
await checkBareModelUsesTwoStageInlinePickerAndExactSelection();
await checkModelListNumberCompatibilityRemains();
await checkProviderCallbackUiFailuresAreNonCritical();
await checkTelegramUiFailureAfterSuccessfulSelectionDoesNotMarkOffline();
await checkRetryAfterAfterSuccessfulSelectionRetriesConfirmationWithoutRepeatingSetModel();
await checkNumericModelReplyFailureDoesNotMarkOfflineAfterSetModel();
await checkBareModelAlsoKeepsNumberCompatibility();
console.log("Telegram command routing checks passed");
