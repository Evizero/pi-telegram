import { MODEL_LIST_TTL_MS } from "../shared/config.js";
import type { InlineKeyboardMarkup, ModelSummary, TelegramInlineKeyboardButton, TelegramModelPickerGroup, TelegramModelPickerState, TelegramRoute } from "../shared/types.js";
import { now, randomId } from "../shared/utils.js";

export const MODEL_PICKER_CALLBACK_PREFIX = "mp1";
export const MODEL_PICKER_BUTTON_LIMIT = 10;
const MODEL_PICKER_PAGE_SIZE = MODEL_PICKER_BUTTON_LIMIT - 1;

export type ModelPickerCallback =
	| { kind: "providers"; token: string; page: number }
	| { kind: "models"; token: string; groupIndex: number; page: number }
	| { kind: "select"; token: string; modelIndex: number };

export interface RenderedModelPicker {
	text: string;
	replyMarkup: InlineKeyboardMarkup;
}

export function createModelPickerState(route: TelegramRoute, current: string | undefined, models: ModelSummary[], messageId?: number): TelegramModelPickerState {
	const groups = buildModelGroups(models);
	const createdAtMs = now();
	return {
		token: randomId("mp").replace(/[^A-Za-z0-9_-]/g, ""),
		sessionId: route.sessionId,
		routeId: route.routeId,
		chatId: route.chatId,
		messageThreadId: route.messageThreadId,
		messageId,
		current,
		models,
		groups,
		createdAtMs,
		updatedAtMs: createdAtMs,
		expiresAtMs: createdAtMs + MODEL_LIST_TTL_MS,
	};
}

export function shouldShowProviderStage(state: TelegramModelPickerState): boolean {
	return state.groups.length > 1 && hasModelIdOverlapAcrossProviders(state.models);
}

export function renderInitialModelPicker(state: TelegramModelPickerState): RenderedModelPicker {
	if (shouldShowProviderStage(state)) return renderProviderPicker(state, 0);
	return renderModelPicker(state, 0, 0);
}

export function renderProviderPicker(state: TelegramModelPickerState, page: number): RenderedModelPicker {
	const normalizedPage = normalizePage(page, state.groups.length);
	const { start, items, hasMore } = pageItems(state.groups, normalizedPage);
	const rows = items.map((group, offset) => [button(group.label, providerCallbackData(state.token, normalizedPage, start + offset))]);
	if (hasMore) rows.push([button("More", providersPageCallbackData(state.token, normalizedPage + 1))]);
	return {
		text: [`Current: ${state.current ?? "unknown"}`, "", "Choose a model subscription/provider:"].join("\n"),
		replyMarkup: { inline_keyboard: rows },
	};
}

export function renderModelPicker(state: TelegramModelPickerState, groupIndex: number, page: number): RenderedModelPicker {
	const group = state.groups[groupIndex] ?? state.groups[0];
	const resolvedGroupIndex = state.groups.indexOf(group);
	const normalizedPage = normalizePage(page, group.modelIndexes.length);
	const { start, items, hasMore } = pageItems(group.modelIndexes, normalizedPage);
	const rows = items.map((modelIndex) => [button(modelButtonText(state.models[modelIndex]!, shouldShowProviderStage(state)), selectCallbackData(state.token, modelIndex))]);
	if (hasMore) rows.push([button("More", modelsPageCallbackData(state.token, resolvedGroupIndex, normalizedPage + 1))]);
	const scope = shouldShowProviderStage(state) ? [`Provider: ${group.label}`, ""] : [];
	return {
		text: [`Current: ${state.current ?? "unknown"}`, "", ...scope, "Choose a model:"].join("\n"),
		replyMarkup: { inline_keyboard: rows },
	};
}

export function parseModelPickerCallback(data: string | undefined): ModelPickerCallback | undefined {
	if (!data) return undefined;
	const parts = data.split(":");
	if (parts[0] !== MODEL_PICKER_CALLBACK_PREFIX || !parts[1] || !parts[2]) return undefined;
	const token = parts[1];
	if (parts[2] === "providers") {
		const page = parseNonNegativeInt(parts[3]);
		return page === undefined ? undefined : { kind: "providers", token, page };
	}
	if (parts[2] === "models") {
		const groupIndex = parseNonNegativeInt(parts[3]);
		const page = parseNonNegativeInt(parts[4]);
		return groupIndex === undefined || page === undefined ? undefined : { kind: "models", token, groupIndex, page };
	}
	if (parts[2] === "select") {
		const modelIndex = parseNonNegativeInt(parts[3]);
		return modelIndex === undefined ? undefined : { kind: "select", token, modelIndex };
	}
	return undefined;
}

