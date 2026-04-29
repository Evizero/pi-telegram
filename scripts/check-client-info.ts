import assert from "node:assert/strict";

import { clientSetModel } from "../src/client/info.js";
import { contextWithModels, modelFixture } from "./support/model-fixtures.js";

async function checkExactModelSelectionDoesNotFallbackToFuzzyMatch(): Promise<void> {
	const selected: string[] = [];
	const result = await clientSetModel(
		contextWithModels([modelFixture({ provider: "openai", id: "gpt-5-mini", name: "GPT 5 mini" })]),
		async (model) => {
			selected.push(`${model.provider}/${model.id}`);
			return true;
		},
		"openai/gpt-5",
		{ exact: true },
	);
	assert.deepEqual(result, { text: "Model not found: openai/gpt-5" });
	assert.deepEqual(selected, []);
}

async function checkTextSelectorStillAllowsFuzzyMatch(): Promise<void> {
	const selected: string[] = [];
	const result = await clientSetModel(
		contextWithModels([modelFixture({ provider: "openai", id: "gpt-5-mini", name: "GPT 5 mini" })], modelFixture({ provider: "openai", id: "gpt-4", name: "GPT 4" })),
		async (model) => {
			selected.push(`${model.provider}/${model.id}`);
			return true;
		},
		"gpt-5",
	);
	assert.equal(result.text, "Model changed:\nopenai/gpt-4 → openai/gpt-5-mini");
	assert.deepEqual(selected, ["openai/gpt-5-mini"]);
}

await checkExactModelSelectionDoesNotFallbackToFuzzyMatch();
await checkTextSelectorStillAllowsFuzzyMatch();
console.log("Client info checks passed");
