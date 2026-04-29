import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { formatTokens } from "../shared/format.js";
import type { ActiveTelegramTurn, BrokerLease, ModelSummary, TelegramRoute } from "../shared/types.js";

export function clientStatusText(options: {
	ctx: ExtensionContext | undefined;
	connectedRoute: TelegramRoute | undefined;
	sessionName?: string;
	lease?: BrokerLease;
	activeTelegramTurn?: ActiveTelegramTurn;
	queuedTurnCount: number;
	manualCompactionInProgress?: boolean;
}): string {
	const { ctx, connectedRoute, sessionName, lease, activeTelegramTurn, queuedTurnCount, manualCompactionInProgress } = options;
	const lines: string[] = [];
	if (connectedRoute) lines.push(`Project: ${connectedRoute.topicName}`);
	if (ctx?.cwd) lines.push(`CWD: ${ctx.cwd}`);
	if (sessionName) lines.push(`Session: ${sessionName}`);
	if (lease) lines.push(`Broker: pid ${lease.pid} epoch ${lease.leaseEpoch}`);
	if (ctx?.model) lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
	const busy = Boolean(activeTelegramTurn) || Boolean(manualCompactionInProgress) || (ctx ? !ctx.isIdle() : false);
	lines.push(`State: ${busy ? "busy" : "idle"}`);
	lines.push(`Queued: ${queuedTurnCount}`);

	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	if (ctx) {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const usage = entry.message.usage;
			totalInput += usage.input;
			totalOutput += usage.output;
			totalCacheRead += usage.cacheRead;
			totalCacheWrite += usage.cacheWrite;
			totalCost += usage.cost.total;
		}
	}
	const tokenParts: string[] = [];
	if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
	if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
	if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
	if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
	if (tokenParts.length > 0) lines.push(`Usage: ${tokenParts.join(" ")}`);
	const usingSubscription = ctx?.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	if (totalCost || usingSubscription) lines.push(`Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

	const usage = ctx?.getContextUsage();
	if (usage) {
		const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
		const contextWindow = Number.isFinite(usage.contextWindow) ? usage.contextWindow : (ctx?.model?.contextWindow ?? 0);
		lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
	} else {
		lines.push("Context: unknown");
	}
	return lines.join("\n");
}

export function clientQueryModels(ctx: ExtensionContext | undefined, filter?: string): { current?: string; models: ModelSummary[] } {
	if (!ctx) throw new Error("model_catalog_unavailable");
	const needle = (filter ?? "").toLowerCase();
	const models = ctx.modelRegistry.getAvailable().map((model) => ({
		provider: String(model.provider),
		id: model.id,
		name: model.name,
		input: model.input,
		reasoning: model.reasoning,
		label: `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` — ${model.name}` : ""}`,
	}));
	const filtered = needle ? models.filter((model) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle)) : models;
	return { current: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, models: filtered };
}

export async function clientSetModel(ctx: ExtensionContext | undefined, setModel: (model: Model<Api>) => Promise<boolean>, selector: string, options?: { exact?: boolean }): Promise<{ text: string }> {
	if (!ctx) return { text: "Model catalog unavailable." };
	const models = ctx.modelRegistry.getAvailable();
	let matches = models.filter((model) => `${model.provider}/${model.id}` === selector);
	if (matches.length === 0 && !options?.exact) {
		const needle = selector.toLowerCase();
		matches = models.filter((model) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle));
	}
	if (matches.length === 0) return { text: `Model not found: ${selector}` };
	if (matches.length > 1) return { text: `Ambiguous model selector. Matches:\n${matches.slice(0, 10).map((model) => `- ${model.provider}/${model.id}`).join("\n")}` };
	const previous = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
	const ok = await setModel(matches[0]);
	if (!ok) return { text: `Model auth unavailable: ${matches[0].provider}/${matches[0].id}` };
	return { text: `Model changed:\n${previous} → ${matches[0].provider}/${matches[0].id}` };
}
