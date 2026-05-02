import { ACTIVITY_THROTTLE_MS } from "./policy.js";
import type { ActiveActivityMessageRef } from "./types.js";
import { activityLineToHtml, isThinkingActivityLine, isWorkingActivityLine, normalizedActivityLine } from "../shared/activity-lines.js";
import { errorMessage, now } from "../shared/utils.js";
import { getTelegramRetryAfterMs } from "../telegram/api-errors.js";
import { isMissingDeletedTelegramMessage, isTelegramMessageNotModified, isTerminalTelegramFinalDeliveryError } from "../telegram/errors.js";
import type { TelegramSentMessage } from "../telegram/types.js";

export { activityLineToHtml, thinkingActivityLine, toolActivityLine } from "../shared/activity-lines.js";

export interface ActivityUpdatePayload {
	turnId: string;
	activityId?: string;
	chatId: number | string;
	messageThreadId?: number;
	line: string;
}

export interface ActivityRendererDiagnostic {
	message: string;
	severity: "warning";
	statusDetail: string;
}

export interface ActivityRendererOptions {
	getDurableMessage?: (activityId: string) => ActiveActivityMessageRef | undefined;
	listDurableMessages?: () => ActiveActivityMessageRef[];
	listDurableMessagesForTurn?: (turnId: string) => ActiveActivityMessageRef[];
	saveDurableMessage?: (message: ActiveActivityMessageRef) => Promise<void> | void;
	deleteDurableMessage?: (activityId: string, expected?: ActiveActivityMessageRef) => Promise<void> | void;
	canRenderMessage?: (message: ActiveActivityMessageRef) => Promise<boolean> | boolean;
	reportDiagnostic?: (diagnostic: ActivityRendererDiagnostic) => void;
}

interface ActivityMessageState {
	turnId: string;
	activityId: string;
	sessionId?: string;
	chatId: number | string;
	messageThreadId?: number;
	messageId?: number;
	messageIdUnavailable?: boolean;
	lines: string[];
	flushTimer?: ReturnType<typeof setTimeout>;
	renderPending: boolean;
	deleteWhenEmpty: boolean;
	deleteFailed?: boolean;
	deleteError?: unknown;
	retryAtMs?: number;
	retryError?: unknown;
	createdAtMs: number;
	updatedAtMs: number;
}

function toolKeyForActivityLine(line: string): string | undefined {
	const normalized = normalizedActivityLine(line);
	const match = normalized.match(/^(\S+)\s+(\S+)/);
	if (!match) return undefined;
	const [, icon, name] = match;
	if ((icon === "💻" || icon === "❌") && name === "$") return "bash";
	if (isThinkingActivityLine(line) || isWorkingActivityLine(line)) return undefined;
	return name;
}

function replaceActiveWorkingWith(state: ActivityMessageState, line: string): boolean {
	let replaced = false;
	for (let index = state.lines.length - 1; index >= 0; index -= 1) {
		const existingLine = state.lines[index];
		if (!existingLine.startsWith("*")) continue;
		if (!isWorkingActivityLine(existingLine)) continue;
		if (!replaced) {
			state.lines[index] = line;
			replaced = true;
		} else {
			state.lines.splice(index, 1);
		}
	}
	return replaced;
}

function hasActiveThinking(state: ActivityMessageState): boolean {
	return state.lines.some((line) => line.startsWith("*") && isThinkingActivityLine(line));
}

function updateActiveThinking(state: ActivityMessageState, line: string): boolean {
	for (let index = state.lines.length - 1; index >= 0; index -= 1) {
		const existingLine = state.lines[index];
		if (!existingLine.startsWith("*")) continue;
		if (!isThinkingActivityLine(existingLine)) continue;
		state.lines[index] = line;
		return true;
	}
	return false;
}

function completeActiveThinking(state: ActivityMessageState, completedLine?: string): boolean {
	let completed = false;
	for (let index = state.lines.length - 1; index >= 0; index -= 1) {
		const line = state.lines[index];
		if (!line.startsWith("*")) continue;
		if (!isThinkingActivityLine(line)) continue;
		state.lines[index] = completedLine && !completed ? completedLine : normalizedActivityLine(line);
		completed = true;
	}
	return completed;
}

