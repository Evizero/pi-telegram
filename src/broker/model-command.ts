import { MODEL_LIST_TTL_MS } from "./policy.js";
import type { ModelSummary } from "../client/types.js";
import type { TelegramCallbackQuery } from "../telegram/types.js";
import type { BrokerState, SessionRegistration, TelegramModelPickerState, TelegramRoute } from "./types.js";
import { errorMessage, now } from "../shared/utils.js";
import type { TelegramCommandRouterDeps } from "./command-types.js";
import { createModelPickerState, exactModelSelector, parseModelPickerCallback, renderInitialModelPicker, renderModelPicker, renderProviderPicker } from "./model-picker.js";
import { answerControlCallback, callbackMatchesControlMessage, controlRouteStillValid, tryEditCallbackMessage, tryEditControlMessage, tryEditOrSendControlResult, trySendControlReply } from "./inline-controls.js";

const COMPLETED_MODEL_PICKER_TTL_MS = 24 * 60 * 60 * 1000;

export class TelegramModelCommandHandler {
	private readonly modelListCache = new Map<string, { expiresAt: number; models: ModelSummary[] }>();

	constructor(private readonly deps: TelegramCommandRouterDeps) {}

	async handleCommand(route: TelegramRoute, session: SessionRegistration, text: string): Promise<void> {
		const args = text.trim().split(/\s+/).slice(1);
		if (args.length === 0) {
			const result = await this.queryModels(session, {});
			if (result.models.length === 0) {
				await trySendControlReply(this.deps, route.chatId, route.messageThreadId, `Current: ${result.current ?? "unknown"}\n\nNo available models matched.`);
				return;
			}
			this.modelListCache.set(`${route.routeId}:${route.sessionId}`, { expiresAt: now() + MODEL_LIST_TTL_MS, models: result.models.slice(0, 30) });
			const picker = createModelPickerState(route, result.current, result.models);
			this.captureSelectorFreshness(route, picker);
			const rendered = renderInitialModelPicker(picker);
			const messageId = await this.deps.sendTextReply(route.chatId, route.messageThreadId, rendered.text, { replyMarkup: rendered.replyMarkup });
			picker.messageId = messageId;
			const brokerState = this.deps.getBrokerState();
			if (brokerState) {
				brokerState.modelPickers ??= {};
				brokerState.modelPickers[picker.token] = picker;
				this.prune(brokerState);
				await this.deps.persistBrokerState();
			}
			return;
		}
		if (args[0]?.toLowerCase() === "list") {
			const filter = args.slice(1).join(" ").trim();
			const result = await this.queryModels(session, { filter });
			const shownModels = result.models.slice(0, 30);
			this.modelListCache.set(`${route.routeId}:${route.sessionId}`, { expiresAt: now() + MODEL_LIST_TTL_MS, models: shownModels });
			const lines = [`Current: ${result.current ?? "unknown"}`, ""];
			if (shownModels.length === 0) lines.push("No available models matched.");
			else shownModels.forEach((model, index) => lines.push(`${index + 1}. ${model.label}`));
			await trySendControlReply(this.deps, route.chatId, route.messageThreadId, lines.join("\n"));
			return;
		}
		let selector = args.join(" ").trim();
		const numericSelection = /^\d+$/.test(selector);
		if (numericSelection) {
			const cache = this.modelListCache.get(`${route.routeId}:${route.sessionId}`);
			const index = Number(selector) - 1;
			if (!cache || cache.expiresAt < now() || !cache.models[index]) {
				await trySendControlReply(this.deps, route.chatId, route.messageThreadId, "Model list expired or number not found. Send /model first.");
				return;
			}
			selector = `${cache.models[index].provider}/${cache.models[index].id}`;
		}
		const setModelPayload = numericSelection ? { selector, exact: true } : { selector };
		const result = await this.setModel(session, setModelPayload);
		await trySendControlReply(this.deps, route.chatId, route.messageThreadId, result.text);
	}

