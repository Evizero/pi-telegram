import assert from "node:assert/strict";
import type { Server } from "node:http";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { ClientRuntimeHost, type ClientRuntimeHostDeps, type ClientRuntimeHostFinalHandoff, type ClientRuntimeHostFinalizer } from "../src/client/runtime-host.js";
import type { TelegramRoute } from "../src/broker/types.js";
import type { AssistantFinalPayload, PendingManualCompactionOperation, PendingTelegramTurn } from "../src/client/types.js";
import type { IpcEnvelope } from "../src/shared/ipc-types.js";

type CompactCallbacks = { onComplete?: (result?: unknown) => void; onError?: (error: unknown) => void };

function route(id = "route-1", chatId: number | string = 123): TelegramRoute {
	return { routeId: id, sessionId: "session-1", chatId, messageThreadId: 9, routeMode: "private_topic", topicName: id, createdAtMs: 1, updatedAtMs: 1 };
}

function operation(id: string): PendingManualCompactionOperation {
	return { operationId: id, sessionId: "session-1", routeId: "route-1", chatId: 123, messageThreadId: 9, status: "queued", createdAtMs: 1, updatedAtMs: 1 };
}

function turn(id: string, deliveryMode?: PendingTelegramTurn["deliveryMode"], blockedByManualCompactionOperationId?: string): PendingTelegramTurn {
	return {
		turnId: id,
		sessionId: "session-1",
		routeId: "route-1",
		chatId: 123,
		messageThreadId: 9,
		replyToMessageId: 0,
		queuedAttachments: [],
		content: [{ type: "text", text: `message ${id}` }],
		historyText: `history ${id}`,
		deliveryMode,
		blockedByManualCompactionOperationId,
	};
}

function ctx(idle = true, compact?: ExtensionContext["compact"]): ExtensionContext {
	return {
		cwd: "/tmp/pi-telegram-runtime-host-check",
		isIdle: () => idle,
		abort: () => undefined,
		compact: compact ?? (() => undefined),
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => "/tmp/session.json",
		},
		ui: {
			theme: {},
			setStatus: () => undefined,
			notify: () => undefined,
		},
	} as unknown as ExtensionContext;
}

function fakeServer(onClose?: () => void): Server {
	return {
		close(callback?: (error?: Error) => void) {
			onClose?.();
			callback?.();
			return this as Server;
		},
	} as Server;
}

interface Harness {
	host: ClientRuntimeHost;
	postCalls: Array<{ type: string; payload: unknown; targetSessionId?: string }>;
	sentMessages: Array<{ content: PendingTelegramTurn["content"]; deliverAs?: string }>;
	createdServers: string[];
	closedServers: number;
	lastHandler?: (envelope: IpcEnvelope) => Promise<unknown>;
	finalizer: ClientRuntimeHostFinalizer & { deferredPayload?: AssistantFinalPayload; hasDeferred: boolean; cancelled: number; released: number };
	handoff: ClientRuntimeHostFinalHandoff & { retryPendingCalls: number; handoffPendingForShutdownCalls: number; abortedFinals: PendingTelegramTurn[]; deferFinals: boolean };
	finals: AssistantFinalPayload[];
	setPostIpc(handler: ClientRuntimeHostDeps["postIpc"]): void;
	setLatestCtx(nextCtx: ExtensionContext): void;
}

