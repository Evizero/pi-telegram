import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { RECENT_UPDATE_LIMIT, SESSION_OFFLINE_MS, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS } from "../shared/config.js";
import { clearPairingState, isMessageBeforePairingWindow, isPairingPending, PAIRING_MAX_FAILED_ATTEMPTS, pairingCandidateFromText } from "../shared/pairing.js";
import type { BrokerLease, BrokerState, TelegramConfig, TelegramMediaGroupState, TelegramMessage, TelegramUpdate } from "../shared/types.js";
import type { TelegramCommandRouter } from "./commands.js";
import { telegramCommandName } from "./commands.js";
import { errorMessage, hashSecret, now } from "../shared/utils.js";
import { getTelegramRetryAfterMs } from "../telegram/api.js";

export interface RuntimeUpdateDeps {
	getConfig: () => TelegramConfig;
	setConfig: (config: TelegramConfig) => void;
	getBrokerState: () => BrokerState | undefined;
	setBrokerState: (state: BrokerState) => void;
	getBrokerLeaseEpoch: () => number;
	getOwnerId: () => string;
	commandRouter: TelegramCommandRouter;
	mediaGroups: Map<string, TelegramMediaGroupState>;
	callTelegram: <TResponse>(method: string, body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<TResponse>;
	writeConfig: (config: TelegramConfig) => Promise<void>;
	persistBrokerState: () => Promise<void>;
	loadBrokerState: () => Promise<BrokerState>;
	readLease: () => Promise<BrokerLease | undefined>;
	stopBroker: () => Promise<void>;
	updateStatus: (ctx: ExtensionContext, error?: string) => void;
	refreshTelegramStatus: () => void;
	sendTextReply: (chatId: number | string, messageThreadId: number | undefined, text: string) => Promise<number | undefined>;
	ensureRoutesAfterPairing: () => Promise<void>;
	isAllowedTelegramChat: (message: TelegramMessage) => boolean;
	stopTypingLoop: (turnId: string) => void;
	postIpc: <TResponse>(socketPath: string, type: string, payload: unknown, targetSessionId?: string) => Promise<TResponse>;
	unregisterSession: (targetSessionId: string) => Promise<unknown>;
}

export function createRuntimeUpdateHandlers(deps: RuntimeUpdateDeps) {
	async function tryHandleTopicSetupMessage(message: TelegramMessage): Promise<boolean> {
		const text = (message.text ?? "").trim();
		if (telegramCommandName(text) !== "/topicsetup") return false;
		if (message.chat.type !== "supergroup" || !message.chat.is_forum) {
			await deps.sendTextReply(message.chat.id, message.message_thread_id, "Send /topicsetup in a forum supergroup where you want pi session topics.").catch(() => undefined);
			return true;
		}
		const config = deps.getConfig();
		if (config.allowedUserId === undefined || message.from?.id !== config.allowedUserId) {
			await deps.sendTextReply(message.chat.id, message.message_thread_id, "Pair this bot from pi with /telegram-setup first, then send /topicsetup from the paired Telegram account.").catch(() => undefined);
			return true;
		}
		const previousConfig = { ...config };
		const brokerState = deps.getBrokerState();
		const previousRoutes = brokerState ? Object.fromEntries(Object.entries(brokerState.routes).map(([id, route]) => [id, { ...route }])) : undefined;
		const nextConfig = { ...config, topicMode: "forum_supergroup" as const, fallbackMode: "forum_supergroup" as const, fallbackSupergroupChatId: message.chat.id };
		deps.setConfig(nextConfig);
		await deps.sendTextReply(message.chat.id, message.message_thread_id, `Using this group for pi session topics: ${message.chat.title ?? message.chat.id}`).catch(() => undefined);
		try {
			await deps.ensureRoutesAfterPairing();
			await deps.writeConfig(nextConfig);
			await deps.sendTextReply(message.chat.id, message.message_thread_id, "Created/updated pi session topics. Send messages inside a session topic to route to that pi session.").catch(() => undefined);
		} catch (error) {
			deps.setConfig(previousConfig);
			const currentBrokerState = deps.getBrokerState();
			if (currentBrokerState && previousRoutes) {
				currentBrokerState.routes = previousRoutes;
				await deps.persistBrokerState();
			}
			await deps.writeConfig(previousConfig).catch(() => undefined);
			await deps.sendTextReply(message.chat.id, message.message_thread_id, `Topic setup failed: ${errorMessage(error)}. Keeping the previous Telegram routing. Make the bot an admin with permission to manage topics, then send /topicsetup again.`).catch(() => undefined);
		}
		return true;
	}

	async function handleUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
		const message = update.message || update.edited_message;
		if (!message || !message.from || message.from.is_bot) return;
		const config = deps.getConfig();
		if (config.allowedUserId === undefined) {
			await handlePairingUpdate(message, config);
			return;
		}
		if (message.from.id !== config.allowedUserId) {
			if (deps.isAllowedTelegramChat(message)) await deps.sendTextReply(message.chat.id, message.message_thread_id, "This bot is not authorized for your account.").catch(() => undefined);
			return;
		}
		if (await tryHandleTopicSetupMessage(message)) return;
		if (!deps.isAllowedTelegramChat(message)) return;
		if (message.chat.type === "private" && config.allowedChatId === undefined) {
			const nextConfig = { ...config, allowedChatId: message.chat.id };
			deps.setConfig(nextConfig);
			await deps.writeConfig(nextConfig);
			await deps.ensureRoutesAfterPairing();
		}
		await deps.commandRouter.dispatch([message]);
	}

