import assert from "node:assert/strict";

import { formatLocalUserMirrorMessage } from "../src/shared/format.js";
import { clearPairingState, isMessageBeforePairingWindow, isPairingPending, PAIRING_MAX_FAILED_ATTEMPTS, PAIRING_PIN_TTL_MS, pairingCandidateFromText } from "../src/shared/pairing.js";
import type { TelegramConfig, TelegramMessage } from "../src/shared/types.js";

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
	assert.equal(formatLocalUserMirrorMessage("hello"), "PI User Message\n\nhello");
	assert.equal(formatLocalUserMirrorMessage("<b>literal</b>", 2), "PI User Message\n\n<b>literal</b>\n\n[2 image(s) attached in pi]");
}

assertPairingParsing();
assertPairingWindow();
assertPairingClear();
assertLocalUserMirrorFormatting();
console.log("Pairing and local-user mirror checks passed");
