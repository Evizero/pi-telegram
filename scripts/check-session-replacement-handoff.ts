import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { consumeSessionReplacementHandoffInBroker, findMatchingSessionReplacementHandoff, writeSessionReplacementHandoff } from "../src/client/session-replacement.js";
import type { BrokerState, PendingAssistantFinalDelivery, PendingTelegramTurn, SessionRegistration, TelegramRoute } from "../src/shared/types.js";

function route(sessionId: string): TelegramRoute {
	return {
		routeId: "111:9",
		sessionId,
		chatId: 111,
		messageThreadId: 9,
		routeMode: "forum_supergroup_topic",
		topicName: "old topic",
		createdAtMs: 1,
		updatedAtMs: 1,
	};
}

function registration(sessionId: string, replacement?: SessionRegistration["replacement"]): SessionRegistration {
	return {
		sessionId,
		ownerId: `owner-${sessionId}`,
		pid: 123,
		cwd: "/tmp/project",
		projectName: "project",
		status: "idle",
		queuedTurnCount: 0,
		lastHeartbeatMs: 10,
		connectedAtMs: 10,
		connectionStartedAtMs: 10,
		connectionNonce: `conn-${sessionId}`,
		clientSocketPath: `/tmp/${sessionId}.sock`,
		topicName: "new topic",
		replacement,
	};
}

function turn(sessionId: string): PendingTelegramTurn {
	return {
		turnId: "turn-1",
		sessionId,
		routeId: "111:9",
		chatId: 111,
		messageThreadId: 9,
		replyToMessageId: 1,
		queuedAttachments: [],
		content: [],
		historyText: "pending",
	};
}

function final(sessionId: string): PendingAssistantFinalDelivery {
	return {
		turn: turn(sessionId),
		text: "done",
		attachments: [],
		status: "pending",
		createdAtMs: 10,
		updatedAtMs: 10,
		progress: { sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] },
	};
}

function state(): BrokerState {
	const oldRoute = route("old-session");
	return {
		schemaVersion: 1,
		recentUpdateIds: [],
		sessions: { "old-session": registration("old-session") },
		routes: { [oldRoute.routeId]: oldRoute },
		selectorSelections: { "111": { chatId: 111, sessionId: "old-session", expiresAtMs: 10_000, updatedAtMs: 1 } },
		pendingTurns: { "turn-1": { turn: turn("old-session"), updatedAtMs: 1 } },
		pendingAssistantFinals: { "final-1": final("old-session") },
		pendingRouteCleanups: { [oldRoute.routeId]: { route: oldRoute, createdAtMs: 1, updatedAtMs: 1 } },
		pendingManualCompactions: {
			"compact-1": { operationId: "compact-1", sessionId: "old-session", routeId: oldRoute.routeId, chatId: oldRoute.chatId, messageThreadId: oldRoute.messageThreadId, status: "queued", createdAtMs: 1, updatedAtMs: 1 },
		},
		queuedTurnControls: {
			"control-1": {
				token: "control-1",
				turnId: "turn-1",
				sessionId: "old-session",
				routeId: oldRoute.routeId,
				chatId: oldRoute.chatId,
				messageThreadId: oldRoute.messageThreadId,
				statusMessageId: 70,
				status: "offered",
				createdAtMs: 1,
				updatedAtMs: 1,
				expiresAtMs: 10_000,
			},
		},
		createdAtMs: 1,
		updatedAtMs: 1,
	};
}