	async handleCallback(query: TelegramCallbackQuery): Promise<boolean> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return true;
		const callback = parseModelPickerCallback(query.data);
		if (!callback) {
			await answerControlCallback(this.deps, query.id, "This model picker button is invalid.", true);
			return true;
		}
		const picker = brokerState.modelPickers?.[callback.token];
		if (!picker) {
			await answerControlCallback(this.deps, query.id, "Model picker expired. Send /model again.", true);
			await tryEditCallbackMessage(this.deps, query, "Model picker expired. Send /model again.");
			return true;
		}
		if (!callbackMatchesControlMessage(query, picker) || !controlRouteStillValid(brokerState, picker, { requireSelectorFreshness: true })) {
			await answerControlCallback(this.deps, query.id, "This model picker no longer matches the active session. Send /model again.", true);
			return true;
		}
		if (picker.completedText && this.completedPickerStillRetryable(picker)) {
			await this.finishCompletedPicker(query, picker, picker.completedText);
			return true;
		}
		if (picker.expiresAtMs < now()) {
			delete brokerState.modelPickers![callback.token];
			await this.deps.persistBrokerState();
			await answerControlCallback(this.deps, query.id, "Model picker expired. Send /model again.", true);
			await tryEditCallbackMessage(this.deps, query, "Model picker expired. Send /model again.");
			return true;
		}
		picker.updatedAtMs = now();
		if (callback.kind === "providers") {
			const rendered = renderProviderPicker(picker, callback.page);
			await this.deps.persistBrokerState();
			await tryEditControlMessage(this.deps, picker, query, rendered.text, rendered.replyMarkup);
			await answerControlCallback(this.deps, query.id);
			return true;
		}
		if (callback.kind === "models") {
			const rendered = renderModelPicker(picker, callback.groupIndex, callback.page);
			await this.deps.persistBrokerState();
			await tryEditControlMessage(this.deps, picker, query, rendered.text, rendered.replyMarkup);
			await answerControlCallback(this.deps, query.id);
			return true;
		}
		await this.selectModelFromPicker(query, picker, callback.modelIndex);
		return true;
	}

	prune(brokerState: BrokerState): boolean {
		let changed = false;
		for (const [token, picker] of Object.entries(brokerState.modelPickers ?? {})) {
			if (brokerState.sessions[picker.sessionId] && (picker.expiresAtMs > now() || (picker.completedText && this.completedPickerStillRetryable(picker)))) continue;
			delete brokerState.modelPickers![token];
			changed = true;
		}
		return changed;
	}

	private captureSelectorFreshness(route: TelegramRoute, picker: TelegramModelPickerState): void {
		if (route.routeMode !== "single_chat_selector") return;
		const selection = this.deps.getBrokerState()?.selectorSelections?.[String(route.chatId)];
		picker.selectorSelectionUpdatedAtMs = selection?.updatedAtMs;
		picker.selectorSelectionExpiresAtMs = selection?.expiresAtMs;
	}

	private async selectModelFromPicker(query: TelegramCallbackQuery, picker: TelegramModelPickerState, modelIndex: number): Promise<void> {
		const brokerState = this.deps.getBrokerState();
		const session = brokerState?.sessions[picker.sessionId];
		const model = picker.models[modelIndex];
		if (!brokerState || !session || session.status === "offline" || !model) {
			if (brokerState?.modelPickers?.[picker.token]) delete brokerState.modelPickers[picker.token];
			await this.deps.persistBrokerState();
			await answerControlCallback(this.deps, query.id, "Model picker expired. Send /model again.", true);
			await tryEditCallbackMessage(this.deps, query, "Model picker expired. Send /model again.");
			return;
		}
		const selector = exactModelSelector(model);
		let result: { text: string };
		try {
			result = await this.deps.postIpc<{ text: string }>(session.clientSocketPath, "set_model", { selector, exact: true }, session.sessionId);
		} catch (error) {
			session.status = "offline";
			delete brokerState.modelPickers?.[picker.token];
			await this.deps.persistBrokerState();
			await answerControlCallback(this.deps, query.id, "Failed to change model.", true);
			await trySendControlReply(this.deps, picker.chatId, picker.messageThreadId, `Failed to change model: ${errorMessage(error)}`);
			return;
		}
		picker.completedText = result.text;
		picker.selectedAtMs = now();
		picker.updatedAtMs = now();
		picker.expiresAtMs = now() + MODEL_LIST_TTL_MS;
		await this.deps.persistBrokerState();
		await this.finishCompletedPicker(query, picker, result.text);
	}

	private async finishCompletedPicker(query: TelegramCallbackQuery, picker: TelegramModelPickerState, text: string): Promise<void> {
		await tryEditOrSendControlResult(this.deps, picker, query, text);
		await answerControlCallback(this.deps, query.id, "Model selection handled.");
		const brokerState = this.deps.getBrokerState();
		if (brokerState?.modelPickers?.[picker.token]) delete brokerState.modelPickers[picker.token];
		await this.deps.persistBrokerState();
	}

	private completedPickerStillRetryable(picker: TelegramModelPickerState): boolean {
		return (picker.selectedAtMs ?? picker.updatedAtMs) + COMPLETED_MODEL_PICKER_TTL_MS > now();
	}

	private async queryModels(session: SessionRegistration, payload: { filter?: string }): Promise<{ current?: string; models: ModelSummary[] }> {
		try {
			return await this.deps.postIpc<{ current?: string; models: ModelSummary[] }>(session.clientSocketPath, "query_models", payload, session.sessionId);
		} catch (error) {
			session.status = "offline";
			await this.deps.persistBrokerState();
			throw error;
		}
	}

	private async setModel(session: SessionRegistration, payload: { selector: string; exact?: boolean }): Promise<{ text: string }> {
		try {
			return await this.deps.postIpc<{ text: string }>(session.clientSocketPath, "set_model", payload, session.sessionId);
		} catch (error) {
			session.status = "offline";
			await this.deps.persistBrokerState();
			throw error;
		}
	}
}
