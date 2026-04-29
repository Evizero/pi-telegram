import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export function modelFixture(overrides: Partial<Model<Api>> & Pick<Model<Api>, "provider" | "id" | "name">): Model<Api> {
	return {
		api: "openai-responses",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...overrides,
	};
}

export function contextWithModels(models: Model<Api>[], current?: Model<Api>): ExtensionContext {
	return {
		model: current,
		modelRegistry: {
			getAvailable: () => models,
			isUsingOAuth: () => false,
		},
	} as unknown as ExtensionContext;
}
