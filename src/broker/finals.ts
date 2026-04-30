import { createHash } from "node:crypto";

import { chunkParagraphs } from "../shared/format.js";
import { formatAssistantFailureText } from "../shared/assistant-errors.js";
import type { AssistantFinalPayload, QueuedAttachment } from "../client/types.js";
import type { BrokerState, PendingAssistantFinalDelivery } from "./types.js";
import { isStaleBrokerError } from "./lease.js";
import { errorMessage, now } from "../shared/utils.js";
import { getTelegramRetryAfterMs } from "../telegram/api.js";
import { isTerminalTelegramFinalDeliveryError, terminalTelegramFinalDeliveryReason } from "../telegram/final-errors.js";
import { sendQueuedAttachment } from "../telegram/attachments.js";
import { isMissingDeletedTelegramMessage, shouldPreserveTelegramMessageRefOnDeleteFailure, shouldRetryTelegramMessageCleanup } from "../telegram/errors.js";
import { deleteTelegramMessage, sendTelegramMarkdownReply, sendTelegramTextReply, type TelegramJsonCall } from "../telegram/message-ops.js";
import type { PreviewManager } from "../telegram/previews.js";

const DEFAULT_FINAL_RETRY_MS = 1_000;

export interface AssistantFinalDeliveryDeps {
	getBrokerState: () => BrokerState | undefined;
	setBrokerState: (state: BrokerState) => void;
	loadBrokerState: () => Promise<BrokerState>;
	persistBrokerState: () => Promise<void>;
	activityComplete: (turnId: string) => Promise<void>;
	stopTypingLoop: (turnId: string) => void;
	previewManager: PreviewManager;
	callTelegram: <TResponse>(method: string, body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<TResponse>;
	callTelegramMultipart: <TResponse>(method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string, options?: { signal?: AbortSignal }) => Promise<TResponse>;
	isBrokerActive: () => boolean | Promise<boolean>;
	rememberCompletedBrokerTurn: (turnId: string) => Promise<void>;
	logTerminalFailure: (turnId: string, reason: string) => void;
}

export class AssistantFinalDeliveryLedger {
	private processing: Promise<void> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private active = true;
	private generation = 0;
	private abortController = new AbortController();
	private currentTurnId: string | undefined;
	private readonly cancelledTurnIds = new Set<string>();

	constructor(private readonly deps: AssistantFinalDeliveryDeps) {}

	start(): void {
		this.active = true;
		if (this.abortController.signal.aborted) this.abortController = new AbortController();
	}

	stop(): void {
		this.active = false;
		this.generation += 1;
		this.abortController.abort();
		this.clearTimer();
	}

	clearTimer(): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
	}

	async cancelSession(sessionId: string): Promise<void> {
		const state = await this.state();
		await this.cancelTurns(Object.values(state.pendingAssistantFinals ?? {})
			.filter((entry) => entry.turn.sessionId === sessionId)
			.map((entry) => entry.turn.turnId));
	}

	async cancelTurns(turnIds: string[]): Promise<void> {
		for (const turnId of turnIds) {
			this.cancelledTurnIds.add(turnId);
			if (this.currentTurnId === turnId) {
				this.abortController.abort();
				this.abortController = new AbortController();
			}
		}
	}

