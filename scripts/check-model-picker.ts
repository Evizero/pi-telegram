import assert from "node:assert/strict";

import { createModelPickerState, parseModelPickerCallback, renderInitialModelPicker, renderModelPicker } from "../src/broker/model-picker.js";
import type { ModelSummary, TelegramRoute } from "../src/shared/types.js";

function route(): TelegramRoute {
	return {
		routeId: "123:9",
		sessionId: "session-1",
		chatId: 123,
		messageThreadId: 9,
		routeMode: "forum_supergroup_topic",
		topicName: "project · main",
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
	};
}

function model(provider: string, id: string, name = id): ModelSummary {
	return { provider, id, name, input: ["text"], reasoning: true, label: `${provider}/${id} — ${name}` };
}

function checkFlatPickerSkipsProviderStageForSingleGroup(): void {
	const state = createModelPickerState(route(), "openai/gpt-5", [model("openai", "gpt-5"), model("openai", "gpt-5-mini")]);
	const rendered = renderInitialModelPicker(state);
	assert.equal(rendered.text.includes("Choose a model:"), true);
	assert.equal(rendered.text.includes("subscription/provider"), false);
	assert.equal(rendered.replyMarkup.inline_keyboard.length, 2);
}

function checkOverlappingProvidersUseProviderStage(): void {
	const state = createModelPickerState(route(), "openai-codex/gpt-5.5", [
		model("openai-codex", "gpt-5.5", "GPT 5.5"),
		model("openai-codex-2", "gpt-5.5", "GPT 5.5 (#2 private)"),
	]);
	const rendered = renderInitialModelPicker(state);
	assert.equal(rendered.text.includes("Choose a model subscription/provider"), true);
	assert.equal(rendered.replyMarkup.inline_keyboard[0]?.[0]?.text, "base — openai-codex");
	assert.equal(rendered.replyMarkup.inline_keyboard[1]?.[0]?.text, "private — openai-codex-2");
}

function checkPaginationReservesLastButtonForMore(): void {
	const models = Array.from({ length: 11 }, (_value, index) => model("openai", `model-${index + 1}`));
	const state = createModelPickerState(route(), undefined, models);
	const firstPage = renderModelPicker(state, 0, 0);
	assert.equal(firstPage.replyMarkup.inline_keyboard.length, 10);
	const lastFirstPageButton = firstPage.replyMarkup.inline_keyboard.at(-1)?.[0];
	assert.equal(lastFirstPageButton?.text, "More");
	const callback = parseModelPickerCallback(lastFirstPageButton?.callback_data);
	assert.deepEqual(callback, { kind: "models", token: state.token, groupIndex: 0, page: 1 });
	const secondPage = renderModelPicker(state, 0, 1);
	assert.equal(secondPage.replyMarkup.inline_keyboard.length, 2);
	assert.equal(secondPage.replyMarkup.inline_keyboard.some((row) => row[0]?.text === "More"), false);
}

checkFlatPickerSkipsProviderStageForSingleGroup();
checkOverlappingProvidersUseProviderStage();
checkPaginationReservesLastButtonForMore();
console.log("Model picker checks passed");