function removeActiveWorkingLines(state: ActivityMessageState): boolean {
	let removed = false;
	for (let index = state.lines.length - 1; index >= 0; index -= 1) {
		const line = state.lines[index];
		if (!line.startsWith("*")) continue;
		if (!isWorkingActivityLine(line)) continue;
		state.lines.splice(index, 1);
		removed = true;
	}
	return removed;
}

function completeActiveToolLines(state: ActivityMessageState): boolean {
	let completed = false;
	for (let index = 0; index < state.lines.length; index += 1) {
		const line = state.lines[index];
		if (!line.startsWith("*")) continue;
		const normalized = normalizedActivityLine(line);
		if (isWorkingActivityLine(line) || isThinkingActivityLine(line)) continue;
		state.lines[index] = normalized;
		completed = true;
	}
	return completed;
}

function durableRouteMatches(ref: ActiveActivityMessageRef, chatId: number | string, messageThreadId?: number): boolean {
	return String(ref.chatId) === String(chatId) && ref.messageThreadId === messageThreadId;
}

export class ActivityReporter {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly send: (payload: ActivityUpdatePayload) => Promise<unknown>) {}

	post(payload: ActivityUpdatePayload): void {
		// Preserve event ordering and history. The broker-side renderer debounces Telegram edits,
		// so every local activity event can be delivered over IPC without hammering Telegram.
		this.queue = this.queue.then(() => this.send(payload)).catch(() => undefined);
	}

	async flush(): Promise<void> {
		await this.queue;
	}
}

export class ActivityRenderer {
	private readonly messages = new Map<string, ActivityMessageState>();
	private readonly flushes = new Map<string, Promise<void>>();
	private readonly activityIdsByTurnId = new Map<string, Set<string>>();
	private readonly closedTurnIds: string[] = [];
	private readonly closedTurnIdSet = new Set<string>();
	private readonly closedActivityIds: string[] = [];
	private readonly closedActivityIdSet = new Set<string>();
	private readonly reportedDiagnosticKeys = new Set<string>();

	constructor(
		private readonly callTelegram: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>,
		private readonly startTypingLoopFor: (turnId: string, chatId: number | string, messageThreadId?: number) => void | Promise<void>,
		private readonly options: ActivityRendererOptions = {},
	) {}

	clearAllTimers(): void {
		for (const state of this.messages.values()) if (state.flushTimer) clearTimeout(state.flushTimer);
		this.messages.clear();
		this.flushes.clear();
		this.activityIdsByTurnId.clear();
		this.closedTurnIds.length = 0;
		this.closedTurnIdSet.clear();
		this.closedActivityIds.length = 0;
		this.closedActivityIdSet.clear();
		this.reportedDiagnosticKeys.clear();
	}

	async flush(activityId: string): Promise<void> {
		const state = this.messages.get(activityId);
		if (!state) return;
		if (state.flushTimer) clearTimeout(state.flushTimer);
		state.flushTimer = undefined;
		const retryDelayMs = (state.retryAtMs ?? 0) - now();
		if (retryDelayMs > 0) {
			this.scheduleFlushAfter(activityId, retryDelayMs);
			return;
		}
		if (!state.messageIdUnavailable) {
			state.retryAtMs = undefined;
			state.retryError = undefined;
		}
		const existing = this.flushes.get(activityId);
		if (existing) return existing;
		state.renderPending = false;
		const flush = this.doFlush(state).finally(() => {
			if (this.flushes.get(activityId) === flush) this.flushes.delete(activityId);
			if (!state.renderPending || state.flushTimer || this.messages.get(activityId) !== state) return;
			void this.flush(activityId);
		});
		this.flushes.set(activityId, flush);
		return flush;
	}

	recoverDurableMessages(): void {
		for (const ref of this.options.listDurableMessages?.() ?? []) {
			if (this.closedTurnIdSet.has(ref.turnId) || this.closedActivityIdSet.has(ref.activityId)) continue;
			const state = this.messages.get(ref.activityId) ?? this.recoverState(ref.activityId, ref.turnId);
			if (!state || ref.retryAtMs === undefined) continue;
			state.renderPending = true;
			this.scheduleFlushAfter(ref.activityId, Math.max(0, ref.retryAtMs - now()));
		}
	}

