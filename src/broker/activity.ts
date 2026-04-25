import { ACTIVITY_THROTTLE_MS } from "../shared/config.js";
import type { TelegramSentMessage } from "../shared/types.js";

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

function activityLineToHtml(line: string): string {
	const active = line.startsWith("*");
	const normalized = active ? line.slice(1) : line;
	if (normalized.startsWith("🧠 ")) {
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

export function toolActivityLine(toolName: string, args?: unknown, done?: boolean, isError?: boolean): string {
	const icon = isError ? "❌" : toolName === "bash" ? "💻" : "🔧";
	const suffix = args === undefined || done ? "" : ` ${compactToolArgs(toolName, args)}`;
	return `${done ? "" : "*"}${icon} ${toolName}${suffix}`;
}

export function thinkingActivityLine(done: boolean, title?: string): string {
	return `${done ? "" : "*"}🧠 ${title || "thinking ..."}`;
}

export class ActivityReporter {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly send: (payload: ActivityUpdatePayload) => Promise<unknown>) {}

	post(payload: ActivityUpdatePayload): void {
		// Preserve event ordering and history. The broker-side renderer debounces Telegram edits,
		// so every local activity event can be delivered over IPC without hammering Telegram.
		this.queue = this.queue.then(() => this.send(payload)).catch(() => undefined);
	}
}

export class ActivityRenderer {
	private readonly messages = new Map<string, ActivityMessageState>();
	private readonly flushes = new Map<string, Promise<void>>();

	constructor(
		private readonly callTelegram: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>,
		private readonly startTypingLoopFor: (turnId: string, chatId: number | string, messageThreadId?: number) => Promise<void>,
	) {}

	clearAllTimers(): void {
		for (const state of this.messages.values()) if (state.flushTimer) clearTimeout(state.flushTimer);
		this.messages.clear();
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

	private async doFlush(_turnId: string, state: ActivityMessageState): Promise<void> {
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
		await this.startTypingLoopFor(payload.turnId, payload.chatId, payload.messageThreadId);
		let state = this.messages.get(payload.turnId);
		if (!state) {
			state = { chatId: payload.chatId, messageThreadId: payload.messageThreadId, lines: [] };
			this.messages.set(payload.turnId, state);
		}
		const normalizedPayload = payload.line.startsWith("*") ? payload.line.slice(1) : payload.line;
		if (normalizedPayload.startsWith("🧠 ")) {
			const lastIndex = state.lines.length - 1;
			const lastLine = lastIndex >= 0 ? state.lines[lastIndex] : undefined;
			const normalizedLastLine = lastLine?.startsWith("*") ? lastLine.slice(1) : lastLine;
			const canUpdateCurrentThinking = Boolean(lastLine?.startsWith("*") && normalizedLastLine?.startsWith("🧠 "));
			if (canUpdateCurrentThinking) state.lines[lastIndex] = payload.line.startsWith("*") ? payload.line : normalizedPayload;
			else if (state.lines.at(-1) !== payload.line) state.lines.push(payload.line);
			this.scheduleFlush(payload.turnId);
			return { ok: true };
		}
		const payloadMatch = normalizedPayload.match(/^(\S+)\s+(\S+)/);
		const isDone = Boolean(payloadMatch) && !payload.line.startsWith("*");
		if (isDone && payloadMatch) {
			const [, doneIcon, name] = payloadMatch;
			let pendingIndex = -1;
			for (let index = state.lines.length - 1; index >= 0; index -= 1) {
				const line = state.lines[index];
				const normalizedLine = line.startsWith("*") ? line.slice(1) : line;
				const lineMatch = normalizedLine.match(/^(\S+)\s+(\S+)/);
				if (lineMatch?.[2] === name) {
					pendingIndex = index;
					break;
				}
			}
			if (pendingIndex >= 0) {
				const existing = state.lines[pendingIndex].startsWith("*") ? state.lines[pendingIndex].slice(1) : state.lines[pendingIndex];
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
