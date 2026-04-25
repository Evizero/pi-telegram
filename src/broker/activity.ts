import { ACTIVITY_THROTTLE_MS } from "../shared/config.js";
import type { TelegramSentMessage } from "../shared/types.js";

const WORKING_ACTIVITY_LINE = "⏳ working ...";

export interface ActivityUpdatePayload {
	turnId: string;
	chatId: number | string;
	messageThreadId?: number;
	line: string;
}

interface ActivityMessageState {
	chatId: number | string;
	messageThreadId?: number;
	messageId?: number;
	lines: string[];
	flushTimer?: ReturnType<typeof setTimeout>;
}

function compactValue(value: unknown): string {
	if (value === undefined) return "";
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return text.length > 90 ? `${text.slice(0, 87)}...` : text;
	} catch {
		return String(value);
	}
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function activityLineToHtml(line: string): string {
	const active = line.startsWith("*");
	const normalized = active ? line.slice(1) : line;
	if (normalized.startsWith("🧠 ") || normalized === WORKING_ACTIVITY_LINE) {
		const body = escapeHtml(normalized);
		return active ? `<b>${body}</b>` : body;
	}
	const match = normalized.match(/^(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/);
	if (!match) return escapeHtml(normalized);
	const [, icon, name, rest] = match;
	const body = rest ? `${escapeHtml(icon)} ${escapeHtml(name)} <code>${escapeHtml(rest)}</code>` : `${escapeHtml(icon)} ${escapeHtml(name)}`;
	return active ? `<b>${body}</b>` : body;
}

function compactToolArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return compactValue(args);
	const record = args as Record<string, unknown>;
	if (toolName === "read") return compactValue(record.path);
	if (toolName === "bash") return compactValue(record.command);
	if (toolName === "edit" || toolName === "write") return compactValue(record.path);
	if (toolName === "grep" || toolName === "find") return compactValue(record.pattern ?? record.query ?? record.path);
	if (toolName === "ls") return compactValue(record.path);
	return compactValue(args);
}

function toolIconAndName(toolName: string, isError?: boolean): { icon: string; name: string } {
	if (isError) return { icon: "❌", name: toolName === "bash" ? "$" : toolName };
	if (toolName === "bash") return { icon: "💻", name: "$" };
	if (toolName === "read") return { icon: "📖", name: "read" };
	if (toolName === "write") return { icon: "📝", name: "write" };
	if (toolName === "edit") return { icon: "📝", name: "edit" };
	return { icon: "🔧", name: toolName };
}

export function toolActivityLine(toolName: string, args?: unknown, done?: boolean, isError?: boolean): string {
	const { icon, name } = toolIconAndName(toolName, isError);
	const suffix = args === undefined || done ? "" : ` ${compactToolArgs(toolName, args)}`;
	return `${done ? "" : "*"}${icon} ${name}${suffix}`;
}

export function thinkingActivityLine(done: boolean, title?: string): string {
	const normalizedTitle = title?.trim();
	if (!normalizedTitle) return `${done ? "" : "*"}${WORKING_ACTIVITY_LINE}`;
	return `${done ? "" : "*"}🧠 ${normalizedTitle}`;
}

function normalizedActivityLine(line: string): string {
	return line.startsWith("*") ? line.slice(1) : line;
}

function toolKeyForActivityLine(line: string): string | undefined {
	const normalized = normalizedActivityLine(line);
	const match = normalized.match(/^(\S+)\s+(\S+)/);
	if (!match) return undefined;
	const [, icon, name] = match;
	if ((icon === "💻" || icon === "❌") && name === "$") return "bash";
	if (normalized.startsWith("🧠 ") || normalized === WORKING_ACTIVITY_LINE) return undefined;
	return name;
}

