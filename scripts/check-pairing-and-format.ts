import assert from "node:assert/strict";

import { formatLocalUserMirrorMessage, topicNameFor } from "../src/shared/format.js";
import { clearPairingState, isMessageBeforePairingWindow, isPairingPending, PAIRING_MAX_FAILED_ATTEMPTS, PAIRING_PIN_TTL_MS, pairingCandidateFromText } from "../src/shared/pairing.js";
import type { TelegramMessage } from "../src/telegram/types.js";
import type { TelegramConfig } from "../src/shared/config-types.js";

function message(date?: number): TelegramMessage {
	return {
		message_id: 1,
		date,
		chat: { id: 1, type: "private" },
		from: { id: 10, is_bot: false, first_name: "Test" },
		text: "1234",
	};
}

function assertPairingParsing(): void {
	assert.equal(pairingCandidateFromText("1234"), "1234");
	assert.equal(pairingCandidateFromText(" 1234 "), "1234");
	assert.equal(pairingCandidateFromText("/start 1234"), "1234");
	assert.equal(pairingCandidateFromText("/start@some_bot 1234"), "1234");
	assert.equal(pairingCandidateFromText("/start"), undefined);
	assert.equal(pairingCandidateFromText("pin 1234"), undefined);
	assert.equal(pairingCandidateFromText("12345"), undefined);
}

function assertPairingWindow(): void {
	const now = 10_000;
	const active: TelegramConfig = { pairingCodeHash: "hash", pairingCreatedAtMs: now, pairingExpiresAtMs: now + PAIRING_PIN_TTL_MS };
	assert.equal(isPairingPending(active, now), true);
	assert.equal(isPairingPending({ ...active, allowedUserId: 10 }, now), false);
	assert.equal(isPairingPending({ ...active, pairingExpiresAtMs: now }, now), false);
	assert.equal(isMessageBeforePairingWindow(message(9), active), true);
	assert.equal(isMessageBeforePairingWindow(message(10), active), false);
	assert.equal(isMessageBeforePairingWindow(message(undefined), active), false);
	const subsecondSetup: TelegramConfig = { ...active, pairingCreatedAtMs: 10_500 };
	assert.equal(isMessageBeforePairingWindow(message(10), subsecondSetup), false);
	assert.equal(isMessageBeforePairingWindow(message(9), subsecondSetup), true);
	assert.equal(PAIRING_MAX_FAILED_ATTEMPTS, 5);
}

function assertPairingClear(): void {
	const config = clearPairingState({ pairingCodeHash: "hash", pairingCreatedAtMs: 1, pairingExpiresAtMs: 2, pairingFailedAttempts: 3, allowedUserId: 10 });
	assert.equal(config.allowedUserId, 10);
	assert.equal(config.pairingCodeHash, undefined);
	assert.equal(config.pairingCreatedAtMs, undefined);
	assert.equal(config.pairingExpiresAtMs, undefined);
	assert.equal(config.pairingFailedAttempts, undefined);
}

function assertLocalUserMirrorFormatting(): void {
	assert.equal(formatLocalUserMirrorMessage("hello"), "[PI User]: hello");
	assert.equal(formatLocalUserMirrorMessage("<b>literal</b>", 2), "[PI User]: <b>literal</b>\n\n[2 image(s) attached in pi]");
}

function assertTopicNameFormatting(): void {
	assert.equal(topicNameFor({ projectName: "pi-telegram", gitBranch: "main", sessionId: "session-1" }), "pi-telegram");
	assert.equal(topicNameFor({ projectName: "pi-telegram", gitBranch: " feature/test ", sessionId: "session-1" }), "pi-telegram · feature/test");
	assert.equal(topicNameFor({ projectName: "pi-telegram", gitBranch: "MAIN", piSessionName: "Review", sessionId: "session-1" }), "pi-telegram · Review");
	assert.equal(topicNameFor({ projectName: "pi-telegram", gitBranch: "dev", piSessionName: "DEV", sessionId: "session-1" }), "pi-telegram · dev");
	const truncated = topicNameFor({
		projectName: "p".repeat(70),
		gitBranch: "feature/".concat("x".repeat(70)),
		piSessionName: "session-name",
		sessionId: "session-1",
	});
	assert.equal(truncated.length <= 128, true);
	assert.match(truncated, /… [0-9a-f]{6}$/);
}

assertPairingParsing();
assertPairingWindow();
assertPairingClear();
assertLocalUserMirrorFormatting();
assertTopicNameFormatting();
console.log("Pairing and local-user mirror checks passed");
