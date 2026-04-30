import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureBrokerScopeForBase, BROKER_DIR } from "../src/shared/paths.js";
import type { BrokerLease, BrokerState, PendingAssistantFinalDelivery, TelegramRoute } from "../src/broker/types.js";
import type { AssistantFinalPayload, PendingTelegramTurn } from "../src/client/types.js";
import { now } from "../src/shared/utils.js";
import { ClientAssistantFinalHandoff } from "../src/client/final-handoff.js";

function assert(condition: unknown, message: string): void {
	if (!condition) throw new Error(message);
}

function turn(turnId = "turn-1"): PendingTelegramTurn {
	return { turnId, sessionId: "session-1", routeId: "route-1", chatId: 123, replyToMessageId: 1, queuedAttachments: [], content: [], historyText: "" };
}

function payload(turnId = "turn-1"): AssistantFinalPayload {
	return { turn: turn(turnId), text: "final", attachments: [] };
}

function state(): BrokerState {
	const route: TelegramRoute = { routeId: "route-1", sessionId: "session-1", chatId: 123, routeMode: "single_chat_selector", topicName: "topic", createdAtMs: now(), updatedAtMs: now() };
	return { schemaVersion: 1, recentUpdateIds: [], sessions: {}, routes: { "route-1": route }, pendingMediaGroups: {}, pendingTurns: { "turn-1": { turn: turn(), updatedAtMs: now() } }, pendingAssistantFinals: {}, pendingRouteCleanups: {}, assistantPreviewMessages: {}, completedTurnIds: [], createdAtMs: now(), updatedAtMs: now() };
}

async function exists(path: string): Promise<boolean> {
	return await stat(path).then(() => true, () => false);
}

function makeHandoff(options?: { brokerState?: BrokerState; postAssistantFinal?: (finalPayload: AssistantFinalPayload) => Promise<void>; postSucceeds?: () => boolean; accepted?: AssistantFinalPayload[]; connectionNonce?: string; connectionStartedAtMs?: number; disconnectedTurns?: Set<string>; deferredPayload?: AssistantFinalPayload; reportInvalidDurableState?: (path: string, error: unknown) => void }) {
	const accepted = options?.accepted ?? [];
	let connectedBrokerSocketPath = "broker-a";
	const handoff = new ClientAssistantFinalHandoff({
		getSessionId: () => "session-1",
		getConnectionNonce: () => options?.connectionNonce ?? "conn-current",
		getConnectionStartedAtMs: () => options?.connectionStartedAtMs ?? 10,
		getConnectedRoute: () => ({ routeId: "route-1", sessionId: "session-1", chatId: 123, routeMode: "single_chat_selector", topicName: "topic", createdAtMs: now(), updatedAtMs: now() }),
		isTurnDisconnected: (turnId) => options?.disconnectedTurns?.has(turnId) ?? false,
		peekDeferredPayload: () => options?.deferredPayload,
		getBrokerState: () => options?.brokerState,
		acceptBrokerFinal: async (finalPayload) => {
			const brokerState = options?.brokerState;
			if (brokerState) {
				brokerState.pendingAssistantFinals ??= {};
				if (!brokerState.pendingAssistantFinals[finalPayload.turn.turnId]) {
					accepted.push(finalPayload);
					brokerState.pendingAssistantFinals[finalPayload.turn.turnId] = { ...finalPayload, status: "pending", createdAtMs: now(), updatedAtMs: now(), progress: {} } as PendingAssistantFinalDelivery;
				}
			} else {
				accepted.push(finalPayload);
			}
		},
		postAssistantFinal: async (finalPayload) => {
			if (options?.postAssistantFinal) return await options.postAssistantFinal(finalPayload);
			if (!(options?.postSucceeds?.() ?? true)) throw new Error("broker unavailable");
		},
		postRestoreDeferredFinal: async () => { throw new Error("no live client"); },
		readLease: async (): Promise<BrokerLease | undefined> => undefined,
		isLeaseLive: async () => false,
		setConnectedBrokerSocketPath: (socketPath) => { connectedBrokerSocketPath = socketPath; },
		isStaleSessionConnectionError: (error) => error instanceof Error && /stale_session_connection/.test(error.message),
		getAwaitingTelegramFinalTurnId: () => undefined,
		clearAwaitingTelegramFinalTurn: () => undefined,
		getActiveTelegramTurn: () => undefined,
		setActiveTelegramTurn: () => undefined,
		rememberCompletedLocalTurn: () => undefined,
		startNextTelegramTurn: () => undefined,
		reportInvalidDurableState: options?.reportInvalidDurableState,
	});
	return { handoff, accepted, connectedBrokerSocketPath: () => connectedBrokerSocketPath };
}