function createHarness(options: { idle?: boolean; postIpc?: ClientRuntimeHostDeps["postIpc"]; sendUserMessage?: ExtensionAPI["sendUserMessage"]; compact?: ExtensionContext["compact"] } = {}): Harness {
	let latestCtx = ctx(options.idle ?? true, options.compact);
	let postIpc: ClientRuntimeHostDeps["postIpc"] = options.postIpc ?? (async (_socketPath, type) => {
		if (type === "register_session") return route() as never;
		if (type === "heartbeat_session") return {} as never;
		return { ok: true } as never;
	});
	const postCalls: Harness["postCalls"] = [];
	const sentMessages: Harness["sentMessages"] = [];
	const finals: AssistantFinalPayload[] = [];
	const createdServers: string[] = [];
	let closedServers = 0;
	let lastHandler: Harness["lastHandler"];
	const finalizer: ClientRuntimeHostFinalizer & { deferredPayload?: AssistantFinalPayload; hasDeferred: boolean; cancelled: number; released: number } = {
		deferredPayload: undefined,
		hasDeferred: false,
		cancelled: 0,
		released: 0,
		cancel() { this.cancelled += 1; },
		consumeDeferredPayload() { const payload = this.deferredPayload; this.deferredPayload = undefined; return payload; },
		async flushDeferredTurn() { return undefined; },
		async finalizeActiveTurn() { return "completed" as const; },
		hasDeferredTurn() { return this.hasDeferred; },
		async releaseDeferredTurn() { this.released += 1; return undefined; },
		restoreDeferredPayload(payload: AssistantFinalPayload) { this.deferredPayload = payload; },
		onAgentStart() { /* no-op */ },
		onRetryMessageStart() { /* no-op */ },
	};
	const handoff = {
		retryPendingCalls: 0,
		handoffPendingForShutdownCalls: 0,
		abortedFinals: [] as PendingTelegramTurn[],
		deferFinals: false,
		clearPersistedDeferredPayload() { /* no-op */ },
		clearQueue() { /* no-op */ },
		deferNewFinals() { return this.deferFinals; },
		async enqueueAbortedFinal(abortedTurn: PendingTelegramTurn) { this.abortedFinals.push(abortedTurn); },
		find() { return undefined; },
		async handoffPendingForShutdown() { this.handoffPendingForShutdownCalls += 1; },
		async persistPending() { /* no-op */ },
		async persistRestoredDeferredStateWhileBrokerHoldsLock() { /* no-op */ },
		async retryPending() { this.retryPendingCalls += 1; },
		setPersistedDeferredPayload(payload: AssistantFinalPayload | undefined) { finalizer.deferredPayload = payload; },
	} satisfies ClientRuntimeHostFinalHandoff & { retryPendingCalls: number; handoffPendingForShutdownCalls: number; abortedFinals: PendingTelegramTurn[]; deferFinals: boolean };
	const pi = {
		getSessionName: () => "session one",
		sendUserMessage: options.sendUserMessage ?? ((content: PendingTelegramTurn["content"], options?: { deliverAs?: string }) => { sentMessages.push({ content, deliverAs: options?.deliverAs }); }),
		setModel: async () => undefined,
	} as unknown as ExtensionAPI;
	let connectedBrokerSocketPath = "/tmp/broker.sock";
	const deps: ClientRuntimeHostDeps = {
		pi,
		ownerId: "owner-1",
		startedAtMs: 1,
		getSessionId: () => "session-1",
		getLatestCtx: () => latestCtx,
		setLatestContext: (nextCtx) => { latestCtx = nextCtx; return "session-1"; },
		getSessionReplacementContext: () => undefined,
		getConfig: () => ({}),
		setConfig: () => undefined,
		readConfig: async () => ({}),
		writeConfig: async () => undefined,
		showTelegramStatus: () => undefined,
		promptForConfig: async () => true,
		applyBrokerScope: () => undefined,
		callTelegram: async () => ({}) as never,
		readLease: async () => undefined,
		isLeaseLive: async () => false,
		tryAcquireBroker: async () => false,
		ensureBrokerStarted: async () => undefined,
		getLocalBrokerSocketPath: () => "/tmp/local-broker.sock",
		getConnectedBrokerSocketPath: () => connectedBrokerSocketPath,
		setConnectedBrokerSocketPath: (socketPath) => { connectedBrokerSocketPath = socketPath; },
		createIpcServer: async (socketPath, handler) => { createdServers.push(socketPath); lastHandler = handler; return fakeServer(() => { closedServers += 1; }); },
		postIpc: async (socketPath, type, payload, targetSessionId) => { postCalls.push({ type, payload, targetSessionId }); return await postIpc(socketPath, type, payload, targetSessionId); },
		acknowledgeStaleClientConnection: async (connectionNonce) => { postCalls.push({ type: "stale_client_connection_ack", payload: { connectionNonce }, targetSessionId: "session-1" }); },
		isStaleSessionConnectionError: (error) => error instanceof Error && error.message === "stale_session_connection",
		activeTurnFinalizer: finalizer,
		assistantFinalHandoff: handoff,
		clearAssistantPreviewInBroker: async () => undefined,
		isRoutableRoute: (candidate): candidate is TelegramRoute => candidate !== undefined && candidate.chatId !== 0 && String(candidate.chatId) !== "0",
		sendAssistantFinalToBroker: async (payload) => { finals.push(payload); return true; },
		updateStatus: () => undefined,
	};
	const host = new ClientRuntimeHost(deps);
	return { host, postCalls, sentMessages, finals, createdServers, get closedServers() { return closedServers; }, get lastHandler() { return lastHandler; }, finalizer, handoff, setPostIpc(handler) { postIpc = handler; }, setLatestCtx(nextCtx) { latestCtx = nextCtx; } } as Harness;
}

