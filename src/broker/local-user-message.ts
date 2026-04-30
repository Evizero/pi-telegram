import type { BrokerState, TelegramRoute } from "./types.js";
import { formatLocalUserMirrorMessage } from "../shared/format.js";

export function routeForSessionLocalMessage(brokerState: BrokerState | undefined, targetSessionId: string, identity?: { routeId?: string; chatId?: number | string; messageThreadId?: number }): TelegramRoute | undefined {
	if (!brokerState) return undefined;
	const sessionRoutes = Object.values(brokerState.routes).filter((candidate) => candidate.sessionId === targetSessionId && candidate.chatId !== 0);
	return (identity?.routeId ? sessionRoutes.find((candidate) => candidate.routeId === identity.routeId) : undefined)
		?? ((identity?.chatId !== undefined || identity?.messageThreadId !== undefined)
			? sessionRoutes.find((candidate) => String(candidate.chatId) === String(identity.chatId) && candidate.messageThreadId === identity.messageThreadId)
			: undefined)
		?? (sessionRoutes.length === 1 ? sessionRoutes[0] : undefined);
}

export async function handleLocalUserMirrorMessage(options: {
	brokerState: BrokerState | undefined;
	sourceSessionId: string | undefined;
	payload: { text: string; imagesCount?: number; routeId?: string; chatId?: number | string; messageThreadId?: number };
	sendTextReply: (chatId: number | string, messageThreadId: number | undefined, text: string, options?: { disableNotification?: boolean }) => Promise<number | undefined>;
}): Promise<{ ok: true }> {
	if (!options.brokerState || !options.sourceSessionId) return { ok: true };
	const route = routeForSessionLocalMessage(options.brokerState, options.sourceSessionId, options.payload);
	if (!route || route.sessionId !== options.sourceSessionId) return { ok: true };
	await options.sendTextReply(route.chatId, route.messageThreadId, formatLocalUserMirrorMessage(options.payload.text, options.payload.imagesCount), { disableNotification: true });
	return { ok: true };
}