async function run(): Promise<void> {
	const brokerBase = await mkdtemp(join(tmpdir(), "pi-telegram-final-handoff-"));
	configureBrokerScopeForBase(brokerBase, 1);
	await rm(BROKER_DIR, { recursive: true, force: true });
	{
		let postSucceeds = false;
		const { handoff } = makeHandoff({ postSucceeds: () => postSucceeds });
		const finalPayload = payload();
		assert((await handoff.send(finalPayload)) === false, "failed broker handoff should remain pending client-side");
		const pendingPath = join(handoff.pendingFinalsDir(), "session-1.json");
		assert(await exists(pendingPath), "pending final file should exist before broker acceptance");
		postSucceeds = true;
		await handoff.retryPending();
		assert(!(await exists(pendingPath)), "pending final file should be removed after broker acceptance");
	}
	{
		const deferredPayload = { ...payload("turn-1"), text: undefined, stopReason: "error", errorMessage: "fetch failed" };
		const { handoff } = makeHandoff({ deferredPayload });
		await handoff.enqueueAbortedFinal(deferredPayload.turn);
		await handoff.persistDeferredState();
		const persisted = JSON.parse(await readFile(join(handoff.pendingFinalsDir(), "session-1.json"), "utf8")) as { payloads?: AssistantFinalPayload[]; deferredPayloads?: AssistantFinalPayload[] };
		assert((persisted.payloads ?? []).length === 0 && persisted.deferredPayloads?.[0]?.turn.turnId === "turn-1", "retry-deferred payload should supersede same-turn aborted cleanup in client handoff file");
		await rm(join(handoff.pendingFinalsDir(), "session-1.json"), { force: true });
	}
	{
		const brokerState = state();
		brokerState.sessions["session-1"] = { sessionId: "session-1", ownerId: "owner", pid: process.pid, cwd: process.cwd(), projectName: "project", connectedAtMs: now(), connectionStartedAtMs: 20, connectionNonce: "conn-new", clientSocketPath: "client", status: "connecting", queuedTurnCount: 0, lastHeartbeatMs: now(), topicName: "topic", staleStandDownConnectionNonce: "conn-current", staleStandDownRequestedAtMs: now() };
		const accepted: AssistantFinalPayload[] = [];
		const { handoff } = makeHandoff({ brokerState, accepted });
		const finalPayload = payload();
		await handoff.prepareForHandoff(finalPayload);
		await handoff.enqueueAbortedFinal(finalPayload.turn);
		await handoff.processPendingClientFinalFiles();
		assert(accepted.length === 1 && accepted[0]?.text === "final", "prepared real final should beat stale stand-down cleanup before send starts");
	}
	{
		const disconnectedTurns = new Set<string>();
		const { handoff } = makeHandoff({ disconnectedTurns });
		const finalPayload = payload();
		await handoff.prepareForHandoff(finalPayload);
		disconnectedTurns.add(finalPayload.turn.turnId);
		const pendingPath = join(handoff.pendingFinalsDir(), "session-1.json");
		assert((await handoff.send(finalPayload)) === true, "prepared disconnected final can be left for broker handoff");
		assert(await exists(pendingPath), "prepared final file must survive disconnected finalize continuation");
		assert(!handoff.deferNewFinals(), "prepared disconnected final should not keep the local retry queue occupied");
		await rm(pendingPath, { force: true });
	}
	{
		const disconnectedTurns = new Set<string>();
		let postSucceeds = false;
		const { handoff } = makeHandoff({ disconnectedTurns, postSucceeds: () => postSucceeds });
		const first = payload("turn-1");
		await handoff.prepareForHandoff(first);
		disconnectedTurns.add(first.turn.turnId);
		await handoff.send(first);
		assert(!handoff.deferNewFinals(), "disk-only prepared final should not block later local handoff attempts");
		const second = payload("turn-2");
		assert((await handoff.send(second)) === false, "later failed handoff should queue behind disk-only prepared final");
		postSucceeds = true;
		await handoff.retryPending();
		const persistedAfterRetry = JSON.parse(await readFile(join(handoff.pendingFinalsDir(), "session-1.json"), "utf8")) as { payloads?: AssistantFinalPayload[] };
		assert(persistedAfterRetry.payloads?.length === 1 && persistedAfterRetry.payloads[0]?.turn.turnId === "turn-1", "later queue persistence must not drop disk-only prepared final");
		await rm(join(handoff.pendingFinalsDir(), "session-1.json"), { force: true });
	}
	{
		const disconnectedTurns = new Set<string>();
		let postSucceeds = false;
		const client = makeHandoff({ disconnectedTurns, postSucceeds: () => postSucceeds });
		const first = payload("turn-1");
		await client.handoff.prepareForHandoff(first);
		disconnectedTurns.add(first.turn.turnId);
		await client.handoff.send(first);
		const brokerState = state();
		brokerState.sessions["session-1"] = { sessionId: "session-1", ownerId: "owner", pid: process.pid, cwd: process.cwd(), projectName: "project", connectedAtMs: now(), connectionStartedAtMs: 10, connectionNonce: "conn-current", clientSocketPath: "client", status: "connecting", queuedTurnCount: 0, lastHeartbeatMs: now(), topicName: "topic" };
		const broker = makeHandoff({ brokerState, accepted: [] });
		await broker.handoff.processPendingClientFinalFiles();
		const second = payload("turn-2");
		await client.handoff.send(second);
		const resurrected = JSON.parse(await readFile(join(client.handoff.pendingFinalsDir(), "session-1.json"), "utf8")) as { payloads?: AssistantFinalPayload[] };
		assert(resurrected.payloads?.every((candidate) => candidate.turn.turnId !== "turn-1"), "client persist after broker cleanup must not resurrect disk-only accepted final");
		postSucceeds = true;
		await rm(join(client.handoff.pendingFinalsDir(), "session-1.json"), { force: true });
	}
	{
		const brokerState = state();
		brokerState.sessions["session-1"] = { sessionId: "session-1", ownerId: "owner", pid: process.pid, cwd: process.cwd(), projectName: "project", connectedAtMs: now(), connectionStartedAtMs: 20, connectionNonce: "conn-new", clientSocketPath: "client", status: "connecting", queuedTurnCount: 0, lastHeartbeatMs: now(), topicName: "topic", staleStandDownConnectionNonce: "conn-current", staleStandDownRequestedAtMs: now() };
		const accepted: AssistantFinalPayload[] = [];
		let handoffRef: ClientAssistantFinalHandoff | undefined;
		const made = makeHandoff({
			brokerState,
			accepted,
			postAssistantFinal: async (finalPayload) => {
				await handoffRef!.enqueueAbortedFinal(finalPayload.turn);
				await handoffRef!.processPendingClientFinalFiles();
				throw new Error("stale_session_connection");
			},
		});
		handoffRef = made.handoff;
		assert((await made.handoff.send(payload())) === false, "stale send should remain pending after broker-owned interleaving");
		assert(accepted.length === 1 && accepted[0]?.text === "final", "broker-owned stale interleaving should accept the real final, not aborted cleanup");
	}
	{
		const { handoff } = makeHandoff({ postSucceeds: () => { throw new Error("stale_session_connection"); } });
		const finalPayload = payload();
		await handoff.enqueueAbortedFinal(finalPayload.turn);
		assert((await handoff.send(finalPayload)) === false, "stale broker handoff should keep the real final pending");
		const persisted = JSON.parse(await readFile(join(handoff.pendingFinalsDir(), "session-1.json"), "utf8")) as { payloads?: AssistantFinalPayload[] };
		assert(persisted.payloads?.[0]?.text === "final", "real final text should replace stale stand-down aborted cleanup for the same turn");
		assert(persisted.payloads?.[0]?.stopReason !== "aborted", "stale stand-down cleanup must not supersede the real final");
	}
	{
		const brokerState = state();
		brokerState.sessions["session-1"] = { sessionId: "session-1", ownerId: "owner", pid: process.pid, cwd: process.cwd(), projectName: "project", connectedAtMs: now(), connectionStartedAtMs: 20, connectionNonce: "conn-new", clientSocketPath: "client", status: "idle", queuedTurnCount: 0, lastHeartbeatMs: now(), topicName: "topic" };
		const accepted: AssistantFinalPayload[] = [];
		const { handoff } = makeHandoff({ brokerState, accepted, connectionNonce: "conn-old", connectionStartedAtMs: 10 });
		await writeFile(join(handoff.pendingFinalsDir(), "session-1.json"), JSON.stringify({ schemaVersion: 2, sessionId: "session-1", connectionNonce: "conn-old", connectionStartedAtMs: 10, payloads: [payload()] }));
		await handoff.processPendingClientFinalFiles();
		assert(accepted.length === 0, "replacement without stale stand-down fence must not mutate broker final state");
		assert(!(await exists(join(handoff.pendingFinalsDir(), "session-1.json"))), "unfenced stale pending-final file should be discarded");
	}
	{
		const brokerState = state();
		const accepted: AssistantFinalPayload[] = [];
		const invalidPaths: string[] = [];
		const { handoff } = makeHandoff({ brokerState, accepted, reportInvalidDurableState: (path) => { invalidPaths.push(path); } });
		await mkdir(handoff.pendingFinalsDir(), { recursive: true });
		const invalidPath = join(handoff.pendingFinalsDir(), "bad-session.json");
		const malformedPath = join(handoff.pendingFinalsDir(), "malformed-session.json");
		const validPath = join(handoff.pendingFinalsDir(), "session-1.json");
		await writeFile(invalidPath, JSON.stringify({ schemaVersion: 2, sessionId: "bad-session", connectionNonce: "conn-current", connectionStartedAtMs: 10, payloads: [{ turn: { turnId: "bad-turn" }, attachments: [] }] }));
		await writeFile(malformedPath, "{not-json}\n");
		await writeFile(validPath, JSON.stringify({ schemaVersion: 2, sessionId: "session-1", connectionNonce: "conn-current", connectionStartedAtMs: 10, payloads: [payload()] }));
		await handoff.processPendingClientFinalFiles();
		assert(accepted.some((candidate) => candidate.turn.turnId === "turn-1"), "valid pending-final file should still be processed when other files are bad");
		assert(await exists(invalidPath), "schema-invalid pending-final file should be preserved");
		assert(await exists(malformedPath), "malformed pending-final file should be preserved");
		assert(!(await exists(validPath)), "valid pending-final file should be removed after processing");
		assert(invalidPaths.includes(invalidPath) && invalidPaths.includes(malformedPath), "bad pending-final files should be reported with their paths");
	}
	{
		const brokerState = state();
		brokerState.sessions["session-1"] = { sessionId: "session-1", ownerId: "owner", pid: process.pid, cwd: process.cwd(), projectName: "project", connectedAtMs: now(), connectionStartedAtMs: 20, connectionNonce: "conn-new", clientSocketPath: "client", status: "connecting", queuedTurnCount: 0, lastHeartbeatMs: now(), topicName: "topic", staleStandDownConnectionNonce: "conn-old", staleStandDownRequestedAtMs: now() };
		const accepted: AssistantFinalPayload[] = [];
		const { handoff } = makeHandoff({ brokerState, accepted, connectionNonce: "conn-old", connectionStartedAtMs: 10 });
		await writeFile(join(handoff.pendingFinalsDir(), "session-1.json"), JSON.stringify({ schemaVersion: 2, sessionId: "session-1", connectionNonce: "conn-old", connectionStartedAtMs: 10, payloads: [payload()] }));
		await handoff.processPendingClientFinalFiles();
		await handoff.processPendingClientFinalFiles();
		assert(accepted.length === 1, "stale stand-down handoff should converge on one broker final ledger entry");
		assert(!(await exists(join(handoff.pendingFinalsDir(), "session-1.json"))), "accepted stale-stand-down pending-final file should be removed");
	}
	await rm(brokerBase, { recursive: true, force: true });
	console.log("Client final handoff checks passed");
}

void run();