async function checkClientServerStartRefreshesConnectionIdentity(): Promise<void> {
	const harness = createHarness();
	const oldNonce = harness.host.getConnectionNonce();
	const oldStartedAt = harness.host.getConnectionStartedAtMs();
	await harness.host.startClientServer();
	assert.equal(harness.host.hasClientServer(), true);
	assert.equal(harness.createdServers.length, 1);
	assert.match(harness.createdServers[0] ?? "", /client-owner-1\.sock$/);
	assert.notEqual(harness.host.getConnectionNonce(), oldNonce);
	assert.ok(harness.host.getConnectionStartedAtMs() >= oldStartedAt);
	assert.equal(typeof harness.lastHandler, "function");
	await harness.host.stopClientServer();
	assert.equal(harness.host.hasClientServer(), false);
	assert.equal(harness.closedServers, 1);
}

async function checkRegistrationRetriesAndMirrorsBusyTurnOnce(): Promise<void> {
	let registerAttempts = 0;
	const harness = createHarness({ idle: false, postIpc: async (_socketPath, type) => {
		if (type === "register_session") {
			registerAttempts += 1;
			if (registerAttempts === 1) throw new Error("transient");
			return route("route-busy") as never;
		}
		return { ok: true } as never;
	} });
	await harness.host.startClientServer();
	await harness.host.registerWithBroker(ctx(false), "/tmp/broker.sock");
	assert.equal(registerAttempts, 2);
	assert.equal(harness.host.getConnectedRoute()?.routeId, "route-busy");
	assert.equal(harness.host.getActiveTelegramTurn()?.routeId, "route-busy");
	const activeTurnId = harness.host.getActiveTelegramTurn()?.turnId;
	harness.host.ensureCurrentTurnMirroredToTelegram(ctx(false), "second mirror should be ignored");
	assert.equal(harness.host.getActiveTelegramTurn()?.turnId, activeTurnId);
	await harness.host.stopClientServer();
}

async function checkIdleAndNonRoutableMirroringDoNothing(): Promise<void> {
	const harness = createHarness({ idle: true });
	harness.host.setConnectedRoute(route("idle-route"));
	harness.host.ensureCurrentTurnMirroredToTelegram(ctx(true), "idle");
	assert.equal(harness.host.getActiveTelegramTurn(), undefined);
	harness.host.setConnectedRoute(route("non-routable", 0));
	harness.host.ensureCurrentTurnMirroredToTelegram(ctx(false), "non-routable");
	assert.equal(harness.host.getActiveTelegramTurn(), undefined);
}

async function checkStaleRegistrationStopsClientServer(): Promise<void> {
	const harness = createHarness({ postIpc: async (_socketPath, type) => {
		if (type === "register_session") throw new Error("stale_session_connection");
		return { ok: true } as never;
	} });
	await harness.host.startClientServer();
	await assert.rejects(() => harness.host.registerWithBroker(ctx(), "/tmp/broker.sock"), /stale_session_connection/);
	assert.equal(harness.host.hasClientServer(), false);
}

async function checkHeartbeatUpdatesRouteAndHonorsFinalDeferralGate(): Promise<void> {
	const harness = createHarness();
	await harness.host.startClientServer();
	await harness.host.registerWithBroker(ctx(), "/tmp/broker.sock");
	harness.host.setQueuedTelegramTurns([turn("next", "followUp")]);
	harness.handoff.deferFinals = true;
	harness.setPostIpc(async (_socketPath, type) => {
		if (type === "heartbeat_session") return { route: route("updated") } as never;
		return { ok: true } as never;
	});
	await harness.host.heartbeatClientSession(ctx());
	assert.equal(harness.host.getConnectedRoute()?.routeId, "updated");
	assert.equal(harness.handoff.retryPendingCalls, 1);
	assert.equal(harness.sentMessages.length, 0);

	harness.handoff.deferFinals = false;
	await harness.host.heartbeatClientSession(ctx());
	assert.equal(harness.sentMessages.length, 1);
	assert.equal(harness.sentMessages[0]?.deliverAs, "followUp");
	assert.ok(harness.postCalls.some((call) => call.type === "turn_started" && (call.payload as { turnId?: string }).turnId === "next"));
	await harness.host.stopClientServer();
}