	async complete(turnId: string): Promise<void> {
		this.rememberClosedTurn(turnId);
		const durableActivityIds = this.options.listDurableMessagesForTurn?.(turnId).map((ref) => ref.activityId) ?? [];
		const activityIds = new Set([turnId, ...(this.activityIdsByTurnId.get(turnId) ?? []), ...durableActivityIds]);
		for (const activityId of activityIds) await this.completeActivity(turnId, activityId);
		this.activityIdsByTurnId.delete(turnId);
	}

	async completeActivity(turnId: string, activityId = turnId): Promise<void> {
		this.rememberClosedActivity(activityId);
		const state = this.messages.get(activityId) ?? this.recoverState(activityId, turnId);
		if (state) {
			removeActiveWorkingLines(state);
			completeActiveThinking(state);
			completeActiveToolLines(state);
			state.deleteWhenEmpty = true;
			state.renderPending = true;
		}
		while (true) {
			if (state && this.messages.get(activityId) !== state) break;
			const existingFlush = this.flushes.get(activityId);
			if (existingFlush) {
				await existingFlush;
				continue;
			}
			if (!state?.renderPending) break;
			const retryDelayMs = (state.retryAtMs ?? 0) - now();
			if (retryDelayMs > 0) throw (state.retryError ?? new Error(`Telegram Activity retry delayed for ${activityId}`));
			await this.flush(activityId);
		}
		const finalState = this.messages.get(activityId);
		const stateToDelete = finalState ?? state;
		if (stateToDelete?.deleteFailed) throw (stateToDelete.deleteError ?? new Error(`Telegram Activity delete failed for ${activityId}; retaining known message id for retry`));
		if (!await this.deleteDurableState(activityId, stateToDelete)) throw new Error(`Telegram Activity durable delete failed for ${activityId}`);
		if (finalState?.flushTimer) clearTimeout(finalState.flushTimer);
		this.messages.delete(activityId);
		const turnActivityIds = this.activityIdsByTurnId.get(turnId);
		turnActivityIds?.delete(activityId);
		if (turnActivityIds?.size === 0) this.activityIdsByTurnId.delete(turnId);
	}

	private rememberClosedTurn(turnId: string): void {
		if (this.closedTurnIdSet.has(turnId)) return;
		this.closedTurnIdSet.add(turnId);
		this.closedTurnIds.push(turnId);
		if (this.closedTurnIds.length <= 1000) return;
		const oldestTurnId = this.closedTurnIds.shift();
		if (oldestTurnId) this.closedTurnIdSet.delete(oldestTurnId);
	}

	private rememberClosedActivity(activityId: string): void {
		if (this.closedActivityIdSet.has(activityId)) return;
		this.closedActivityIdSet.add(activityId);
		this.closedActivityIds.push(activityId);
		if (this.closedActivityIds.length <= 1000) return;
		const oldestActivityId = this.closedActivityIds.shift();
		if (oldestActivityId) this.closedActivityIdSet.delete(oldestActivityId);
	}

	private rememberActivityForTurn(state: ActivityMessageState): void {
		const turnActivityIds = this.activityIdsByTurnId.get(state.turnId) ?? new Set<string>();
		turnActivityIds.add(state.activityId);
		this.activityIdsByTurnId.set(state.turnId, turnActivityIds);
	}

	private stateFromDurable(ref: ActiveActivityMessageRef): ActivityMessageState {
		return {
			turnId: ref.turnId,
			activityId: ref.activityId,
			sessionId: ref.sessionId,
			chatId: ref.chatId,
			messageThreadId: ref.messageThreadId,
			messageId: ref.messageId,
			messageIdUnavailable: ref.messageIdUnavailable,
			retryAtMs: ref.retryAtMs,
			retryError: ref.retryAtMs !== undefined && ref.retryAtMs > now() ? new Error(`retry after ${Math.max(0, Math.ceil((ref.retryAtMs - now()) / 1000))}s`) : undefined,
			lines: [...ref.lines],
			renderPending: false,
			deleteWhenEmpty: ref.deleteWhenEmpty ?? false,
			createdAtMs: ref.createdAtMs,
			updatedAtMs: ref.updatedAtMs,
		};
	}

