import type { ExtensionAPI, ExtensionContext, ExtensionHandler, RegisteredCommand, ToolDefinition } from "@mariozechner/pi-coding-agent";

import { ActivityReporter } from "../../src/broker/activity.js";
import type { RuntimePiHooksDeps } from "../../src/pi/hooks.js";
import type { ActiveTelegramTurn, TelegramRoute } from "../../src/shared/types.js";

export type HookHandler = (event: unknown, ctx?: ExtensionContext) => Promise<unknown>;

export interface PiHarness {
	handlers: Map<string, HookHandler[]>;
	tools: ToolDefinition[];
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	pi: ExtensionAPI;
}

export function activeTurn(id = "turn-1"): ActiveTelegramTurn {
	return {
		turnId: id,
		sessionId: "session-1",
		chatId: 123,
		messageThreadId: 9,
		replyToMessageId: 0,
		queuedAttachments: [],
		content: [],
		historyText: "",
	};
}

export function route(): TelegramRoute {
	return {
		routeId: "123:9",
		sessionId: "session-1",
		chatId: 123,
		messageThreadId: 9,
		routeMode: "forum_supergroup_topic",
		topicName: "topic",
		createdAtMs: 1,
		updatedAtMs: 1,
	};
}

export function testExtensionContext(): ExtensionContext {
	return { abort: () => undefined, ui: { theme: {} } } as ExtensionContext;
}

export function buildPiHarness(): PiHarness {
	const handlers = new Map<string, HookHandler[]>();
	const tools: ToolDefinition[] = [];
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const pi = {
		registerTool: (tool: ToolDefinition) => { tools.push(tool); },
		registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => { commands.set(name, options); },
		on: (event: string, handler: ExtensionHandler<unknown, unknown>) => {
			const list = handlers.get(event) ?? [];
			list.push(async (payload, ctx = testExtensionContext()) => await handler(payload, ctx));
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	return { handlers, tools, commands, pi };
}

export async function invokeHook(handlers: Map<string, HookHandler[]>, event: string, payload: unknown, ctx: ExtensionContext = testExtensionContext()): Promise<unknown> {
	return await (handlers.get(event)?.[0]?.(payload, ctx) ?? Promise.resolve());
}

export function noopActivityReporter(): ActivityReporter {
	return new ActivityReporter(async () => undefined);
}

export function recordingActivityReporter(calls: Array<{ type: string; payload: unknown }>): ActivityReporter {
	return new ActivityReporter(async (payload) => { calls.push({ type: "activity_update", payload }); });
}

export function baseDeps(overrides: Partial<RuntimePiHooksDeps> = {}): RuntimePiHooksDeps {
	return {
		getConfig: () => ({}),
		setLatestCtx: () => undefined,
		getConnectedRoute: () => route(),
		getActiveTelegramTurn: () => undefined,
		hasDeferredTelegramTurn: () => false,
		hasAwaitingTelegramFinalTurn: () => false,
		hasLiveAgentRun: () => false,
		flushDeferredTelegramTurn: async () => undefined,
		setActiveTelegramTurn: () => undefined,
		setQueuedTelegramTurns: () => undefined,
		setCurrentAbort: () => undefined,
		getSessionId: () => "session-1",
		getOwnerId: () => "owner-1",
		getIsBroker: () => false,
		getBrokerState: () => undefined,
		getConnectedBrokerSocketPath: () => "/tmp/broker.sock",
		activityReporter: noopActivityReporter(),
		isRoutableRoute: (candidate): candidate is TelegramRoute => Boolean(candidate),
		resolveAllowedAttachmentPath: async () => undefined,
		postIpc: async <TResponse>() => undefined as TResponse,
		promptForConfig: async () => false,
		connectTelegram: async () => undefined,
		disconnectSessionRoute: async () => undefined,
		prepareSessionReplacementHandoff: async () => false,
		stopClientServer: async () => undefined,
		shutdownClientRoute: () => undefined,
		stopBroker: async () => undefined,
		hideTelegramStatus: () => undefined,
		updateStatus: () => undefined,
		readLease: async () => undefined,
		finalizeActiveTelegramTurn: async () => "completed",
		onAgentRetryStart: () => undefined,
		onRetryMessageStart: () => undefined,
		startNextTelegramTurn: () => undefined,
		drainDeferredCompactionTurns: () => undefined,
		onSessionStart: async () => undefined,
		clearMediaGroups: () => undefined,
		...overrides,
	};
}

export type RegisteredHookTool = ToolDefinition;
