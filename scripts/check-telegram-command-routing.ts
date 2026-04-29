import assert from "node:assert/strict";

import type { PendingTelegramTurn } from "../src/shared/types.js";
import { createRouter, message, state } from "./support/telegram-command-fixtures.js";
import type { IpcCall } from "./support/telegram-command-fixtures.js";

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

await checkCommandRoutingPreservesCompactStopFollowSteerAndPlainTurns();
console.log("Telegram command routing checks passed");
