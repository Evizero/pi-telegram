import type { InlineKeyboardMarkup, TelegramCallbackQuery, TelegramControlResultDeliveryProgress } from "../telegram/types.js";
import type { BrokerState, TelegramRoute } from "./types.js";
import { now } from "../shared/utils.js";
import { getTelegramRetryAfterMs } from "../telegram/api.js";
import { answerTelegramCallbackQueryBestEffort, editOrSendTelegramTextFully, editTelegramTextMessage, TelegramTextDeliveryProgressError } from "../telegram/message-ops.js";
import type { TelegramCommandRouterDeps } from "./command-types.js";

export interface TelegramControlMessageBinding {
	chatId: number | string;
	messageThreadId?: number;
	messageId?: number;
}

export interface TelegramControlResultBinding extends TelegramControlMessageBinding {
	resultDeliveryProgress?: TelegramControlResultDeliveryProgress;
}

export interface TelegramRouteControlBinding extends TelegramControlMessageBinding {
	routeId: string;
	sessionId: string;
	selectorSelectionUpdatedAtMs?: number;
	selectorSelectionExpiresAtMs?: number;
}

export function callbackMatchesControlMessage(query: TelegramCallbackQuery, control: TelegramControlMessageBinding): boolean {
	const message = query.message;
	if (!message) return false;
	if (String(message.chat.id) !== String(control.chatId)) return false;
	if (message.message_thread_id !== control.messageThreadId) return false;
	if (control.messageId !== undefined && message.message_id !== control.messageId) return false;
	return true;
}

export function routeMatchesControlBinding(route: TelegramRoute, control: TelegramRouteControlBinding): boolean {
	return route.sessionId === control.sessionId && route.routeId === control.routeId && String(route.chatId) === String(control.chatId) && route.messageThreadId === control.messageThreadId;
}

export function selectorSelectionMatchesControl(brokerState: BrokerState, control: TelegramRouteControlBinding): boolean {
	const selection = brokerState.selectorSelections?.[String(control.chatId)];
	return Boolean(selection && selection.sessionId === control.sessionId && selection.expiresAtMs > now() && selection.updatedAtMs === control.selectorSelectionUpdatedAtMs && selection.expiresAtMs === control.selectorSelectionExpiresAtMs);
}

export function controlRouteStillValid(brokerState: BrokerState, control: TelegramRouteControlBinding, options: { requireSelectorFreshness?: boolean } = {}): boolean {
	const session = brokerState.sessions[control.sessionId];
	if (!session || session.status === "offline") return false;
	const route = Object.values(brokerState.routes).find((candidate) => routeMatchesControlBinding(candidate, control));
	if (!route) return false;
	if (!options.requireSelectorFreshness || route.routeMode !== "single_chat_selector") return true;
	return selectorSelectionMatchesControl(brokerState, control);
}

export async function answerControlCallback(deps: Pick<TelegramCommandRouterDeps, "callTelegram">, callbackQueryId: string, text?: string, showAlert = false): Promise<void> {
	await answerTelegramCallbackQueryBestEffort(deps.callTelegram, callbackQueryId, text, { showAlert });
}

export async function trySendControlReply(deps: Pick<TelegramCommandRouterDeps, "sendTextReply">, chatId: number | string, messageThreadId: number | undefined, text: string, options?: { replyMarkup?: InlineKeyboardMarkup }): Promise<void> {
	await deps.sendTextReply(chatId, messageThreadId, text, options).catch((error) => {
		if (getTelegramRetryAfterMs(error) !== undefined) throw error;
	});
}

export async function editControlMessage(deps: Pick<TelegramCommandRouterDeps, "callTelegram" | "sendTextReply">, control: TelegramControlMessageBinding, query: TelegramCallbackQuery, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<void> {
	const messageId = query.message?.message_id ?? control.messageId;
	if (messageId === undefined) {
		await deps.sendTextReply(control.chatId, control.messageThreadId, text, replyMarkup ? { replyMarkup } : undefined);
		return;
	}
	await editTelegramTextMessage(deps.callTelegram, control.chatId, messageId, text, replyMarkup);
}

export async function tryEditControlMessage(deps: Pick<TelegramCommandRouterDeps, "callTelegram" | "sendTextReply">, control: TelegramControlMessageBinding, query: TelegramCallbackQuery, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<void> {
	await editControlMessage(deps, control, query, text, replyMarkup).catch((error) => {
		if (getTelegramRetryAfterMs(error) !== undefined) throw error;
	});
}

export async function tryEditCallbackMessage(deps: Pick<TelegramCommandRouterDeps, "callTelegram">, query: TelegramCallbackQuery, text: string): Promise<void> {
	const message = query.message;
	if (!message) return;
	await editTelegramTextMessage(deps.callTelegram, message.chat.id, message.message_id, text).catch((error) => {
		if (getTelegramRetryAfterMs(error) !== undefined) throw error;
	});
}

export async function tryEditOrSendControlResult(deps: Pick<TelegramCommandRouterDeps, "callTelegram" | "persistBrokerState">, control: TelegramControlResultBinding, query: TelegramCallbackQuery, text: string): Promise<void> {
	control.resultDeliveryProgress ??= {};
	await editOrSendTelegramTextFully(deps.callTelegram, control.chatId, control.messageThreadId, query.message?.message_id ?? control.messageId, text, {
		fallbackOn: "any-non-rate-limit",
		progress: control.resultDeliveryProgress,
		onProgress: async (progress) => {
			control.resultDeliveryProgress = progress;
			await deps.persistBrokerState();
		},
	}).catch((error) => {
		if (getTelegramRetryAfterMs(error) !== undefined || error instanceof TelegramTextDeliveryProgressError) throw error;
	});
}
