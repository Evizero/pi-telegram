import { MAX_MESSAGE_LENGTH, PREVIEW_THROTTLE_MS, TELEGRAM_DRAFT_ID_MAX } from "../shared/config.js";
import { chunkParagraphs } from "../shared/format.js";
import { getTelegramRetryAfterMs } from "./api.js";
import {
	isDraftMethodUnsupported,
	isMissingDeletedTelegramMessage,
	isMissingEditableTelegramMessage,
	isTelegramMessageNotModified,
	shouldPreserveTelegramMessageRefOnDeleteFailure,
	shouldRetryTelegramMessageCleanup,
} from "./errors.js";
import { deleteTelegramMessage } from "./message-ops.js";
import type { TelegramPreviewState, TelegramSentMessage } from "../shared/types.js";

export class PreviewManager {
	private draftSupport: "unknown" | "supported" | "unsupported" = "unknown";
	private nextDraftId = 0;
	private readonly previews = new Map<string, TelegramPreviewState>();
	private readonly flushes = new Map<string, Promise<void>>();

	constructor(
		private readonly callTelegram: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>,
		private readonly sendTextReply: (chatId: number | string, messageThreadId: number | undefined, text: string) => Promise<number | undefined>,
		private readonly onVisiblePreview?: (turnId: string, chatId: number | string, messageThreadId: number | undefined, messageId: number) => void,
		private readonly onPreviewDetached?: (turnId: string) => void,
	) {}

	clearAllTimers(): void {
		for (const state of this.previews.values()) if (state.flushTimer) clearTimeout(state.flushTimer);
		this.previews.clear();
	}

	async messageStart(turnId: string, chatId: number | string, messageThreadId?: number, reuseMessageId?: number): Promise<void> {
		const state = this.previews.get(turnId);
		if (state) {
			if (state.flushTimer) clearTimeout(state.flushTimer);
			state.flushTimer = undefined;
			await this.flushes.get(turnId)?.catch(() => undefined);
			state.preserveForRetry = false;
			if (reuseMessageId !== undefined) state.messageId = reuseMessageId;
			state.mode = state.messageId !== undefined ? "message" : this.shouldUseDraft(chatId) ? "draft" : "message";
			state.pendingText = "";
			if (state.messageId === undefined) state.lastSentText = "";
			return;
		}
		this.previews.set(turnId, {
			mode: reuseMessageId !== undefined ? "message" : this.shouldUseDraft(chatId) ? "draft" : "message",
			messageId: reuseMessageId,
			pendingText: "",
			lastSentText: "",
		});
	}

	preview(turnId: string, chatId: number | string, messageThreadId: number | undefined, text: string, reuseMessageId?: number): void {
		let state = this.previews.get(turnId);
		if (!state) {
			state = { mode: reuseMessageId !== undefined ? "message" : this.shouldUseDraft(chatId) ? "draft" : "message", messageId: reuseMessageId, pendingText: "", lastSentText: "" };
			this.previews.set(turnId, state);
		} else if (state.messageId === undefined && reuseMessageId !== undefined) {
			state.messageId = reuseMessageId;
			state.mode = "message";
		}
		state.pendingText = text;
		this.scheduleFlush(turnId, chatId, messageThreadId);
	}

	async clear(turnId: string, chatId: number | string, messageThreadId?: number, options?: { preserveOnFailure?: boolean }): Promise<void> {
		const state = this.previews.get(turnId);
		if (!state) return;
		if (state.flushTimer) clearTimeout(state.flushTimer);
		state.flushTimer = undefined;
		await this.flushes.get(turnId)?.catch(() => undefined);
		if (state.messageId !== undefined) {
			if (options?.preserveOnFailure) {
				try {
					await deleteTelegramMessage(this.callTelegram, chatId, state.messageId, { ignoreMissing: true });
				} catch (error) {
					if (shouldPreserveTelegramMessageRefOnDeleteFailure(error)) {
						state.preserveForRetry = true;
						return;
					}
					throw error;
				}
			} else {
				await this.callTelegram("deleteMessage", { chat_id: chatId, message_id: state.messageId }).catch(() => undefined);
			}
		}
		this.previews.delete(turnId);
		this.onPreviewDetached?.(turnId);
	}

	async detachForFinal(turnId: string): Promise<{ mode: "draft" | "message"; messageId?: number } | undefined> {
		const state = this.previews.get(turnId);
		if (!state) return undefined;
		if (state.flushTimer) clearTimeout(state.flushTimer);
		state.flushTimer = undefined;
		await this.flushes.get(turnId)?.catch(() => undefined);
		this.previews.delete(turnId);
		this.onPreviewDetached?.(turnId);
		return { mode: state.mode, messageId: state.messageId };
	}

	async finalize(turnId: string, chatId: number | string, messageThreadId: number | undefined, finalText?: string): Promise<boolean> {
		const state = this.previews.get(turnId);
		if (!state) return false;
		if (state.flushTimer) clearTimeout(state.flushTimer);
		state.flushTimer = undefined;
		await this.flushes.get(turnId)?.catch(() => undefined);
		if (finalText !== undefined) state.pendingText = finalText;
		const text = (state.pendingText.trim() || state.lastSentText).trim();
		if (!text) {
			await this.clear(turnId, chatId, messageThreadId);
			return false;
		}
		if (text.length > MAX_MESSAGE_LENGTH) return await this.finalizeChunked(turnId, chatId, messageThreadId, state, text);
		if (state.mode === "draft") {
			await this.sendTextReply(chatId, messageThreadId, text);
			await this.clear(turnId, chatId, messageThreadId);
			return true;
		}
		if (state.messageId !== undefined) await this.deletePreviewMessageForFinal(chatId, state.messageId);
		await this.sendTextReply(chatId, messageThreadId, text);
		this.previews.delete(turnId);
		this.onPreviewDetached?.(turnId);
		return true;
	}