async function checkMatchingAndMismatchedHandoff(): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-telegram-handoff-"));
	try {
		await writeSessionReplacementHandoff({
			dir,
			reason: "new",
			oldSessionId: "old-session",
			oldSessionFile: "/sessions/old.jsonl",
			targetSessionFile: "/sessions/new.jsonl",
			route: route("old-session"),
			nowMs: 1,
		});
		assert.equal(await findMatchingSessionReplacementHandoff({ dir, context: { reason: "new", previousSessionFile: "/sessions/old.jsonl", sessionFile: "/sessions/other.jsonl" }, nowMs: 2 }), undefined);
		assert.ok(await findMatchingSessionReplacementHandoff({ dir, context: { reason: "new", previousSessionFile: "/sessions/old.jsonl", sessionFile: "/sessions/new.jsonl" }, nowMs: 2 }));
		assert.equal(await findMatchingSessionReplacementHandoff({ dir, context: { reason: "resume", previousSessionFile: "/sessions/old.jsonl", sessionFile: "/sessions/new.jsonl" }, nowMs: 2 }), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function exists(path: string): Promise<boolean> {
	return await stat(path).then(() => true, () => false);
}

async function checkInvalidHandoffFilesDoNotBlockValidMatch(): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-telegram-handoff-"));
	try {
		const invalidPath = join(dir, "bad.json");
		const malformedPath = join(dir, "malformed.json");
		await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, reason: "new", oldSessionId: "old-session", createdAtMs: 1, expiresAtMs: 10_000 }));
		await writeFile(malformedPath, "{not-json}\n");
		await writeSessionReplacementHandoff({
			dir,
			reason: "new",
			oldSessionId: "old-session",
			oldSessionFile: "/sessions/old.jsonl",
			targetSessionFile: "/sessions/new.jsonl",
			route: route("old-session"),
			nowMs: 1,
		});
		const invalidPaths: string[] = [];
		const match = await findMatchingSessionReplacementHandoff({ dir, context: { reason: "new", previousSessionFile: "/sessions/old.jsonl", sessionFile: "/sessions/new.jsonl" }, nowMs: 2, onInvalidHandoff: (path) => { invalidPaths.push(path); } });
		assert.ok(match, "valid replacement handoff should still be found when other files are bad");
		assert(invalidPaths.includes(invalidPath));
		assert(invalidPaths.includes(malformedPath));
		assert(await exists(invalidPath), "schema-invalid handoff should be preserved");
		assert(await exists(malformedPath), "malformed handoff should be preserved");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function checkConsumeRetargetsBrokerState(): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-telegram-handoff-"));
	try {
		await writeSessionReplacementHandoff({
			dir,
			reason: "fork",
			oldSessionId: "old-session",
			oldSessionFile: "/sessions/old.jsonl",
			targetSessionFile: "/sessions/fork.jsonl",
			route: route("old-session"),
			nowMs: 1,
		});
		const brokerState = state();
		brokerState.routes["111:unrelated-session"] = { ...route("unrelated-session"), routeMode: "single_chat_selector", routeId: "111", messageThreadId: undefined };
		const consumed = await consumeSessionReplacementHandoffInBroker({
			dir,
			brokerState,
			registration: registration("new-session", { reason: "fork", previousSessionFile: "/sessions/old.jsonl", sessionFile: "/sessions/fork.jsonl" }),
			nowMs: 2,
		});
		assert.equal(consumed, true);
		assert.equal(brokerState.sessions["old-session"], undefined);
		assert.equal(brokerState.routes["111:9"].sessionId, "new-session");
		assert.equal(brokerState.pendingRouteCleanups?.["111:9"], undefined);
		assert.equal(brokerState.routes["111:unrelated-session"].sessionId, "unrelated-session");
		assert.equal(brokerState.pendingTurns?.["turn-1"].turn.sessionId, "new-session");
		assert.equal(brokerState.pendingAssistantFinals?.["final-1"].turn.sessionId, "new-session");
		assert.equal(brokerState.pendingManualCompactions?.["compact-1"].sessionId, "new-session");
		assert.equal(brokerState.pendingManualCompactions?.["compact-1"].routeId, "111:9");
		assert.equal(brokerState.queuedTurnControls?.["control-1"].sessionId, "new-session");
		assert.equal(brokerState.queuedTurnControls?.["control-1"].routeId, "111:9");
		assert.equal(brokerState.selectorSelections?.["111"].sessionId, "new-session");
		const secondConsume = await consumeSessionReplacementHandoffInBroker({
			dir,
			brokerState,
			registration: registration("another-session", { reason: "fork", previousSessionFile: "/sessions/old.jsonl", sessionFile: "/sessions/fork.jsonl" }),
			nowMs: 3,
		});
		assert.equal(secondConsume, false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

await checkMatchingAndMismatchedHandoff();
await checkInvalidHandoffFilesDoNotBlockValidMatch();
await checkConsumeRetargetsBrokerState();
console.log("Session replacement handoff checks passed");