	async accept(payload: AssistantFinalPayload): Promise<{ ok: true }> {
		const state = await this.state();
		state.completedTurnIds ??= [];
		if (state.completedTurnIds.includes(payload.turn.turnId)) return { ok: true };
		state.pendingAssistantFinals ??= {};
		const existing = state.pendingAssistantFinals[payload.turn.turnId];
		if (existing) {
			// A repeated handoff after an ambiguous IPC result must not create a second
			// delivery job or restart visible Telegram output.
			this.kick();
			return { ok: true };
		}
		state.pendingAssistantFinals[payload.turn.turnId] = {
			...payload,
			attachments: payload.attachments ?? [],
			status: "pending",
			createdAtMs: now(),
			updatedAtMs: now(),
			progress: { sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] },
		};
		if (state.pendingTurns?.[payload.turn.turnId]) delete state.pendingTurns[payload.turn.turnId];
		await this.deps.persistBrokerState();
		this.kick();
		return { ok: true };
	}

	kick(): void {
		if (!this.active || this.processing) return;
		this.processing = this.process(this.generation).catch((error) => {
			if (isStaleBrokerError(error)) {
				this.stop();
				return;
			}
			console.warn(`[pi-telegram] Assistant final delivery failed: ${errorMessage(error)}`);
		}).finally(() => {
			this.processing = undefined;
		});
	}

	async drainReady(): Promise<void> {
		if (this.processing) await this.processing;
		else await this.process(this.generation);
	}

	private async process(generation: number): Promise<void> {
		if (!this.isActive(generation)) return;
		this.clearTimer();
		while (true) {
			if (!this.isActive(generation)) return;
			const entry = await this.nextEntry();
			if (!entry) return;
			const delay = (entry.retryAtMs ?? 0) - now();
			if (delay > 0) {
				this.retryTimer = setTimeout(() => this.kick(), delay);
				return;
			}
			try {
				this.currentTurnId = entry.turn.turnId;
				await this.assertCanDeliver(generation);
				entry.status = "delivering";
				entry.updatedAtMs = now();
				entry.retryAtMs = undefined;
				await this.deps.persistBrokerState();
				await this.deliver(entry);
				await this.complete(entry);
			} catch (error) {
				if (isStaleBrokerError(error)) {
					this.stop();
					return;
				}
				if (this.currentTurnId && this.cancelledTurnIds.has(this.currentTurnId)) {
					this.cancelledTurnIds.delete(this.currentTurnId);
					continue;
				}
				if (!this.isActive(generation) || error instanceof FinalDeliveryStoppedError) return;
				if (isTerminalTelegramFinalDeliveryError(error)) {
					entry.status = "terminal";
					entry.terminalReason = terminalTelegramFinalDeliveryReason(error);
					entry.updatedAtMs = now();
					this.deps.logTerminalFailure(entry.turn.turnId, entry.terminalReason);
					await this.complete(entry);
					continue;
				}
				entry.status = "pending";
				entry.retryAtMs = now() + (getTelegramRetryAfterMs(error) ?? DEFAULT_FINAL_RETRY_MS) + 250;
				entry.updatedAtMs = now();
				await this.deps.persistBrokerState();
				this.retryTimer = setTimeout(() => this.kick(), Math.max(0, entry.retryAtMs - now()));
				return;
			} finally {
				if (this.currentTurnId === entry.turn.turnId) this.currentTurnId = undefined;
			}
		}
	}

	private isActive(generation = this.generation): boolean {
		return this.active && generation === this.generation;
	}

	private assertActive(generation = this.generation): void {
		if (!this.isActive(generation)) throw new FinalDeliveryStoppedError();
	}

	private async assertCanDeliver(generation = this.generation): Promise<void> {
		this.assertActive(generation);
		if (this.currentTurnId && this.cancelledTurnIds.has(this.currentTurnId)) throw new FinalDeliveryCancelledError();
		if (!(await this.deps.isBrokerActive())) {
			this.stop();
			throw new FinalDeliveryStoppedError();
		}
	}

	private async nextEntry(): Promise<PendingAssistantFinalDelivery | undefined> {
		const state = await this.state();
		const entries = Object.values(state.pendingAssistantFinals ?? {}).sort((a, b) => a.createdAtMs - b.createdAtMs);
		return entries[0];
	}

	private async state(): Promise<BrokerState> {
		const existing = this.deps.getBrokerState();
		if (existing) return existing;
		const loaded = await this.deps.loadBrokerState();
		this.deps.setBrokerState(loaded);
		return loaded;
	}

	private async complete(entry: PendingAssistantFinalDelivery): Promise<void> {
		const state = await this.state();
		await this.deps.rememberCompletedBrokerTurn(entry.turn.turnId);
		if (state.pendingTurns?.[entry.turn.turnId]) delete state.pendingTurns[entry.turn.turnId];
		if (state.pendingAssistantFinals?.[entry.turn.turnId]) delete state.pendingAssistantFinals[entry.turn.turnId];
		if (!state.sessions[entry.turn.sessionId] && !Object.values(state.pendingAssistantFinals ?? {}).some((pending) => pending.turn.sessionId === entry.turn.sessionId)) {
			for (const [turnId, pending] of Object.entries(state.pendingTurns ?? {})) {
				if (pending.turn.sessionId !== entry.turn.sessionId) continue;
				const preview = state.assistantPreviewMessages?.[turnId];
				if (!preview) continue;
				try {
					await deleteTelegramMessage(this.deps.callTelegram, preview.chatId, preview.messageId, { ignoreMissing: true, signal: this.abortController.signal });
					delete state.assistantPreviewMessages?.[turnId];
				} catch (error) {
					if (shouldPreserveTelegramMessageRefOnDeleteFailure(error)) continue;
					delete state.assistantPreviewMessages?.[turnId];
				}
			}
			for (const [routeId, route] of Object.entries(state.routes)) {
				if (route.sessionId !== entry.turn.sessionId) continue;
				delete state.routes[routeId];
				if (route.messageThreadId === undefined) continue;
				state.pendingRouteCleanups ??= {};
				state.pendingRouteCleanups[route.routeId] = {
					route,
					createdAtMs: state.pendingRouteCleanups[route.routeId]?.createdAtMs ?? now(),
					updatedAtMs: now(),
				};
			}
		}
		await this.deps.persistBrokerState();
	}

	private async deliver(entry: PendingAssistantFinalDelivery): Promise<void> {
		const progress = entry.progress;
		await this.assertCanDeliver();
		if (!progress.activityCompleted) {
			await this.deps.activityComplete(entry.turn.turnId);
			progress.activityCompleted = true;
			entry.updatedAtMs = now();
			await this.deps.persistBrokerState();
		}
		await this.assertCanDeliver();
		if (!progress.typingStopped) {
			this.deps.stopTypingLoop(entry.turn.turnId);
			progress.typingStopped = true;
			entry.updatedAtMs = now();
			await this.deps.persistBrokerState();
		}
		await this.assertCanDeliver();
		if (entry.stopReason === "aborted") {
			await this.clearPreview(entry);
			return;
		}
		const finalText = entry.text?.trim();
		if (finalText) {
			await this.deliverText(entry, finalText);
			await this.deliverAttachments(entry);
			return;
		}
		if (entry.stopReason === "error") {
			await this.deliverText(entry, formatAssistantFailureText(entry.stopReason, entry.errorMessage));
			return;
		}
		if (entry.attachments.length > 0) {
			await this.deliverText(entry, "Attached requested file(s).");
			await this.deliverAttachments(entry);
			return;
		}
		await this.clearPreview(entry);
	}

	private async clearPreview(entry: PendingAssistantFinalDelivery): Promise<void> {
		await this.assertCanDeliver();
		if (entry.progress.previewCleared) return;
		await this.detachPreview(entry);
		if (entry.progress.previewMode === "message" && entry.progress.previewMessageId !== undefined) {
			await deleteTelegramMessage(this.deps.callTelegram, entry.turn.chatId, entry.progress.previewMessageId, { ignoreMissing: true, signal: this.abortController.signal });
		} else {
			await this.deps.previewManager.clear(entry.turn.turnId, entry.turn.chatId, entry.turn.messageThreadId);
		}
		entry.progress.previewCleared = true;
		entry.updatedAtMs = now();
		await this.deps.persistBrokerState();
	}

	private async detachPreview(entry: PendingAssistantFinalDelivery): Promise<void> {
		await this.assertCanDeliver();
		if (entry.progress.previewDetached) return;
		const detached = await this.deps.previewManager.detachForFinal(entry.turn.turnId);
		entry.progress.previewDetached = true;
		if (detached) {
			entry.progress.previewMode = detached.mode;
			entry.progress.previewMessageId = detached.messageId;
		}
		const state = await this.state();
		const durablePreview = state.assistantPreviewMessages?.[entry.turn.turnId];
		if (entry.progress.previewMessageId === undefined && durablePreview) {
			if (String(durablePreview.chatId) === String(entry.turn.chatId) && durablePreview.messageThreadId === entry.turn.messageThreadId) {
				entry.progress.previewMode = "message";
				entry.progress.previewMessageId = durablePreview.messageId;
			} else if (state.assistantPreviewMessages?.[entry.turn.turnId]) {
				delete state.assistantPreviewMessages[entry.turn.turnId];
			}
		}
		if (state.assistantPreviewMessages?.[entry.turn.turnId]) delete state.assistantPreviewMessages[entry.turn.turnId];
		entry.updatedAtMs = now();
		await this.deps.persistBrokerState();
	}

	private async deliverText(entry: PendingAssistantFinalDelivery, text: string): Promise<void> {
		const progress = entry.progress;
		const textHash = hashText(text);
		if (progress.textHash !== textHash) {
			progress.textHash = textHash;
			progress.chunks = chunkParagraphs(text || " ");
			progress.sentChunkIndexes ??= [];
			progress.sentChunkMessageIds ??= {};
			entry.updatedAtMs = now();
			await this.deps.persistBrokerState();
		}
		const chunks = progress.chunks ?? [];
		if (chunks.length === 0) return;
		const firstChunkWasPreviewEdit = wasFirstChunkDeliveredByPreviewEdit(progress);
		if (firstChunkWasPreviewEdit) {
			progress.legacyPreviewEditedFinalReset = true;
			progress.sentChunkIndexes = [];
			entry.updatedAtMs = now();
			await this.deps.persistBrokerState();
		}
		await this.cleanupPreviewBeforeFinal(entry);
		await this.cleanupLegacyPreviewEditedFinalChunks(entry);
		for (let index = 0; index < chunks.length; index += 1) {
			if (progress.sentChunkIndexes?.includes(index)) continue;
			await this.assertCanDeliver();
			const messageId = index === 0 ? await this.deliverFirstChunk(entry, chunks[index]!) : await this.sendMarkdownMessage(entry, chunks[index]!);
			progress.sentChunkIndexes ??= [];
			progress.sentChunkMessageIds ??= {};
			progress.sentChunkIndexes.push(index);
			if (messageId !== undefined) progress.sentChunkMessageIds[String(index)] = messageId;
			entry.updatedAtMs = now();
			await this.deps.persistBrokerState();
		}
	}

	private async deliverFirstChunk(entry: PendingAssistantFinalDelivery, chunk: string): Promise<number | undefined> {
		await this.cleanupPreviewBeforeFinal(entry);
		return await this.sendMarkdownMessage(entry, chunk);
	}

	private async cleanupPreviewBeforeFinal(entry: PendingAssistantFinalDelivery): Promise<void> {
		await this.assertCanDeliver();
		await this.detachPreview(entry);
		const progress = entry.progress;
		if (progress.previewCleanupDone) return;
		if (progress.previewMode === "message" && progress.previewMessageId !== undefined) {
			try {
				await deleteTelegramMessage(this.deps.callTelegram, entry.turn.chatId, progress.previewMessageId, { ignoreMissing: true, signal: this.abortController.signal });
				progress.previewCleared = true;
			} catch (error) {
				if (isMissingDeletedTelegramMessage(error)) {
					progress.previewCleared = true;
				} else if (shouldRetryTelegramMessageCleanup(error)) {
					throw error;
				} else {
					progress.previewCleanupTerminalReason = finalDeliveryErrorMessage(error);
				}
			}
		}
		progress.previewCleanupDone = true;
		entry.updatedAtMs = now();
		await this.deps.persistBrokerState();
	}

	private async cleanupLegacyPreviewEditedFinalChunks(entry: PendingAssistantFinalDelivery): Promise<void> {
		const progress = entry.progress;
		if (!progress.legacyPreviewEditedFinalReset) return;
		for (const [index, messageId] of Object.entries(progress.sentChunkMessageIds ?? {})) {
			if (index === "0" || messageId === progress.previewMessageId) continue;
			await this.assertCanDeliver();
			try {
				await deleteTelegramMessage(this.deps.callTelegram, entry.turn.chatId, messageId, { ignoreMissing: true, signal: this.abortController.signal });
			} catch (error) {
				if (isMissingDeletedTelegramMessage(error)) continue;
				if (shouldRetryTelegramMessageCleanup(error)) throw error;
				progress.previewCleanupTerminalReason = progress.previewCleanupTerminalReason
					? `${progress.previewCleanupTerminalReason}; ${finalDeliveryErrorMessage(error)}`
					: finalDeliveryErrorMessage(error);
			}
		}
		progress.sentChunkMessageIds = {};
		progress.legacyPreviewEditedFinalReset = false;
		entry.updatedAtMs = now();
		await this.deps.persistBrokerState();
	}

	private async sendMarkdownMessage(entry: PendingAssistantFinalDelivery, text: string): Promise<number | undefined> {
		const callTelegram: TelegramJsonCall = async (method, body) => {
			await this.assertCanDeliver();
			return await this.deps.callTelegram(method, body, { signal: this.abortController.signal });
		};
		return await sendTelegramMarkdownReply(callTelegram, entry.turn.chatId, entry.turn.messageThreadId, text, { signal: this.abortController.signal });
	}


	private async deliverAttachments(entry: PendingAssistantFinalDelivery): Promise<void> {
		entry.progress.sentAttachmentIndexes ??= [];
		for (let index = 0; index < entry.attachments.length; index += 1) {
			if (entry.progress.sentAttachmentIndexes.includes(index)) continue;
			await this.assertCanDeliver();
			const attachment = entry.attachments[index] as QueuedAttachment;
			await sendQueuedAttachment({
				turn: entry.turn,
				attachment,
				callTelegramMultipart: async (method, fields, fileField, filePath, fileName) => {
					await this.assertCanDeliver();
					return await this.deps.callTelegramMultipart(method, fields, fileField, filePath, fileName, { signal: this.abortController.signal });
				},
				sendTextReply: (chatId, messageThreadId, text) => this.sendPlainTextReply(chatId, messageThreadId, text),
			});
			entry.progress.sentAttachmentIndexes.push(index);
			entry.updatedAtMs = now();
			await this.deps.persistBrokerState();
		}
	}

	private async sendPlainTextReply(chatId: number | string, messageThreadId: number | undefined, text: string): Promise<number | undefined> {
		const callTelegram: TelegramJsonCall = async (method, body) => {
			await this.assertCanDeliver();
			return await this.deps.callTelegram(method, body, { signal: this.abortController.signal });
		};
		return await sendTelegramTextReply(callTelegram, chatId, messageThreadId, text, { signal: this.abortController.signal });
	}
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function wasFirstChunkDeliveredByPreviewEdit(progress: PendingAssistantFinalDelivery["progress"]): boolean {
	return progress.previewCleanupDone !== true
		&& progress.previewMode === "message"
		&& progress.previewMessageId !== undefined
		&& (progress.sentChunkIndexes ?? []).includes(0)
		&& progress.sentChunkMessageIds?.["0"] === progress.previewMessageId;
}

class FinalDeliveryStoppedError extends Error {
	constructor() {
		super("Final delivery stopped");
		this.name = "FinalDeliveryStoppedError";
	}
}

class FinalDeliveryCancelledError extends Error {
	constructor() {
		super("Final delivery cancelled");
		this.name = "FinalDeliveryCancelledError";
	}
}

export function finalDeliveryErrorMessage(error: unknown): string {
	return isTerminalTelegramFinalDeliveryError(error) ? terminalTelegramFinalDeliveryReason(error) : errorMessage(error);
}