	private recoverState(activityId: string, turnId?: string, route?: { chatId: number | string; messageThreadId?: number }): ActivityMessageState | undefined {
		const durable = this.options.getDurableMessage?.(activityId);
		if (!durable) return undefined;
		if (turnId !== undefined && durable.turnId !== turnId) return undefined;
		if (route && !durableRouteMatches(durable, route.chatId, route.messageThreadId)) return undefined;
		const state = this.stateFromDurable(durable);
		this.messages.set(activityId, state);
		this.rememberActivityForTurn(state);
		return state;
	}

	private durableMessage(state: ActivityMessageState): ActiveActivityMessageRef {
		return {
			turnId: state.turnId,
			activityId: state.activityId,
			sessionId: state.sessionId,
			chatId: state.chatId,
			messageThreadId: state.messageThreadId,
			messageId: state.messageId,
			messageIdUnavailable: state.messageIdUnavailable || undefined,
			retryAtMs: state.retryAtMs,
			deleteWhenEmpty: state.deleteWhenEmpty || undefined,
			lines: [...state.lines],
			createdAtMs: state.createdAtMs,
			updatedAtMs: state.updatedAtMs,
		};
	}

	private async saveDurableState(state: ActivityMessageState): Promise<boolean> {
		if (!this.options.saveDurableMessage) return true;
		state.updatedAtMs = now();
		try {
			await this.options.saveDurableMessage(this.durableMessage(state));
			return true;
		} catch (error) {
			this.reportFailure(state, "durable save", error);
			return false;
		}
	}

	private async deleteDurableState(activityId: string, state?: ActivityMessageState): Promise<boolean> {
		if (!this.options.deleteDurableMessage) return true;
		try {
			await this.options.deleteDurableMessage(activityId, state ? this.durableMessage(state) : undefined);
			return true;
		} catch (error) {
			if (state) this.reportFailure(state, "durable delete", error);
			return false;
		}
	}

	private reportFailure(state: ActivityMessageState, operation: string, error: unknown): void {
		if (!this.options.reportDiagnostic) return;
		const reason = errorMessage(error);
		const key = `${state.activityId}:${operation}:${state.messageId ?? "none"}:${reason}`;
		if (this.reportedDiagnosticKeys.has(key)) return;
		this.reportedDiagnosticKeys.add(key);
		if (this.reportedDiagnosticKeys.size > 1000) this.reportedDiagnosticKeys.clear();
		const messageIdText = state.messageId === undefined ? "without a known message id" : `message ${state.messageId}`;
		const message = `Telegram Activity ${operation} failed for turn ${state.turnId}, activity ${state.activityId}, ${messageIdText}: ${reason}`;
		this.options.reportDiagnostic({ message, severity: "warning", statusDetail: message });
	}

	private async canRenderState(state: ActivityMessageState): Promise<boolean> {
		if (!this.options.canRenderMessage) return true;
		try {
			return await this.options.canRenderMessage(this.durableMessage(state));
		} catch (error) {
			this.reportFailure(state, "render validity check", error);
			return false;
		}
	}

	private async discardState(activityId: string, state: ActivityMessageState): Promise<void> {
		if (state.flushTimer) clearTimeout(state.flushTimer);
		this.messages.delete(activityId);
		await this.deleteDurableState(activityId, state);
		const turnActivityIds = this.activityIdsByTurnId.get(state.turnId);
		turnActivityIds?.delete(activityId);
		if (turnActivityIds?.size === 0) this.activityIdsByTurnId.delete(state.turnId);
	}