async function checkStartNextTelegramTurnRestoresQueueWhenLocalDeliveryThrows(): Promise<void> {
	const harness = createHarness({ sendUserMessage: (() => { throw new Error("pi delivery failed"); }) as ExtensionAPI["sendUserMessage"] });
	await harness.host.startClientServer();
	harness.host.setConnectedRoute(route());
	const queued = turn("restore", "followUp");
	harness.host.setQueuedTelegramTurns([queued]);
	assert.throws(() => harness.host.startNextTelegramTurn(), /pi delivery failed/);
	assert.equal(harness.host.getActiveTelegramTurn(), undefined);
	assert.deepEqual(harness.host.getQueuedTelegramTurns().map((candidate) => candidate.turnId), ["restore"]);
	assert.equal(harness.postCalls.some((call) => call.type === "turn_started"), false);
	await harness.host.stopClientServer();
}

async function checkStaleStandDownPersistsFinalsAndClearsLocalState(): Promise<void> {
	const harness = createHarness({ idle: false });
	await harness.host.startClientServer();
	harness.host.setConnectedRoute(route());
	harness.host.ensureCurrentTurnMirroredToTelegram(ctx(false), "active");
	const activeTurn = harness.host.getActiveTelegramTurn();
	assert.ok(activeTurn);
	await harness.host.standDownStaleClientConnection({ acknowledgeBroker: true });
	assert.deepEqual(harness.handoff.abortedFinals.map((candidate) => candidate.turnId), [activeTurn.turnId]);
	assert.equal(harness.host.getActiveTelegramTurn(), undefined);
	assert.equal(harness.host.getQueuedTelegramTurns().length, 0);
	assert.equal(harness.host.hasAwaitingTelegramFinalTurn(), false);
	assert.ok(harness.postCalls.some((call) => call.type === "stale_client_connection_ack"));
	assert.equal(harness.host.hasClientServer(), false);
}

async function checkRouteShutdownHandoffsPendingFinalsAndClearsRouteState(): Promise<void> {
	const harness = createHarness({ idle: false });
	harness.host.setConnectedRoute(route());
	harness.host.ensureCurrentTurnMirroredToTelegram(ctx(false), "active");
	harness.host.setQueuedTelegramTurns([turn("queued")]);
	await harness.host.shutdownClientRoute();
	assert.equal(harness.handoff.handoffPendingForShutdownCalls, 1);
	assert.equal(harness.host.getConnectedRoute(), undefined);
	assert.equal(harness.host.getActiveTelegramTurn(), undefined);
	assert.equal(harness.host.getQueuedTelegramTurns().length, 0);
}

async function checkIdleQueueOrStartCompactStartsImmediately(): Promise<void> {
	let compactStarted = 0;
	const harness = createHarness({ idle: true, compact: () => { compactStarted += 1; } });
	harness.host.setConnectedRoute(route());
	const result = harness.host.clientQueueOrStartCompact({ operation: operation("compact-idle") });
	assert.equal(result.status, "started");
	assert.equal(result.text, "Compaction started.");
	assert.equal(compactStarted, 1);
}

