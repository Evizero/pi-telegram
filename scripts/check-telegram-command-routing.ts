import assert from "node:assert/strict";

import type { PendingTelegramTurn, TelegramMessage } from "../src/shared/types.js";
import { createRouter, message, state } from "./support/telegram-command-fixtures.js";
import type { IpcCall } from "./support/telegram-command-fixtures.js";

function privateMessage(text: string): TelegramMessage {
	return {
		message_id: Math.floor(Math.random() * 1000),
		chat: { id: 123, type: "private" },
		from: { id: 456, is_bot: false, first_name: "User" },
		text,
	};
}

async function checkCommandRoutingPreservesCompactStopFollowSteerAndPlainTurns(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	let turnCounter = 0;
	const router = createRouter(brokerState, ipcCalls, sentReplies, [], () => ++turnCounter);

	await router.dispatch([message("/compact")]);
	await router.dispatch([message("/stop")]);
	await router.dispatch([message("/follow after this")]);
	await router.dispatch([message("/steer steer now")]);
	await router.dispatch([message("plain follow-up by default")]);

	assert.deepEqual(ipcCalls.map((call) => call.type), ["compact_session", "abort_turn", "deliver_turn", "deliver_turn", "deliver_turn"]);
	assert.deepEqual(sentReplies, ["Compaction started.", "Aborted current turn."]);
	const followTurn = ipcCalls[2]!.payload as PendingTelegramTurn;
	const steerTurn = ipcCalls[3]!.payload as PendingTelegramTurn;
	const plainTurn = ipcCalls[4]!.payload as PendingTelegramTurn;
	assert.equal(followTurn.deliveryMode, "followUp");
	assert.equal(followTurn.content[0]?.type, "text");
	assert.equal(followTurn.historyText, "after this");
	assert.equal(steerTurn.deliveryMode, "steer");
	assert.equal(steerTurn.historyText, "steer now");
	assert.equal(plainTurn.deliveryMode, undefined);
	assert.equal(plainTurn.historyText, "plain follow-up by default");
	assert.equal(ipcCalls.every((call) => call.target === "session-1"), true);
}

async function checkUseSelectorRouteCleansStaleTopicRoute(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, []);

	await router.dispatch([privateMessage("/use 1")]);

	assert.deepEqual(ipcCalls, []);
	assert.ok(sentReplies.some((reply) => /selected/i.test(reply)));
	assert.equal(brokerState.routes["123:9"], undefined);
	assert.ok(brokerState.pendingRouteCleanups?.["123:9"]);
	assert.ok(brokerState.routes["123:default:session-1"]);
}

async function checkUseDoesNotCreateSelectorRouteWhenRoutingDisabled(): Promise<void> {
	const brokerState = state();
	const ipcCalls: IpcCall[] = [];
	const sentReplies: string[] = [];
	const router = createRouter(brokerState, ipcCalls, sentReplies, [], () => 1, undefined, undefined, undefined, { allowedChatId: 123, topicMode: "disabled", fallbackMode: "disabled" });

	await router.dispatch([privateMessage("/use 1")]);

	assert.deepEqual(ipcCalls, []);
	assert.ok(sentReplies.some((reply) => /routing is disabled/i.test(reply)));
	assert.equal(brokerState.selectorSelections?.["123"], undefined);
	assert.equal(brokerState.routes["123:default:session-1"], undefined);
}

await checkCommandRoutingPreservesCompactStopFollowSteerAndPlainTurns();
await checkUseSelectorRouteCleansStaleTopicRoute();
await checkUseDoesNotCreateSelectorRouteWhenRoutingDisabled();
console.log("Telegram command routing checks passed");