	private async doFlush(state: ActivityMessageState): Promise<void> {
		if (!await this.canRenderState(state)) {
			await this.discardState(state.activityId, state);
			return;
		}
		if (state.lines.length === 0) {
			if (!state.deleteWhenEmpty) {
				await this.saveDurableState(state);
				return;
			}
			if (state.messageId !== undefined) {
				state.deleteFailed = false;
				state.deleteError = undefined;
				state.retryAtMs = undefined;
				state.retryError = undefined;
				try {
					await this.callTelegram("deleteMessage", { chat_id: state.chatId, message_id: state.messageId });
					if (!await this.deleteDurableState(state.activityId, state)) {
						state.deleteFailed = true;
						state.deleteError = new Error("Telegram Activity durable delete failed");
						return;
					}
					state.messageId = undefined;
					state.messageIdUnavailable = false;
					return;
				} catch (error) {
					if (isMissingDeletedTelegramMessage(error)) {
						if (!await this.deleteDurableState(state.activityId, state)) {
							state.deleteFailed = true;
							state.deleteError = new Error("Telegram Activity durable delete failed");
							return;
						}
						state.messageId = undefined;
						state.messageIdUnavailable = false;
						return;
					}
					if (isTerminalTelegramFinalDeliveryError(error)) {
						this.reportFailure(state, "deleteMessage", error);
						if (await this.deleteDurableState(state.activityId, state)) {
							state.messageId = undefined;
							state.messageIdUnavailable = false;
							return;
						}
						state.deleteFailed = true;
						state.deleteError = new Error("Telegram Activity durable delete failed");
						return;
					}
					const retryAfterMs = getTelegramRetryAfterMs(error);
					if (retryAfterMs !== undefined) {
						state.retryAtMs = now() + retryAfterMs + 250;
						state.retryError = error;
					}
					state.deleteFailed = true;
					state.deleteError = error;
					this.reportFailure(state, "deleteMessage", error);
					await this.saveDurableState(state);
					return;
				}
			}
			await this.deleteDurableState(state.activityId, state);
			return;
		}
		const hiddenCount = Math.max(0, state.lines.length - 12);
		const hiddenLine = hiddenCount > 0 ? [`<i>… ${hiddenCount} earlier</i>`] : [];
		const text = [`<b>Activity</b>`, ...hiddenLine, ...state.lines.slice(-12).map(activityLineToHtml)].join("\n");
		if (state.messageId === undefined) {
			if (state.messageIdUnavailable) {
				await this.saveDurableState(state);
				return;
			}
			state.messageIdUnavailable = true;
			if (!await this.saveDurableState(state)) return;
			if (!await this.canRenderState(state)) {
				await this.discardState(state.activityId, state);
				return;
			}
			const body: Record<string, unknown> = { chat_id: state.chatId, text, parse_mode: "HTML", disable_notification: true };
			if (state.messageThreadId !== undefined) body.message_thread_id = state.messageThreadId;
			try {
				const sent = await this.callTelegram<TelegramSentMessage>("sendMessage", body);
				if (sent?.message_id === undefined) throw new Error("sendMessage accepted without returning message_id");
				state.messageId = sent.message_id;
				state.messageIdUnavailable = false;
				state.retryAtMs = undefined;
				state.retryError = undefined;
				if (state.flushTimer) clearTimeout(state.flushTimer);
				state.flushTimer = undefined;
			} catch (error) {
				const retryAfterMs = getTelegramRetryAfterMs(error);
				if (retryAfterMs !== undefined) {
					state.messageIdUnavailable = false;
					state.renderPending = true;
					state.retryAtMs = now() + retryAfterMs + 250;
					state.retryError = error;
					this.reportFailure(state, "sendMessage", error);
					if (await this.saveDurableState(state)) this.scheduleFlushAfter(state.activityId, retryAfterMs + 250);
					else {
						state.renderPending = false;
						state.retryAtMs = undefined;
						state.retryError = undefined;
					}
					return;
				}
				state.messageIdUnavailable = true;
				state.retryAtMs = undefined;
				state.retryError = undefined;
				this.reportFailure(state, "sendMessage", error);
			}
			await this.saveDurableState(state);
			return;
		}
		try {
			state.retryAtMs = undefined;
			state.retryError = undefined;
			await this.callTelegram("editMessageText", { chat_id: state.chatId, message_id: state.messageId, text, parse_mode: "HTML" });
		} catch (error) {
			if (isTelegramMessageNotModified(error)) {
				await this.saveDurableState(state);
				return;
			}
			const retryAfterMs = getTelegramRetryAfterMs(error);
			if (retryAfterMs !== undefined) {
				state.renderPending = true;
				state.retryAtMs = now() + retryAfterMs + 250;
				state.retryError = error;
				this.reportFailure(state, "editMessageText", error);
				if (await this.saveDurableState(state)) this.scheduleFlushAfter(state.activityId, retryAfterMs + 250);
				else {
					state.renderPending = false;
					state.retryAtMs = undefined;
					state.retryError = undefined;
				}
				return;
			}
			this.reportFailure(state, "editMessageText", error);
		}
		await this.saveDurableState(state);
	}

