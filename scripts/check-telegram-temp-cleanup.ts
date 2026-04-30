import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { markSessionOfflineInBroker, unregisterSessionFromBroker } from "../src/broker/sessions.js";
import type { BrokerState, PendingAssistantFinalDelivery, SessionRegistration, TelegramRoute } from "../src/broker/types.js";
import type { PendingTelegramTurn } from "../src/client/types.js";
import { TelegramApiError } from "../src/telegram/api-errors.js";
import { cleanupDownloadedTelegramSessionTempDirIfUnused, sweepOrphanedDownloadedTelegramSessionTempDirs } from "../src/telegram/temp-files.js";

function sessionRegistration(sessionId: string): SessionRegistration {
	return {
		sessionId,
		ownerId: `owner-${sessionId}`,
		pid: 123,
		cwd: "/tmp/project",
		projectName: "project",
		status: "idle",
		queuedTurnCount: 0,
		lastHeartbeatMs: Date.now(),
		connectedAtMs: Date.now(),
		connectionStartedAtMs: Date.now(),
		connectionNonce: `conn-${sessionId}`,
		clientSocketPath: `/tmp/${sessionId}.sock`,
		topicName: "project · main",
	};
}

function turn(sessionId: string, turnId = `turn-${sessionId}`): PendingTelegramTurn {
	return {
		turnId,
		sessionId,
		chatId: 111,
		messageThreadId: 9,
		replyToMessageId: 1,
		queuedAttachments: [],
		content: [{ type: "text", text: sessionId }],
		historyText: sessionId,
	};
}

function final(sessionId: string): PendingAssistantFinalDelivery {
	return {
		status: "pending",
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
		turn: turn(sessionId, `final-${sessionId}`),
		attachments: [],
		progress: { sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] },
	};
}

function route(sessionId: string): TelegramRoute {
	return {
		routeId: `${sessionId}:9`,
		sessionId,
		chatId: 111,
		messageThreadId: 9,
		routeMode: "forum_supergroup_topic",
		topicName: "project · main",
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
	};
}

function brokerState(overrides: Partial<BrokerState> = {}): BrokerState {
	return {
		schemaVersion: 1,
		recentUpdateIds: [],
		sessions: {},
		routes: {},
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
		...overrides,
	};
}

async function pathExists(path: string): Promise<boolean> {
	return await access(path).then(() => true).catch(() => false);
}

async function makeSessionDir(root: string, sessionId: string): Promise<string> {
	const dir = join(root, sessionId);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "attachment.txt"), sessionId, "utf8");
	return dir;
}

async function setDirMtime(path: string, timestampMs: number): Promise<void> {
	const when = new Date(timestampMs);
	await utimes(path, when, when);
}