async function checkQueuedCompactRunsAfterEarlierTurnAndBeforeLaterFollowUp(): Promise<void> {
	let compactCallbacks: CompactCallbacks | undefined;
	const harness = createHarness({ idle: false, compact: (callbacks) => { compactCallbacks = callbacks as CompactCallbacks | undefined; } });
	await harness.host.startClientServer();
	harness.host.setConnectedRoute(route());
	harness.host.setActiveTelegramTurn(turn("active"));
	harness.host.setQueuedTelegramTurns([turn("earlier", "followUp")]);

	const queueResult = harness.host.clientQueueOrStartCompact({ operation: operation("compact-queued") });
	assert.equal(queueResult.status, "queued");
	assert.equal(compactCallbacks, undefined);

	harness.host.setActiveTelegramTurn(undefined);
	harness.setLatestCtx(ctx(true, (callbacks) => { compactCallbacks = callbacks as CompactCallbacks | undefined; }));
	await harness.host.clientDeliverTurn(turn("later", "followUp", "compact-queued"));
	assert.deepEqual(harness.sentMessages.map((message) => (message.content[0] as { text: string }).text), ["message earlier"]);
	assert.equal(compactCallbacks, undefined);

	harness.host.setActiveTelegramTurn(undefined);
	harness.host.startNextTelegramTurn();
	assert.ok(compactCallbacks, "expected queued compaction to start before later follow-up");
	assert.ok(harness.postCalls.some((call) => call.type === "manual_compaction_started" && (call.payload as { operationId?: string }).operationId === "compact-queued"));
	assert.equal(harness.finals.at(-1)?.text, "Compaction started.");
	assert.deepEqual(harness.sentMessages.map((message) => (message.content[0] as { text: string }).text), ["message earlier"]);

	const completionCallbacks = compactCallbacks as CompactCallbacks | undefined;
	completionCallbacks?.onComplete?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(harness.finals.at(-1)?.text, "Compaction completed.");
	assert.ok(harness.postCalls.some((call) => call.type === "manual_compaction_settled" && (call.payload as { operationId?: string }).operationId === "compact-queued"));
	assert.deepEqual(harness.sentMessages.map((message) => (message.content[0] as { text: string }).text), ["message earlier", "message later"]);
	await harness.host.stopClientServer();
}