	async handleUpdate(payload: ActivityUpdatePayload, sessionId?: string): Promise<{ ok: true }> {
		const activityId = payload.activityId ?? payload.turnId;
		if (this.closedTurnIdSet.has(payload.turnId) || this.closedActivityIdSet.has(activityId)) return { ok: true };
		let state = this.messages.get(activityId) ?? this.recoverState(activityId, payload.turnId, { chatId: payload.chatId, messageThreadId: payload.messageThreadId });
		if (!state) {
			const createdAtMs = now();
			state = { turnId: payload.turnId, activityId, sessionId, chatId: payload.chatId, messageThreadId: payload.messageThreadId, lines: [], renderPending: false, deleteWhenEmpty: false, createdAtMs, updatedAtMs: createdAtMs };
			this.messages.set(activityId, state);
			this.rememberActivityForTurn(state);
		} else if (sessionId && state.sessionId !== sessionId) {
			state.sessionId = sessionId;
			if (!await this.saveDurableState(state)) return { ok: true };
		}
		if (!await this.canRenderState(state)) {
			await this.discardState(activityId, state);
			return { ok: true };
		}
		void Promise.resolve()
			.then(() => this.startTypingLoopFor(payload.turnId, payload.chatId, payload.messageThreadId))
			.catch(() => undefined);
		const normalizedPayload = normalizedActivityLine(payload.line);
		if (isWorkingActivityLine(payload.line)) {
			if (payload.line.startsWith("*")) {
				if (!hasActiveThinking(state)) {
					removeActiveWorkingLines(state);
					state.lines.push(payload.line);
				}
			} else {
				removeActiveWorkingLines(state);
				completeActiveThinking(state);
			}
			state.deleteWhenEmpty = false;
			state.renderPending = true;
			if (!await this.saveDurableState(state)) return { ok: true };
			this.scheduleFlush(activityId);
			return { ok: true };
		}
		if (isThinkingActivityLine(payload.line)) {
			const lineToStore = payload.line.startsWith("*") ? payload.line : normalizedPayload;
			if (payload.line.startsWith("*")) {
				if (!updateActiveThinking(state, lineToStore) && !replaceActiveWorkingWith(state, lineToStore) && state.lines.at(-1) !== payload.line) state.lines.push(payload.line);
			} else if (!completeActiveThinking(state, lineToStore) && !replaceActiveWorkingWith(state, lineToStore) && state.lines.at(-1) !== normalizedPayload) {
				state.lines.push(normalizedPayload);
			}
			state.deleteWhenEmpty = false;
			state.renderPending = true;
			if (!await this.saveDurableState(state)) return { ok: true };
			this.scheduleFlush(activityId);
			return { ok: true };
		}
		const payloadKey = toolKeyForActivityLine(payload.line);
		const payloadMatch = normalizedPayload.match(/^(\S+)\s+(\S+)/);
		const isDone = Boolean(payloadKey) && !payload.line.startsWith("*");
		if (isDone && payloadKey && payloadMatch) {
			const [, doneIcon] = payloadMatch;
			let pendingIndex = -1;
			for (let index = state.lines.length - 1; index >= 0; index -= 1) {
				const line = state.lines[index];
				if (!line.startsWith("*")) continue;
				if (toolKeyForActivityLine(line) === payloadKey) {
					pendingIndex = index;
					break;
				}
			}
			if (pendingIndex >= 0) {
				const existing = normalizedActivityLine(state.lines[pendingIndex]);
				state.lines[pendingIndex] = doneIcon === "❌" ? existing.replace(/^\S+/, "❌") : existing;
			} else if (state.lines.at(-1) !== normalizedPayload) state.lines.push(normalizedPayload);
		} else if (state.lines.at(-1) !== payload.line) {
			state.lines.push(payload.line);
		}
		state.deleteWhenEmpty = false;
		state.renderPending = true;
		if (!await this.saveDurableState(state)) return { ok: true };
		this.scheduleFlush(activityId);
		return { ok: true };
	}

	private scheduleFlush(activityId: string): void {
		this.scheduleFlushAfter(activityId, ACTIVITY_THROTTLE_MS);
	}

	private scheduleFlushAfter(activityId: string, delayMs: number): void {
		const state = this.messages.get(activityId);
		if (!state || state.flushTimer) return;
		state.flushTimer = setTimeout(() => void this.flush(activityId), delayMs);
	}
}