export function isModelPickerCallbackData(data: string | undefined): boolean {
	return data?.startsWith(`${MODEL_PICKER_CALLBACK_PREFIX}:`) ?? false;
}

export function exactModelSelector(model: ModelSummary): string {
	return `${model.provider}/${model.id}`;
}

function buildModelGroups(models: ModelSummary[]): TelegramModelPickerGroup[] {
	const groups = new Map<string, TelegramModelPickerGroup>();
	models.forEach((model, index) => {
		let group = groups.get(model.provider);
		if (!group) {
			group = { provider: model.provider, label: providerButtonText(model.provider, models), modelIndexes: [] };
			groups.set(model.provider, group);
		}
		group.modelIndexes.push(index);
	});
	return [...groups.values()];
}

function hasModelIdOverlapAcrossProviders(models: ModelSummary[]): boolean {
	const providersById = new Map<string, Set<string>>();
	for (const model of models) {
		let providers = providersById.get(model.id);
		if (!providers) {
			providers = new Set();
			providersById.set(model.id, providers);
		}
		providers.add(model.provider);
		if (providers.size > 1) return true;
	}
	return false;
}

function providerButtonText(provider: string, allModels: ModelSummary[]): string {
	const providerModels = allModels.filter((model) => model.provider === provider);
	const suffixLabel = providerModels.map((model) => subscriptionLabelFromModelName(model.name)).find((label): label is string => Boolean(label));
	if (suffixLabel) return truncateButtonText(`${suffixLabel} — ${provider}`);
	const cloneMatch = provider.match(/^(.+)-(\d+)$/);
	if (cloneMatch && allModels.some((model) => model.provider === cloneMatch[1])) return truncateButtonText(`#${cloneMatch[2]} — ${provider}`);
	if (allModels.some((model) => model.provider !== provider && model.provider.startsWith(`${provider}-`))) return truncateButtonText(`base — ${provider}`);
	return truncateButtonText(provider);
}

function subscriptionLabelFromModelName(name: string): string | undefined {
	const match = name.match(/\(#\d+\s+([^)]*?)\)$/);
	return match?.[1]?.trim() || undefined;
}

function modelButtonText(model: ModelSummary, scopedToProvider: boolean): string {
	let name = model.name.replace(/\s*\(#\d+(?:\s+[^)]*)?\)$/, "").trim();
	if (!name || name === model.id) name = model.id;
	const text = scopedToProvider ? name : `${name} — ${model.provider}`;
	return truncateButtonText(text);
}

function truncateButtonText(text: string): string {
	return text.length <= 64 ? text : `${text.slice(0, 61)}…`;
}

function pageItems<T>(items: T[], page: number): { start: number; items: T[]; hasMore: boolean } {
	const start = page * MODEL_PICKER_PAGE_SIZE;
	const pageItems = items.slice(start, start + MODEL_PICKER_PAGE_SIZE);
	return { start, items: pageItems, hasMore: start + MODEL_PICKER_PAGE_SIZE < items.length };
}

function normalizePage(page: number, totalItems: number): number {
	if (totalItems <= 0) return 0;
	const maxPage = Math.floor((totalItems - 1) / MODEL_PICKER_PAGE_SIZE);
	return Math.min(Math.max(page, 0), maxPage);
}

function button(text: string, callbackData: string): TelegramInlineKeyboardButton {
	return { text, callback_data: callbackData };
}

function providersPageCallbackData(token: string, page: number): string {
	return `${MODEL_PICKER_CALLBACK_PREFIX}:${token}:providers:${page}`;
}

function providerCallbackData(token: string, _page: number, groupIndex: number): string {
	return `${MODEL_PICKER_CALLBACK_PREFIX}:${token}:models:${groupIndex}:0`;
}

function modelsPageCallbackData(token: string, groupIndex: number, page: number): string {
	return `${MODEL_PICKER_CALLBACK_PREFIX}:${token}:models:${groupIndex}:${page}`;
}

function selectCallbackData(token: string, modelIndex: number): string {
	return `${MODEL_PICKER_CALLBACK_PREFIX}:${token}:select:${modelIndex}`;
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}
