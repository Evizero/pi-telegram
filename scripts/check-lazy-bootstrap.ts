import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { registerTelegramBootstrap } from "../src/bootstrap.js";
import type { TelegramRuntime } from "../src/extension.js";
import { baseDeps, buildPiHarness, testExtensionContext } from "./support/pi-hook-fixtures.js";

function commandContext(overrides: Record<string, unknown> = {}) {
	const notifications: string[] = [];
	return {
		...testExtensionContext(),
		cwd: "/tmp/pi-telegram-lazy-bootstrap",
		ui: {
			theme: {},
			notify: (message: string) => { notifications.push(message); },
			setStatus: () => undefined,
		},
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => "/tmp/pi-telegram-lazy-bootstrap/session.json",
		},
		isIdle: () => true,
		abort: () => undefined,
		notifications,
		...overrides,
	} as never;
}

function fakeRuntime(overrides: Parameters<typeof baseDeps>[0] = {}): TelegramRuntime {
	return { hooks: baseDeps(overrides), isConnected: () => false };
}

function checkEntrypointUsesBootstrapOnly(): void {
	const index = readFileSync("index.ts", "utf8");
	assert.match(index, /registerTelegramBootstrap/);
	assert.doesNotMatch(index, /src\/extension/);
	const bootstrap = readFileSync("src/bootstrap.ts", "utf8");
	assert.match(bootstrap, /import\("\.\/extension\.js"\)/);
	assert.doesNotMatch(bootstrap, /registerRuntimePiHooks/);
}

async function checkBootstrapRegistersSurfaceWithoutRuntimeSideEffects(): Promise<void> {
	const { commands, handlers, pi, tools } = buildPiHarness();
	registerTelegramBootstrap(pi);

	assert.deepEqual([...commands.keys()].sort(), [
		"telegram-broker-status",
		"telegram-connect",
		"telegram-disconnect",
		"telegram-setup",
		"telegram-status",
		"telegram-topic-setup",
	]);
	assert.deepEqual(tools.map((tool) => tool.name), ["telegram_attach"]);
	assert.ok(handlers.has("session_start"));
	assert.ok(handlers.has("session_shutdown"));
	assert.ok(handlers.has("agent_start"));
	assert.ok(handlers.has("agent_end"));
	assert.ok(handlers.has("before_agent_start"));

	await handlers.get("session_start")?.[0]?.({ reason: "startup" }, { ui: { theme: {} } } as never);
	await handlers.get("session_shutdown")?.[0]?.({ reason: "shutdown" }, { ui: { theme: {} } } as never);
	assert.equal(commands.size, 6);
	assert.equal(tools.length, 1);
}

async function checkLazyToolLoadDoesNotDuplicatePiSurface(): Promise<void> {
	const { commands, pi, tools } = buildPiHarness();
	registerTelegramBootstrap(pi);
	const tool = tools.find((candidate) => candidate.name === "telegram_attach");
	assert.ok(tool);

	await assert.rejects(
		async () => await tool.execute("tool-1", { paths: ["artifact.txt"] }, undefined, undefined, testExtensionContext()),
		/telegram_attach can only be used while replying to an active Telegram turn/,
	);
	assert.equal(commands.size, 6);
	assert.equal(tools.length, 1);
}

async function checkMidTurnConnectPrimesAbortWithoutDuplicateRegistration(): Promise<void> {
	const { commands, pi, tools } = buildPiHarness();
	let loadCalls = 0;
	let connectCalls = 0;
	let sessionStartCalls = 0;
	let currentAbort: (() => void) | undefined;
	let abortCalls = 0;
	registerTelegramBootstrap(pi, {
		loadRuntime: async () => {
			loadCalls += 1;
			return fakeRuntime({
				onSessionStart: async () => { sessionStartCalls += 1; },
				connectTelegram: async () => { connectCalls += 1; },
				setCurrentAbort: (abort) => { currentAbort = abort; },
			});
		},
	});

	await commands.get("telegram-connect")?.handler("", commandContext({
		isIdle: () => false,
		abort: () => { abortCalls += 1; },
	}));

	assert.equal(loadCalls, 1);
	assert.equal(sessionStartCalls, 1);
	assert.equal(connectCalls, 1);
	assert.ok(currentAbort);
	currentAbort();
	assert.equal(abortCalls, 1);
	assert.equal(commands.size, 6);
	assert.equal(tools.length, 1);
}

async function checkMatchingHandoffLoadsRuntimeFromSessionStart(): Promise<void> {
	const { handlers, pi } = buildPiHarness();
	let loadCalls = 0;
	let sessionStartEvent: { reason?: string; previousSessionFile?: string } | undefined;
	let handoffContext: { reason?: string; previousSessionFile?: string; sessionFile?: string } | undefined;
	registerTelegramBootstrap(pi, {
		loadRuntime: async () => {
			loadCalls += 1;
			return fakeRuntime({
				onSessionStart: async (_ctx, event) => { sessionStartEvent = event; },
			});
		},
		readConfig: async () => ({ botToken: "token" }),
		configureBrokerScope: () => undefined,
		hasMatchingSessionReplacementHandoff: async (options) => {
			handoffContext = options.context;
			return true;
		},
	});

	await handlers.get("session_start")?.[0]?.({ reason: "resume", previousSessionFile: "old.json" }, commandContext({
		sessionManager: {
			getSessionId: () => "session-2",
			getSessionFile: () => "new.json",
		},
	}));

	assert.equal(loadCalls, 1);
	assert.deepEqual(handoffContext, { reason: "resume", previousSessionFile: "old.json", sessionFile: "new.json" });
	assert.deepEqual(sessionStartEvent, { reason: "resume", previousSessionFile: "old.json" });
}

