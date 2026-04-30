import { MODEL_LIST_TTL_MS } from "./policy.js";
import type { InlineKeyboardMarkup, TelegramInlineKeyboardButton } from "../telegram/types.js";
import type { TelegramGitControlState, TelegramRoute } from "./types.js";
import { now, randomId } from "../shared/utils.js";

export const GIT_CONTROL_CALLBACK_PREFIX = "git1";

export type GitControlAction = "status" | "diffstat";

export interface GitControlCallback {
	action: GitControlAction;
	token: string;
}

export interface RenderedGitControlMenu {
	text: string;
	replyMarkup: InlineKeyboardMarkup;
}

export function createGitControlState(route: TelegramRoute, messageId?: number): TelegramGitControlState {
	const createdAtMs = now();
	return {
		token: randomId("git").replace(/[^A-Za-z0-9_-]/g, ""),
		sessionId: route.sessionId,
		routeId: route.routeId,
		chatId: route.chatId,
		messageThreadId: route.messageThreadId,
		messageId,
		createdAtMs,
		updatedAtMs: createdAtMs,
		expiresAtMs: createdAtMs + MODEL_LIST_TTL_MS,
	};
}

export function renderGitControlMenu(state: TelegramGitControlState): RenderedGitControlMenu {
	return {
		text: "Git repository tools\n\nChoose a read-only action:",
		replyMarkup: {
			inline_keyboard: [[button("Status", gitControlCallbackData("status", state.token)), button("Diffstat", gitControlCallbackData("diffstat", state.token))]],
		},
	};
}

export function gitControlCallbackData(action: GitControlAction, token: string): string {
	return `${GIT_CONTROL_CALLBACK_PREFIX}:${token}:${action === "status" ? "s" : "d"}`;
}

export function isGitControlCallbackData(data: string | undefined): boolean {
	return data?.startsWith(`${GIT_CONTROL_CALLBACK_PREFIX}:`) ?? false;
}

export function parseGitControlCallback(data: string | undefined): GitControlCallback | undefined {
	if (!data) return undefined;
	const parts = data.split(":");
	if (parts.length !== 3 || parts[0] !== GIT_CONTROL_CALLBACK_PREFIX || !parts[1]) return undefined;
	if (parts[2] === "s") return { action: "status", token: parts[1] };
	if (parts[2] === "d") return { action: "diffstat", token: parts[1] };
	return undefined;
}

function button(text: string, callbackData: string): TelegramInlineKeyboardButton {
	return { text, callback_data: callbackData };
}