async function checkCleanupSkipsLiveAndPendingSessions(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-telegram-temp-cleanup-"));
	try {
		const liveDir = await makeSessionDir(root, "live-session");
		const pendingTurnDir = await makeSessionDir(root, "pending-turn-session");
		const pendingFinalDir = await makeSessionDir(root, "pending-final-session");
		assert.equal(await cleanupDownloadedTelegramSessionTempDirIfUnused({
			sessionId: "live-session",
			brokerState: brokerState({ sessions: { "live-session": sessionRegistration("live-session") } }),
			tempDirRoot: root,
		}), false);
		assert.equal(await cleanupDownloadedTelegramSessionTempDirIfUnused({
			sessionId: "pending-turn-session",
			brokerState: brokerState({ pendingTurns: { pending: { turn: turn("pending-turn-session"), updatedAtMs: Date.now() } } }),
			tempDirRoot: root,
		}), false);
		assert.equal(await cleanupDownloadedTelegramSessionTempDirIfUnused({
			sessionId: "pending-final-session",
			brokerState: brokerState({ pendingAssistantFinals: { pending: final("pending-final-session") } }),
			tempDirRoot: root,
		}), false);
		assert.equal(await pathExists(liveDir), true);
		assert.equal(await pathExists(pendingTurnDir), true);
		assert.equal(await pathExists(pendingFinalDir), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function checkCleanupRemovesUnusedSessionDir(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-telegram-temp-cleanup-"));
	try {
		const orphanDir = await makeSessionDir(root, "orphan-session");
		assert.equal(await cleanupDownloadedTelegramSessionTempDirIfUnused({
			sessionId: "orphan-session",
			brokerState: brokerState(),
			tempDirRoot: root,
		}), true);
		assert.equal(await pathExists(orphanDir), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function checkUnregisterPathRemovesSessionTempDir(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-telegram-temp-cleanup-"));
	try {
		const registration = sessionRegistration("ended-session");
		const dir = await makeSessionDir(root, registration.sessionId);
		const stateWithSession = brokerState({
			sessions: { [registration.sessionId]: registration },
			routes: { [route(registration.sessionId).routeId]: route(registration.sessionId) },
			pendingTurns: { pending: { turn: turn(registration.sessionId), updatedAtMs: Date.now() } },
		});
		await unregisterSessionFromBroker({
			targetSessionId: registration.sessionId,
			getBrokerState: () => stateWithSession,
			loadBrokerState: async () => stateWithSession,
			setBrokerState: () => undefined,
			persistBrokerState: async () => undefined,
			refreshTelegramStatus: () => undefined,
			stopTypingLoop: () => undefined,
			callTelegram: async <TResponse>() => {
				throw new TelegramApiError("deleteForumTopic", "Too Many Requests", 429, 1);
				return undefined as TResponse;
			},
			cleanupSessionTempDir: async (sessionId, currentBrokerState) => {
				await cleanupDownloadedTelegramSessionTempDirIfUnused({ sessionId, brokerState: currentBrokerState, tempDirRoot: root });
			},
		});
		assert.equal(await pathExists(dir), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function checkOfflineCleanupAfterGraceRemovesOnlyUnusedSessionDir(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-telegram-temp-cleanup-"));
	try {
		const registration = sessionRegistration("offline-session");
		const dir = await makeSessionDir(root, registration.sessionId);
		const stateWithSession = brokerState({
			sessions: { [registration.sessionId]: registration },
			routes: { [route(registration.sessionId).routeId]: route(registration.sessionId) },
			pendingTurns: {},
			pendingAssistantFinals: {},
			assistantPreviewMessages: {},
		});
		await markSessionOfflineInBroker({
			targetSessionId: registration.sessionId,
			getBrokerState: () => stateWithSession,
			loadBrokerState: async () => stateWithSession,
			setBrokerState: () => undefined,
			persistBrokerState: async () => undefined,
			refreshTelegramStatus: () => undefined,
			stopTypingLoop: () => undefined,
			callTelegram: async <TResponse>() => {
				throw new TelegramApiError("deleteForumTopic", "Too Many Requests", 429, 1);
				return undefined as TResponse;
			},
			cleanupSessionTempDir: async (sessionId, currentBrokerState) => {
				await cleanupDownloadedTelegramSessionTempDirIfUnused({ sessionId, brokerState: currentBrokerState, tempDirRoot: root });
			},
		});
		assert.equal(await pathExists(dir), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function checkOfflineCleanupPreservesTempDirWhenPendingWorkRemains(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-telegram-temp-cleanup-"));
	try {
		const registration = sessionRegistration("pending-offline-session");
		const dir = await makeSessionDir(root, registration.sessionId);
		const stateWithSession = brokerState({
			sessions: { [registration.sessionId]: registration },
			routes: { [route(registration.sessionId).routeId]: route(registration.sessionId) },
			pendingTurns: { pending: { turn: turn(registration.sessionId), updatedAtMs: Date.now() } },
			pendingAssistantFinals: { pending: final(registration.sessionId) },
			assistantPreviewMessages: {},
		});
		await markSessionOfflineInBroker({
			targetSessionId: registration.sessionId,
			getBrokerState: () => stateWithSession,
			loadBrokerState: async () => stateWithSession,
			setBrokerState: () => undefined,
			persistBrokerState: async () => undefined,
			refreshTelegramStatus: () => undefined,
			stopTypingLoop: () => undefined,
			callTelegram: async <TResponse>() => {
				throw new TelegramApiError("deleteForumTopic", "Too Many Requests", 429, 1);
				return undefined as TResponse;
			},
			cleanupSessionTempDir: async (sessionId, currentBrokerState) => {
				await cleanupDownloadedTelegramSessionTempDirIfUnused({ sessionId, brokerState: currentBrokerState, tempDirRoot: root });
			},
		});
		assert.equal(await pathExists(dir), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function checkSweepRemovesOnlyOldUnusedSessionDirs(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-telegram-temp-cleanup-"));
	const nowMs = Date.now();
	try {
		const activeDir = await makeSessionDir(root, "active-session");
		const pendingTurnDir = await makeSessionDir(root, "pending-turn-session");
		const pendingFinalDir = await makeSessionDir(root, "pending-final-session");
		const oldOrphanDir = await makeSessionDir(root, "old-orphan-session");
		const recentOrphanDir = await makeSessionDir(root, "recent-orphan-session");
		await writeFile(join(root, "ignore-me.txt"), "ignore", "utf8");
		for (const dir of [activeDir, pendingTurnDir, pendingFinalDir, oldOrphanDir, recentOrphanDir]) {
			await setDirMtime(dir, nowMs - 10_000);
		}
		await setDirMtime(recentOrphanDir, nowMs - 100);
		const removed = await sweepOrphanedDownloadedTelegramSessionTempDirs({
			brokerState: brokerState({
				sessions: { "active-session": sessionRegistration("active-session") },
				pendingTurns: { pending: { turn: turn("pending-turn-session"), updatedAtMs: Date.now() } },
				pendingAssistantFinals: { pending: final("pending-final-session") },
			}),
			tempDirRoot: root,
			ttlMs: 1_000,
			nowMs,
		});
		assert.deepEqual(removed, ["old-orphan-session"]);
		assert.equal(await pathExists(activeDir), true);
		assert.equal(await pathExists(pendingTurnDir), true);
		assert.equal(await pathExists(pendingFinalDir), true);
		assert.equal(await pathExists(oldOrphanDir), false);
		assert.equal(await pathExists(recentOrphanDir), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

await checkCleanupSkipsLiveAndPendingSessions();
await checkCleanupRemovesUnusedSessionDir();
await checkUnregisterPathRemovesSessionTempDir();
await checkOfflineCleanupAfterGraceRemovesOnlyUnusedSessionDir();
await checkOfflineCleanupPreservesTempDirWhenPendingWorkRemains();
await checkSweepRemovesOnlyOldUnusedSessionDirs();
console.log("Telegram temp cleanup checks passed");
