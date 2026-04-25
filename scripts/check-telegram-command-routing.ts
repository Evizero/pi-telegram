import assert from "node:assert/strict";

import { TelegramCommandRouter } from "../src/broker/commands.js";
import type { BrokerState, PendingTelegramTurn, SessionRegistration, TelegramMessage } from "../src/shared/types.js";

function session(): SessionRegistration {
	return {
		sessionId: "session-1",
		ownerId: "owner-1",
		pid: 123,
		cwd: "/tmp/project",
		projectName: "project",
		status: "busy",
		queuedTurnCount: 0,
		lastHeartbeatMs: Date.now(),
		connectedAtMs: Date.now(),
		clientSocketPath: "/tmp/client.sock",
		topicName: "project · main",
	};
}

function state(): BrokerState {
	const currentSession = session();
	return {
		schemaVersion: 1,
		recentUpdateIds: [],
		sessions: { [currentSession.sessionId]: currentSession },
		routes: {
			"123:9": {
				routeId: "123:9",
				sessionId: currentSession.sessionId,
				chatId: 123,
				messageThreadId: 9,
				routeMode: "forum_supergroup_topic",
				topicName: currentSession.topicName,
				createdAtMs: Date.now(),
				updatedAtMs: Date.now(),
			},
		},
		pendingTurns: {},
		pendingAssistantFinals: {},
		completedTurnIds: [],
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
	};
}

function message(text: string): TelegramMessage {
	return {
		message_id: Math.floor(Math.random() * 1000),
		message_thread_id: 9,
		chat: { id: 123, type: "supergroup", is_forum: true },
		from: { id: 456, is_bot: false, first_name: "User" },
		text,
	};
}

async function checkCommandRoutingPreservesCompactStopFollowAndPlainTurns(): Promise<void> {
	const brokerState = state();
	const ipcCalls: Array<{ type: string; payload: unknown; target?: string }> = [];
	const sentReplies: string[] = [];
	let turnCounter = 0;
	const router = new TelegramCommandRouter({
		getBrokerState: () => brokerState,
		persistBrokerState: async () => undefined,
		markOfflineSessions: async () => undefined,
		createTelegramTurnForSession: async (messages, sessionIdForTurn) => ({
			turnId: `turn-${++turnCounter}`,
			sessionId: sessionIdForTurn,
			chatId: messages[0]!.chat.id,
			messageThreadId: messages[0]!.message_thread_id,
			replyToMessageId: messages[0]!.message_id,
			queuedAttachments: [],
			content: [{ type: "text", text: messages[0]!.text ?? "" }],
			historyText: messages[0]!.text ?? "",
		}) satisfies PendingTelegramTurn,
		durableTelegramTurn: (turn) => turn,
		sendTextReply: async (_chatId, _threadId, text) => { sentReplies.push(text); return 99; },
		postIpc: async <TResponse>(_socketPath: string, type: string, payload: unknown, targetSessionId?: string) => {
			ipcCalls.push({ type, payload, target: targetSessionId });
			if (type === "compact_session") return { text: "Compaction started." } as TResponse;
			if (type === "abort_turn") return { text: "Aborted current turn.", clearedTurnIds: ["active"] } as TResponse;
			if (type === "deliver_turn") return { accepted: true } as TResponse;
			throw new Error(`unexpected IPC type ${type}`);
		},
		stopTypingLoop: () => undefined,
		unregisterSession: async () => undefined,
		brokerInfo: () => "broker",
	});

	await router.dispatch([message("/compact")]);
	await router.dispatch([message("/stop")]);
	await router.dispatch([message("/follow after this")]);
	await router.dispatch([message("steer now")]);

	assert.deepEqual(ipcCalls.map((call) => call.type), ["compact_session", "abort_turn", "deliver_turn", "deliver_turn"]);
	assert.deepEqual(sentReplies, ["Compaction started.", "Aborted current turn."]);
	const followTurn = ipcCalls[2]!.payload as PendingTelegramTurn;
	const plainTurn = ipcCalls[3]!.payload as PendingTelegramTurn;
	assert.equal(followTurn.deliveryMode, "followUp");
	assert.equal(followTurn.content[0]?.type, "text");
	assert.equal(followTurn.historyText, "after this");
	assert.equal(plainTurn.deliveryMode, undefined);
	assert.equal(plainTurn.historyText, "steer now");
	assert.equal(ipcCalls.every((call) => call.target === "session-1"), true);
}

await checkCommandRoutingPreservesCompactStopFollowAndPlainTurns();
console.log("Telegram command routing checks passed");