async function checkQueuedCompactFailureReleasesLaterFollowUp(): Promise<void> {
	let compactCallbacks: CompactCallbacks | undefined;
	const harness = createHarness({ idle: false, compact: (callbacks) => { compactCallbacks = callbacks as CompactCallbacks | undefined; } });
	await harness.host.startClientServer();
	harness.host.setConnectedRoute(route());
	harness.host.setActiveTelegramTurn(turn("active"));
	assert.equal(harness.host.clientQueueOrStartCompact({ operation: operation("compact-fails") }).status, "queued");
	harness.host.setActiveTelegramTurn(undefined);
	harness.setLatestCtx(ctx(true, (callbacks) => { compactCallbacks = callbacks as CompactCallbacks | undefined; }));
	await harness.host.clientDeliverTurn(turn("later-after-fail", "followUp", "compact-fails"));
	harness.host.startNextTelegramTurn();
	compactCallbacks?.onError?.(new Error("summary failed"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(harness.finals.some((final) => final.text === "Compaction failed: summary failed"));
	assert.ok(harness.postCalls.some((call) => call.type === "manual_compaction_settled" && (call.payload as { operationId?: string }).operationId === "compact-fails"));
	assert.deepEqual(harness.sentMessages.map((message) => (message.content[0] as { text: string }).text), ["message later-after-fail"]);
	await harness.host.stopClientServer();
}

async function checkQueuedCompactSynchronousFailureSettlesOnceAndReleasesLaterFollowUp(): Promise<void> {
	const harness = createHarness({ idle: false, compact: () => { throw new Error("sync compact failed"); } });
	await harness.host.startClientServer();
	harness.host.setConnectedRoute(route());
	assert.equal(harness.host.clientQueueOrStartCompact({ operation: operation("compact-sync-fails") }).status, "queued");
	harness.setLatestCtx(ctx(true, () => { throw new Error("sync compact failed"); }));
	await harness.host.clientDeliverTurn(turn("later-after-sync-fail", "followUp", "compact-sync-fails"));
	harness.host.startNextTelegramTurn();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(harness.finals.map((final) => final.text).filter((text) => text === "Compaction failed: sync compact failed"), ["Compaction failed: sync compact failed"]);
	assert.equal(harness.postCalls.filter((call) => call.type === "manual_compaction_settled" && (call.payload as { operationId?: string }).operationId === "compact-sync-fails").length, 1);
	assert.deepEqual(harness.sentMessages.map((message) => (message.content[0] as { text: string }).text), ["message later-after-sync-fail"]);
	await harness.host.stopClientServer();
}

async function checkQueuedCompactUnavailableContextSettlesAndReleasesLaterFollowUp(): Promise<void> {
	const harness = createHarness({ idle: false });
	await harness.host.startClientServer();
	harness.host.setConnectedRoute(route());
	assert.equal(harness.host.clientQueueOrStartCompact({ operation: operation("compact-unavailable") }).status, "queued");
	harness.setLatestCtx(undefined as unknown as ExtensionContext);
	await harness.host.clientDeliverTurn(turn("later-after-unavailable", "followUp", "compact-unavailable"));
	harness.host.startNextTelegramTurn();
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(harness.postCalls.some((call) => call.type === "manual_compaction_started" && (call.payload as { operationId?: string }).operationId === "compact-unavailable"));
	assert.ok(harness.postCalls.some((call) => call.type === "manual_compaction_settled" && (call.payload as { operationId?: string }).operationId === "compact-unavailable"));
	assert.equal(harness.finals.at(-1)?.text, "Session context unavailable.");
	assert.deepEqual(harness.sentMessages.map((message) => (message.content[0] as { text: string }).text), ["message later-after-unavailable"]);
	await harness.host.stopClientServer();
}

async function checkQueuedCompactCoalescesAndAbortClearsIt(): Promise<void> {
	const harness = createHarness({ idle: false });
	harness.host.setConnectedRoute(route());
	harness.host.setActiveTelegramTurn(turn("active"));
	assert.equal(harness.host.clientQueueOrStartCompact({ operation: operation("compact-one") }).status, "queued");
	assert.equal(harness.host.clientQueueOrStartCompact({ operation: operation("compact-two") }).status, "already_queued");
	const abortResult = await harness.host.clientAbortTurn();
	assert.deepEqual(abortResult.clearedCompactionIds, ["compact-one"]);
	assert.equal(abortResult.text, "Aborted current turn. Cancelled queued compaction.");
	assert.equal(harness.host.clientQueueOrStartCompact({ operation: operation("compact-one") }).status, "already_handled");
}

async function checkQueuedCompactReportsAlreadyRunning(): Promise<void> {
	let compactCallbacks: CompactCallbacks | undefined;
	const harness = createHarness({ idle: false, compact: (callbacks) => { compactCallbacks = callbacks as CompactCallbacks | undefined; } });
	await harness.host.startClientServer();
	harness.host.setConnectedRoute(route());
	assert.equal(harness.host.clientQueueOrStartCompact({ operation: operation("compact-running") }).status, "queued");
	harness.setLatestCtx(ctx(true, (callbacks) => { compactCallbacks = callbacks as CompactCallbacks | undefined; }));
	harness.host.startNextTelegramTurn();
	assert.ok(compactCallbacks);
	assert.equal(harness.host.clientQueueOrStartCompact({ operation: operation("compact-again") }).status, "already_running");
	compactCallbacks?.onComplete?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(harness.host.clientQueueOrStartCompact({ operation: operation("compact-running") }).status, "already_handled");
	await harness.host.stopClientServer();
}

async function main(): Promise<void> {
	await checkClientServerStartRefreshesConnectionIdentity();
	await checkRegistrationRetriesAndMirrorsBusyTurnOnce();
	await checkIdleAndNonRoutableMirroringDoNothing();
	await checkStaleRegistrationStopsClientServer();
	await checkHeartbeatUpdatesRouteAndHonorsFinalDeferralGate();
	await checkStartNextTelegramTurnRestoresQueueWhenLocalDeliveryThrows();
	await checkStaleStandDownPersistsFinalsAndClearsLocalState();
	await checkRouteShutdownHandoffsPendingFinalsAndClearsRouteState();
	await checkIdleQueueOrStartCompactStartsImmediately();
	await checkQueuedCompactRunsAfterEarlierTurnAndBeforeLaterFollowUp();
	await checkQueuedCompactFailureReleasesLaterFollowUp();
	await checkQueuedCompactSynchronousFailureSettlesOnceAndReleasesLaterFollowUp();
	await checkQueuedCompactUnavailableContextSettlesAndReleasesLaterFollowUp();
	await checkQueuedCompactCoalescesAndAbortClearsIt();
	await checkQueuedCompactReportsAlreadyRunning();
	console.log("Client runtime host checks passed");
}

void main();