	private async finalizeChunked(turnId: string, chatId: number | string, messageThreadId: number | undefined, state: TelegramPreviewState, text: string): Promise<boolean> {
		const chunks = chunkParagraphs(text);
		const [firstChunk, ...remainingChunks] = chunks;
		if (!firstChunk) {
			await this.clear(turnId, chatId, messageThreadId);
			return false;
		}
		if (state.mode === "draft") {
			for (const chunk of chunks) await this.sendTextReply(chatId, messageThreadId, chunk);
			await this.clear(turnId, chatId, messageThreadId);
			return true;
		}
		if (state.messageId !== undefined) await this.deletePreviewMessageForFinal(chatId, state.messageId);
		await this.sendTextReply(chatId, messageThreadId, firstChunk);
		for (const chunk of remainingChunks) await this.sendTextReply(chatId, messageThreadId, chunk);
		this.previews.delete(turnId);
		this.onPreviewDetached?.(turnId);
		return true;
	}

	private allocateDraftId(): number {
		this.nextDraftId = this.nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : this.nextDraftId + 1;
		return this.nextDraftId;
	}

	private shouldUseDraft(_chatId: number | string): boolean {
		return false;
	}

	private scheduleFlush(turnId: string, chatId: number | string, messageThreadId?: number): void {
		const state = this.previews.get(turnId);
		if (!state || state.flushTimer) return;
		this.setFlushTimer(turnId, chatId, messageThreadId, PREVIEW_THROTTLE_MS);
	}

	private setFlushTimer(turnId: string, chatId: number | string, messageThreadId: number | undefined, delayMs: number): void {
		const state = this.previews.get(turnId);
		if (!state) return;
		state.flushTimer = setTimeout(() => {
			const flush = this.flush(turnId, chatId, messageThreadId).catch((error: unknown) => this.handleFlushError(turnId, chatId, messageThreadId, error));
			this.flushes.set(turnId, flush);
			void flush.finally(() => {
				if (this.flushes.get(turnId) === flush) this.flushes.delete(turnId);
			});
		}, delayMs);
	}

	private handleFlushError(turnId: string, chatId: number | string, messageThreadId: number | undefined, error: unknown): void {
		const state = this.previews.get(turnId);
		if (!state) return;
		state.flushTimer = undefined;
		const retryAfterMs = getTelegramRetryAfterMs(error);
		if (retryAfterMs !== undefined) {
			this.setFlushTimer(turnId, chatId, messageThreadId, Math.max(retryAfterMs + 250, PREVIEW_THROTTLE_MS));
			return;
		}
		if (isTelegramMessageNotModified(error)) {
			const text = state.pendingText.trim();
			state.lastSentText = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;
			state.mode = "message";
			return;
		}
		console.warn("[pi-telegram] Telegram preview update failed:", error instanceof Error ? error.message : error);
	}

	private async deletePreviewMessageForFinal(chatId: number | string, messageId: number): Promise<void> {
		try {
			await this.callTelegram("deleteMessage", { chat_id: chatId, message_id: messageId });
		} catch (error) {
			if (isMissingDeletedTelegramMessage(error)) return;
			if (shouldRetryTelegramMessageCleanup(error)) throw error;
		}
	}

	private async flush(turnId: string, chatId: number | string, messageThreadId: number | undefined): Promise<void> {
		const state = this.previews.get(turnId);
		if (!state) return;
		state.flushTimer = undefined;
		const text = state.pendingText.trim();
		if (!text) return;
		const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;
		if (truncated === state.lastSentText) return;
		if (state.mode === "draft" && this.shouldUseDraft(chatId)) {
			const draftId = state.draftId ?? this.allocateDraftId();
			state.draftId = draftId;
			try {
				const body: Record<string, unknown> = { chat_id: chatId, draft_id: draftId, text: truncated };
				if (messageThreadId !== undefined) body.message_thread_id = messageThreadId;
				await this.callTelegram("sendMessageDraft", body);
				this.draftSupport = "supported";
				state.mode = "draft";
				state.lastSentText = truncated;
				return;
			} catch (error) {
				if (getTelegramRetryAfterMs(error) !== undefined) throw error;
				if (isDraftMethodUnsupported(error)) this.draftSupport = "unsupported";
				state.mode = "message";
			}
		}
		if (state.messageId === undefined) {
			const body: Record<string, unknown> = { chat_id: chatId, text: truncated };
			if (messageThreadId !== undefined) body.message_thread_id = messageThreadId;
			const sent = await this.callTelegram<TelegramSentMessage>("sendMessage", body);
			state.messageId = sent.message_id;
			state.mode = "message";
			state.lastSentText = truncated;
			this.onVisiblePreview?.(turnId, chatId, messageThreadId, sent.message_id);
			return;
		}
		try {
			await this.callTelegram("editMessageText", { chat_id: chatId, message_id: state.messageId, text: truncated });
		} catch (error) {
			if (isTelegramMessageNotModified(error)) {
				state.mode = "message";
				state.lastSentText = truncated;
				return;
			}
			if (isMissingEditableTelegramMessage(error)) {
				const body: Record<string, unknown> = { chat_id: chatId, text: truncated };
				if (messageThreadId !== undefined) body.message_thread_id = messageThreadId;
				const sent = await this.callTelegram<TelegramSentMessage>("sendMessage", body);
				state.messageId = sent.message_id;
				state.mode = "message";
				state.lastSentText = truncated;
				this.onVisiblePreview?.(turnId, chatId, messageThreadId, sent.message_id);
				return;
			}
			throw error;
		}
		state.mode = "message";
		state.lastSentText = truncated;
	}
}