function replaceActiveWorkingWith(state: ActivityMessageState, line: string): boolean {
	let replaced = false;
	for (let index = state.lines.length - 1; index >= 0; index -= 1) {
		const existingLine = state.lines[index];
		if (!existingLine.startsWith("*")) continue;
		if (normalizedActivityLine(existingLine) !== WORKING_ACTIVITY_LINE) continue;
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
	return state.lines.some((line) => line.startsWith("*") && normalizedActivityLine(line).startsWith("🧠 "));
}

function updateActiveThinking(state: ActivityMessageState, line: string): boolean {
	for (let index = state.lines.length - 1; index >= 0; index -= 1) {
		const existingLine = state.lines[index];
		if (!existingLine.startsWith("*")) continue;
		if (!normalizedActivityLine(existingLine).startsWith("🧠 ")) continue;
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
		if (!normalizedActivityLine(line).startsWith("🧠 ")) continue;
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
		if (normalizedActivityLine(line) !== WORKING_ACTIVITY_LINE) continue;
		state.lines.splice(index, 1);
		removed = true;
	}
	return removed;
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
	private readonly closedTurnIds: string[] = [];
	private readonly closedTurnIdSet = new Set<string>();

	constructor(
		private readonly callTelegram: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>,
		private readonly startTypingLoopFor: (turnId: string, chatId: number | string, messageThreadId?: number) => Promise<void>,
	) {}

	clearAllTimers(): void {
		for (const state of this.messages.values()) if (state.flushTimer) clearTimeout(state.flushTimer);
		this.messages.clear();
		this.closedTurnIds.length = 0;
		this.closedTurnIdSet.clear();
	}

	async flush(turnId: string): Promise<void> {
		const existing = this.flushes.get(turnId);
		if (existing) return existing;
		const state = this.messages.get(turnId);
		if (!state) return;
		if (state.flushTimer) clearTimeout(state.flushTimer);
		state.flushTimer = undefined;
		const flush = this.doFlush(turnId, state).finally(() => {
			if (this.flushes.get(turnId) === flush) this.flushes.delete(turnId);
		});
		this.flushes.set(turnId, flush);
		return flush;
	}

	async complete(turnId: string): Promise<void> {
		this.rememberClosedTurn(turnId);
		const state = this.messages.get(turnId);
		if (state) {
			removeActiveWorkingLines(state);
			completeActiveThinking(state);
		}
		const existingFlush = this.flushes.get(turnId);
		if (existingFlush) await existingFlush;
		await this.flush(turnId);
		const finalState = this.messages.get(turnId);
		if (finalState?.flushTimer) clearTimeout(finalState.flushTimer);
		this.messages.delete(turnId);
	}

	private rememberClosedTurn(turnId: string): void {
		if (this.closedTurnIdSet.has(turnId)) return;
		this.closedTurnIdSet.add(turnId);
		this.closedTurnIds.push(turnId);
		if (this.closedTurnIds.length <= 1000) return;
		const oldestTurnId = this.closedTurnIds.shift();
		if (oldestTurnId) this.closedTurnIdSet.delete(oldestTurnId);
	}

	private async doFlush(_turnId: string, state: ActivityMessageState): Promise<void> {
		if (state.lines.length === 0) {
			if (state.messageId !== undefined) {
				await this.callTelegram("deleteMessage", { chat_id: state.chatId, message_id: state.messageId }).catch(() => undefined);
				state.messageId = undefined;
			}
			return;
		}
		const hiddenCount = Math.max(0, state.lines.length - 12);
		const hiddenLine = hiddenCount > 0 ? [`<i>… ${hiddenCount} earlier</i>`] : [];
		const text = [`<b>Activity</b>`, ...hiddenLine, ...state.lines.slice(-12).map(activityLineToHtml)].join("\n");
		if (state.messageId === undefined) {
			const body: Record<string, unknown> = { chat_id: state.chatId, text, parse_mode: "HTML", disable_notification: true };
			if (state.messageThreadId !== undefined) body.message_thread_id = state.messageThreadId;
			const sent = await this.callTelegram<TelegramSentMessage>("sendMessage", body).catch(() => undefined);
			state.messageId = sent?.message_id;
			return;
		}
		await this.callTelegram("editMessageText", { chat_id: state.chatId, message_id: state.messageId, text, parse_mode: "HTML" }).catch(() => undefined);
	}

	async handleUpdate(payload: ActivityUpdatePayload): Promise<{ ok: true }> {
		if (this.closedTurnIdSet.has(payload.turnId)) return { ok: true };
		await this.startTypingLoopFor(payload.turnId, payload.chatId, payload.messageThreadId);
		if (this.closedTurnIdSet.has(payload.turnId)) return { ok: true };
		let state = this.messages.get(payload.turnId);
		if (!state) {
			state = { chatId: payload.chatId, messageThreadId: payload.messageThreadId, lines: [] };
			this.messages.set(payload.turnId, state);
		}
		const normalizedPayload = normalizedActivityLine(payload.line);
		if (normalizedPayload === WORKING_ACTIVITY_LINE) {
			if (payload.line.startsWith("*")) {
				if (!hasActiveThinking(state)) {
					removeActiveWorkingLines(state);
					state.lines.push(payload.line);
				}
			} else {
				removeActiveWorkingLines(state);
				completeActiveThinking(state);
			}
			this.scheduleFlush(payload.turnId);
			return { ok: true };
		}
		if (normalizedPayload.startsWith("🧠 ")) {
			const lineToStore = payload.line.startsWith("*") ? payload.line : normalizedPayload;
			if (payload.line.startsWith("*")) {
				if (!updateActiveThinking(state, lineToStore) && !replaceActiveWorkingWith(state, lineToStore) && state.lines.at(-1) !== payload.line) state.lines.push(payload.line);
			} else if (!completeActiveThinking(state, lineToStore) && !replaceActiveWorkingWith(state, lineToStore) && state.lines.at(-1) !== normalizedPayload) {
				state.lines.push(normalizedPayload);
			}
			this.scheduleFlush(payload.turnId);
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
		this.scheduleFlush(payload.turnId);
		return { ok: true };
	}

	private scheduleFlush(turnId: string): void {
		const state = this.messages.get(turnId);
		if (!state || state.flushTimer) return;
		state.flushTimer = setTimeout(() => void this.flush(turnId), ACTIVITY_THROTTLE_MS);
	}
}
