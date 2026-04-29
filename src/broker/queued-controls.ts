import type { BrokerState, QueuedTurnControlState, TelegramCallbackQuery, TelegramRoute } from "../shared/types.js";
import { QUEUED_CONTROL_TEXT } from "../shared/queued-control-text.js";
import { now } from "../shared/utils.js";
import { routeBoundControlBelongsToRoute } from "../shared/routing.js";
import { isTransientTelegramMessageEditError } from "../telegram/errors.js";

export { QUEUED_CONTROL_TEXT } from "../shared/queued-control-text.js";

export type QueuedTurnControlAction = "steer" | "cancel";

export const QUEUED_TURN_CONTROL_CALLBACK_PREFIX = "qst1";
export const QUEUED_TURN_CONTROL_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_QUEUED_CONTROL_EDIT_RETRY_MS = 30_000;

export function queuedTurnControlCallbackData(action: QueuedTurnControlAction, token: string): string {
	return `${QUEUED_TURN_CONTROL_CALLBACK_PREFIX}:${action === "steer" ? "s" : "c"}:${token}`;
}

export function isQueuedTurnControlCallbackData(data: string | undefined): boolean {
	return data?.startsWith(`${QUEUED_TURN_CONTROL_CALLBACK_PREFIX}:`) ?? false;
}

export function parseQueuedTurnControlCallback(data: string | undefined): { action: QueuedTurnControlAction; token: string } | undefined {
	if (!data) return undefined;
	const [prefix, actionOrToken, maybeToken, ...rest] = data.split(":");
	if (prefix !== QUEUED_TURN_CONTROL_CALLBACK_PREFIX || !actionOrToken || rest.length > 0) return undefined;
	if (!maybeToken) return { action: "steer", token: actionOrToken };
	if (actionOrToken === "s") return { action: "steer", token: maybeToken };
	if (actionOrToken === "c") return { action: "cancel", token: maybeToken };
	return undefined;
}

export function isTransientQueuedControlEditError(error: unknown): boolean {
	return isTransientTelegramMessageEditError(error);
}

export function queuedControlBelongsToRoute(control: QueuedTurnControlState, route: TelegramRoute): boolean {
	return routeBoundControlBelongsToRoute(control, route);
}

export function queuedControlNeedsVisibleFinalization(control: QueuedTurnControlState): boolean {
	return control.statusMessageId !== undefined
		&& control.completedText !== undefined
		&& control.statusMessageFinalizedAtMs === undefined
		&& (control.statusMessageRetryAtMs === undefined || control.statusMessageRetryAtMs <= now())
		&& isTerminalQueuedControlStatus(control.status);
}

export function isTerminalQueuedControlStatus(status: QueuedTurnControlState["status"]): boolean {
	return status === "converted" || status === "cancelled" || status === "expired";
}

// Terminalization is UI cleanup state only: callbacks still validate against
// durable pending-turn/client state before steering or cancelling execution.
export function setQueuedControlTerminal(control: QueuedTurnControlState, status: QueuedTurnControlState["status"], text: string): boolean {
	if (control.status === status && control.completedText === text && control.statusMessageRetryAtMs === undefined) return false;
	control.status = status;
	control.completedText = text;
	control.statusMessageFinalizedAtMs = undefined;
	control.statusMessageRetryAtMs = undefined;
	control.updatedAtMs = now();
	control.expiresAtMs = now() + QUEUED_TURN_CONTROL_TTL_MS;
	return true;
}

export function markQueuedTurnControlExpired(control: QueuedTurnControlState, text: string = QUEUED_CONTROL_TEXT.noLongerWaiting): boolean {
	if (control.status !== "offered" && control.status !== "converting" && control.status !== "cancelling" && !(control.status === "expired" && !control.completedText)) return false;
	return setQueuedControlTerminal(control, "expired", text);
}

export function markExpiredControlVisible(control: QueuedTurnControlState, text: string = QUEUED_CONTROL_TEXT.noLongerWaiting): boolean {
	if (control.status !== "expired" || control.completedText) return false;
	return setQueuedControlTerminal(control, "expired", text);
}

export function markMissingPendingControlHandled(control: QueuedTurnControlState): boolean {
	if (control.status === "converting") return setQueuedControlTerminal(control, "converted", QUEUED_CONTROL_TEXT.steered);
	if (control.status === "cancelling") return setQueuedControlTerminal(control, "cancelled", QUEUED_CONTROL_TEXT.cancelled);
	return false;
}

export function resetQueuedControlVisibleFinalization(control: QueuedTurnControlState, text: string): void {
	control.completedText = text;
	control.statusMessageFinalizedAtMs = undefined;
	control.statusMessageRetryAtMs = undefined;
	control.updatedAtMs = now();
}

export function callbackMatchesQueuedTurnControl(query: TelegramCallbackQuery, control: QueuedTurnControlState): boolean {
	const message = query.message;
	if (!message) return false;
	if (String(message.chat.id) !== String(control.chatId)) return false;
	if (message.message_thread_id !== control.messageThreadId) return false;
	if (control.statusMessageId !== undefined && message.message_id !== control.statusMessageId) return false;
	return true;
}

export function pruneQueuedTurnControls(brokerState: BrokerState): boolean {
	let changed = false;
	for (const [token, control] of Object.entries(brokerState.queuedTurnControls ?? {})) {
		if (control.expiresAtMs > now() && brokerState.sessions[control.sessionId]) continue;
		if (control.status === "converting" || control.status === "cancelling") continue;
		if (control.statusMessageId !== undefined && control.completedText !== undefined && control.statusMessageFinalizedAtMs === undefined) continue;
		if (control.status === "offered" && control.statusMessageId !== undefined) continue;
		delete brokerState.queuedTurnControls![token];
		changed = true;
	}
	return changed;
}