	async function handlePairingUpdate(message: TelegramMessage, config: TelegramConfig): Promise<void> {
		if (message.chat.type !== "private") return;
		if (!isPairingPending(config, now())) {
			const nextConfig = clearPairingState(config);
			deps.setConfig(nextConfig);
			await deps.writeConfig(nextConfig);
			await deps.sendTextReply(message.chat.id, message.message_thread_id, "Pair this bot from pi with /telegram-setup first.").catch(() => undefined);
			return;
		}
		if (isMessageBeforePairingWindow(message, config)) {
			await deps.sendTextReply(message.chat.id, message.message_thread_id, "That pairing message is older than the current setup window. Send the current PIN shown in pi.").catch(() => undefined);
			return;
		}
		const candidate = pairingCandidateFromText(message.text);
		if (candidate && config.pairingCodeHash && hashSecret(candidate) === config.pairingCodeHash) {
			const nextConfig = { ...clearPairingState(config), allowedUserId: message.from!.id, allowedChatId: message.chat.id };
			deps.setConfig(nextConfig);
			await deps.writeConfig(nextConfig);
			await deps.sendTextReply(message.chat.id, message.message_thread_id, "Telegram bridge paired with this account.");
			await deps.ensureRoutesAfterPairing();
			return;
		}
		if (candidate) {
			const failedAttempts = (config.pairingFailedAttempts ?? 0) + 1;
			if (failedAttempts >= PAIRING_MAX_FAILED_ATTEMPTS) {
				const nextConfig = clearPairingState(config);
				deps.setConfig(nextConfig);
				await deps.writeConfig(nextConfig);
				await deps.sendTextReply(message.chat.id, message.message_thread_id, "Too many incorrect pairing PIN attempts. Run /telegram-setup in pi again.").catch(() => undefined);
				return;
			}
			const nextConfig = { ...config, pairingFailedAttempts: failedAttempts };
			deps.setConfig(nextConfig);
			await deps.writeConfig(nextConfig);
			await deps.sendTextReply(message.chat.id, message.message_thread_id, `Incorrect pairing PIN. ${PAIRING_MAX_FAILED_ATTEMPTS - failedAttempts} attempt(s) remaining.`).catch(() => undefined);
			return;
		}
		await deps.sendTextReply(message.chat.id, message.message_thread_id, "Send the 4-digit pairing PIN shown in pi, or run /telegram-setup first.").catch(() => undefined);
	}

	async function handleUpdateGroup(updates: TelegramUpdate[], ctx: ExtensionContext): Promise<void> {
		const messages = updates.map((update) => update.message || update.edited_message).filter((message): message is TelegramMessage => Boolean(message));
		const first = messages[0];
		if (!first || !first.from || first.from.is_bot || !deps.isAllowedTelegramChat(first)) return;
		const config = deps.getConfig();
		if (config.allowedUserId === undefined || first.from.id !== config.allowedUserId) {
			await handleUpdate(updates[0], ctx);
			return;
		}
		if (first.chat.type === "private" && config.allowedChatId === undefined) {
			const nextConfig = { ...config, allowedChatId: first.chat.id };
			deps.setConfig(nextConfig);
			await deps.writeConfig(nextConfig);
			await deps.ensureRoutesAfterPairing();
		}
		await deps.commandRouter.dispatch(messages);
	}