async function checkConcurrentLazyCommandsShareInitialization(): Promise<void> {
	const { commands, pi } = buildPiHarness();
	let sessionStartCalls = 0;
	let releaseInitialization: (() => void) | undefined;
	const initializationStarted = new Promise<void>((resolve) => {
		registerTelegramBootstrap(pi, {
			loadRuntime: async () => fakeRuntime({
				onSessionStart: async () => {
					sessionStartCalls += 1;
					resolve();
					await new Promise<void>((release) => { releaseInitialization = release; });
				},
			}),
		});
	});

	const first = commands.get("telegram-status")?.handler("", commandContext());
	await initializationStarted;
	const second = commands.get("telegram-broker-status")?.handler("", commandContext());
	assert.equal(sessionStartCalls, 1);
	releaseInitialization?.();
	await Promise.all([first, second]);
	assert.equal(sessionStartCalls, 1);
}

async function checkInitializationFailureCanRetry(): Promise<void> {
	const { commands, pi } = buildPiHarness();
	let sessionStartCalls = 0;
	registerTelegramBootstrap(pi, {
		loadRuntime: async () => fakeRuntime({
			onSessionStart: async () => {
				sessionStartCalls += 1;
				if (sessionStartCalls === 1) throw new Error("temporary init failure");
			},
		}),
	});

	await assert.rejects(async () => await commands.get("telegram-status")?.handler("", commandContext()), /temporary init failure/);
	await commands.get("telegram-status")?.handler("", commandContext());
	assert.equal(sessionStartCalls, 2);
}

async function checkShutdownDuringInitializationPreventsCommandContinuation(): Promise<void> {
	const { commands, handlers, pi } = buildPiHarness();
	let releaseInitialization: (() => void) | undefined;
	const initializationStarted = new Promise<void>((resolve) => {
		registerTelegramBootstrap(pi, {
			loadRuntime: async () => fakeRuntime({
				onSessionStart: async () => {
					resolve();
					await new Promise<void>((release) => { releaseInitialization = release; });
				},
				connectTelegram: async () => { throw new Error("connect should not continue after shutdown starts"); },
			}),
		});
	});

	const connect = commands.get("telegram-connect")?.handler("", commandContext());
	await initializationStarted;
	const shutdown = handlers.get("session_shutdown")?.[0]?.({ reason: "shutdown" }, commandContext());
	releaseInitialization?.();
	await assert.rejects(async () => await connect, /Telegram bridge is shutting down/);
	await shutdown;
}

async function checkShutdownDelegatesOnlyAfterRuntimeLoaded(): Promise<void> {
	const unloaded = buildPiHarness();
	let unloadedStopBrokerCalls = 0;
	registerTelegramBootstrap(unloaded.pi, {
		loadRuntime: async () => fakeRuntime({ stopBroker: async () => { unloadedStopBrokerCalls += 1; } }),
	});
	await unloaded.handlers.get("session_shutdown")?.[0]?.({ reason: "shutdown" }, commandContext());
	assert.equal(unloadedStopBrokerCalls, 0);

	const loaded = buildPiHarness();
	let disconnectMode: string | undefined;
	let stopBrokerCalls = 0;
	registerTelegramBootstrap(loaded.pi, {
		loadRuntime: async () => fakeRuntime({
			onSessionStart: async () => undefined,
			disconnectSessionRoute: async (mode) => { disconnectMode = mode; },
			stopBroker: async () => { stopBrokerCalls += 1; },
		}),
	});
	await loaded.commands.get("telegram-status")?.handler("", commandContext());
	await loaded.handlers.get("session_shutdown")?.[0]?.({ reason: "shutdown" }, commandContext());
	assert.equal(disconnectMode, "shutdown");
	assert.equal(stopBrokerCalls, 1);
}

async function main(): Promise<void> {
	checkEntrypointUsesBootstrapOnly();
	await checkBootstrapRegistersSurfaceWithoutRuntimeSideEffects();
	await checkLazyToolLoadDoesNotDuplicatePiSurface();
	await checkConcurrentLazyCommandsShareInitialization();
	await checkInitializationFailureCanRetry();
	await checkShutdownDuringInitializationPreventsCommandContinuation();
	await checkMidTurnConnectPrimesAbortWithoutDuplicateRegistration();
	await checkMatchingHandoffLoadsRuntimeFromSessionStart();
	await checkShutdownDelegatesOnlyAfterRuntimeLoaded();
	console.log("Lazy bootstrap checks passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