	function mediaGroupKeyForUpdate(update: TelegramUpdate): string | undefined {
		const message = update.message || update.edited_message;
		if (!message?.media_group_id) return undefined;
		return `${message.chat.id}:${message.message_thread_id ?? "default"}:${message.media_group_id}`;
	}

	function shouldQueueMediaGroupUpdate(message: TelegramMessage): boolean {
		const config = deps.getConfig();
		return Boolean(message.from && !message.from.is_bot && config.allowedUserId !== undefined && message.from.id === config.allowedUserId && deps.isAllowedTelegramChat(message));
	}

	async function queueMediaGroupUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
		let brokerState = deps.getBrokerState();
		if (!brokerState) return;
		const key = mediaGroupKeyForUpdate(update);
		if (!key) return;
		brokerState.pendingMediaGroups ??= {};
		const existing = brokerState.pendingMediaGroups[key] ?? { updates: [], updatedAtMs: now() };
		if (!existing.updates.some((candidate) => candidate.update_id === update.update_id)) existing.updates.push(update);
		existing.updates.sort((a, b) => a.update_id - b.update_id);
		existing.updatedAtMs = now();
		brokerState.pendingMediaGroups[key] = existing;
		await deps.persistBrokerState();
		scheduleMediaGroupFlush(key, ctx);
	}

	function schedulePendingMediaGroups(ctx: ExtensionContext): void {
		const brokerState = deps.getBrokerState();
		if (!brokerState?.pendingMediaGroups) return;
		for (const key of Object.keys(brokerState.pendingMediaGroups)) scheduleMediaGroupFlush(key, ctx);
	}

	function scheduleMediaGroupFlush(key: string, ctx: ExtensionContext, delayMs = TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS): void {
		const existing = deps.mediaGroups.get(key);
		if (existing?.flushTimer) clearTimeout(existing.flushTimer);
		const flushTimer = setTimeout(() => {
			void flushMediaGroup(key, ctx);
		}, delayMs);
		deps.mediaGroups.set(key, { messages: [], flushTimer });
	}

	async function flushMediaGroup(key: string, ctx: ExtensionContext): Promise<void> {
		const timerState = deps.mediaGroups.get(key);
		if (timerState?.flushTimer) clearTimeout(timerState.flushTimer);
		deps.mediaGroups.delete(key);
		const brokerState = deps.getBrokerState();
		if (!brokerState?.pendingMediaGroups?.[key]) return;
		const group = [...brokerState.pendingMediaGroups[key].updates];
		const processedUpdateIds = new Set(group.map((update) => update.update_id));
		let removeProcessed = true;
		try {
			await handleUpdateGroup(group, ctx);
		} catch (error) {
			const retryAfterMs = getTelegramRetryAfterMs(error);
			if (retryAfterMs !== undefined) {
				removeProcessed = false;
				scheduleMediaGroupFlush(key, ctx, retryAfterMs + 250);
			} else {
				const firstMessage = group.map((update) => update.message || update.edited_message).find((message): message is TelegramMessage => Boolean(message));
				if (firstMessage) await deps.sendTextReply(firstMessage.chat.id, firstMessage.message_thread_id, `Failed to prepare Telegram album: ${errorMessage(error)}`).catch(() => undefined);
			}
		} finally {
			if (removeProcessed) await removeProcessedMediaGroupUpdates(key, processedUpdateIds, ctx);
		}
	}

	async function removeProcessedMediaGroupUpdates(key: string, processedUpdateIds: Set<number>, ctx: ExtensionContext): Promise<void> {
		const currentBrokerState = deps.getBrokerState();
		const current = currentBrokerState?.pendingMediaGroups?.[key];
		if (!current) return;
		current.updates = current.updates.filter((update) => !processedUpdateIds.has(update.update_id));
		if (current.updates.length === 0) delete currentBrokerState.pendingMediaGroups![key];
		else scheduleMediaGroupFlush(key, ctx);
		await deps.persistBrokerState();
	}

	async function initializePollingOffset(signal: AbortSignal): Promise<void> {
		const brokerState = deps.getBrokerState();
		if (!brokerState || brokerState.lastProcessedUpdateId !== undefined) return;
		const config = deps.getConfig();
		if (isPairingPending(config, now())) return;
		const updates = await deps.callTelegram<TelegramUpdate[]>("getUpdates", { offset: -1, limit: 1, timeout: 0, allowed_updates: ["message", "edited_message"] }, { signal });
		const latest = updates.at(-1);
		if (latest) {
			brokerState.lastProcessedUpdateId = latest.update_id;
			brokerState.recentUpdateIds = [latest.update_id];
		} else {
			brokerState.lastProcessedUpdateId = config.lastUpdateId ?? 0;
		}
		await deps.persistBrokerState();
	}

	async function pollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
		if (!deps.getConfig().botToken) return;
		let webhookCleared = false;
		if (!deps.getBrokerState()) deps.setBrokerState(await deps.loadBrokerState());
		while (!signal.aborted) {
			try {
				if (!webhookCleared) {
					await deps.callTelegram("deleteWebhook", { drop_pending_updates: false }, { signal });
					webhookCleared = true;
				}
				let brokerState = deps.getBrokerState();
				if (!brokerState) {
					brokerState = await deps.loadBrokerState();
					deps.setBrokerState(brokerState);
				}
				if (brokerState.lastProcessedUpdateId === undefined) await initializePollingOffset(signal);
				const lease = await deps.readLease();
				if (!lease || lease.ownerId !== deps.getOwnerId() || lease.leaseEpoch !== deps.getBrokerLeaseEpoch() || lease.leaseUntilMs <= now()) {
					await deps.stopBroker();
					return;
				}
				brokerState = deps.getBrokerState() ?? (await deps.loadBrokerState());
				const updates = await deps.callTelegram<TelegramUpdate[]>(
					"getUpdates",
					{
						offset: brokerState.lastProcessedUpdateId !== undefined ? brokerState.lastProcessedUpdateId + 1 : undefined,
						limit: 25,
						timeout: 30,
						allowed_updates: ["message", "edited_message"],
					},
					{ signal },
				);
				const postPollLease = await deps.readLease();
				if (!postPollLease || postPollLease.ownerId !== deps.getOwnerId() || postPollLease.leaseEpoch !== deps.getBrokerLeaseEpoch() || postPollLease.leaseUntilMs <= now()) {
					await deps.stopBroker();
					return;
				}
				for (const update of updates) {
					if (brokerState.recentUpdateIds.includes(update.update_id)) {
						brokerState.lastProcessedUpdateId = update.update_id;
						await deps.persistBrokerState();
						continue;
					}
					const message = update.message || update.edited_message;
					if (message?.media_group_id && shouldQueueMediaGroupUpdate(message)) await queueMediaGroupUpdate(update, ctx);
					else await handleUpdate(update, ctx);
					brokerState.recentUpdateIds.push(update.update_id);
					if (brokerState.recentUpdateIds.length > RECENT_UPDATE_LIMIT) brokerState.recentUpdateIds.splice(0, brokerState.recentUpdateIds.length - RECENT_UPDATE_LIMIT);
					brokerState.lastProcessedUpdateId = update.update_id;
					await deps.persistBrokerState();
				}
				await markOfflineSessions();
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof DOMException && error.name === "AbortError") return;
				deps.updateStatus(ctx, errorMessage(error));
				const retryAfterMs = getTelegramRetryAfterMs(error);
				await new Promise((resolveValue) => setTimeout(resolveValue, retryAfterMs === undefined ? 3000 : retryAfterMs + 250));
				deps.updateStatus(ctx);
			}
		}
	}

	async function markOfflineSessions(): Promise<void> {
		const brokerState = deps.getBrokerState();
		if (!brokerState) return;
		const expiredSessionIds = Object.values(brokerState.sessions)
			.filter((session) => now() - session.lastHeartbeatMs > SESSION_OFFLINE_MS)
			.map((session) => session.sessionId);
		for (const sessionId of expiredSessionIds) await deps.unregisterSession(sessionId);
	}

	async function retryPendingTurns(): Promise<void> {
		const brokerState = deps.getBrokerState();
		if (!brokerState?.pendingTurns) return;
		for (const pending of Object.values(brokerState.pendingTurns)) {
			if (brokerState.pendingAssistantFinals?.[pending.turn.turnId]) continue;
			const session = brokerState.sessions[pending.turn.sessionId];
			if (!session || session.status === "offline") continue;
			try {
				await deps.postIpc(session.clientSocketPath, "deliver_turn", pending.turn, session.sessionId);
				pending.updatedAtMs = now();
			} catch {
				// Keep the durable pending turn for the next broker/session heartbeat.
			}
		}
		await deps.persistBrokerState();
	}

	return { handleUpdate, handleUpdateGroup, queueMediaGroupUpdate, schedulePendingMediaGroups, pollLoop, markOfflineSessions, retryPendingTurns };
}
