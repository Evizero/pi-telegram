---
title: "Implement attended PIN pairing flow"
status: "done"
priority: 3
created: "2026-04-25"
updated: "2026-04-25"
author: "Christof Salis"
assignee: "pi-agent"
labels: ["ux", "pairing", "next"]
traces_to: ["SyRS-pair-one-user", "SyRS-reject-unauthorized-telegram", "SyRS-bridge-secret-privacy"]
source_inbox: "simpler-mobile-pairing-pin"
branch: "task/implement-attended-pin-pairing-flow"
---
## Objective

Make first-time mobile pairing easier by replacing the long typed `/start <code>` experience with an attended four-digit PIN flow, while preserving the single-paired-user and fail-closed authorization model.

## Scope

- Generate a four-digit visible pairing PIN during `/telegram-setup` and expire it after five minutes.
- Accept the PIN in private chat as plain text, and keep `/start <PIN>` / Telegram deep-link style input as a compatible fallback.
- Pair only the first private Telegram user who supplies the current valid PIN; then record `allowedUserId` / `allowedChatId`, clear the pending pairing secret and attempt counter, and run the existing route-after-pairing behavior.
- Bound failed PIN guesses during the setup window, with a concrete implementation limit such as five wrong attempts before setup must be rerun.
- Reject wrong, expired, group, bot, stale pre-setup, or post-pairing unauthorized inputs without creating pi turns, steering, follow-ups, file downloads, or commands.
- Update setup instructions in `src/shared/ui-status.ts`, user docs in `README.md`, Telegram integration notes in `docs.md`, and the setup/pairing scenario in `dev/ARCHITECTURE.md` so they no longer describe the long `/start <code>` flow as the target behavior.

## Codebase Grounding

Likely runtime touchpoints are `src/extension.ts` (`promptForConfig()` PIN generation and expiry), `src/broker/updates.ts` (pre-pairing update handling), `src/shared/ui-status.ts` (local setup instructions), and existing config persistence in `src/shared/config.ts` / `src/shared/types.ts` if naming or comments need clarification. Keep the stored secret hashed; do not store or log bot tokens or raw secrets beyond the transient setup display.

## Acceptance Criteria

- `/telegram-setup` shows a four-digit PIN with a five-minute pairing window and mobile-friendly instructions.
- A private message containing the exact PIN pairs the sender; `/start <PIN>` still pairs for deep-link/fallback compatibility.
- Wrong, expired, group, bot, stale pre-setup, and already-unauthorized inputs do not pair and do not reach session-control paths.
- Repeated failed PIN guesses are bounded during the setup window, and the chosen limit is covered by validation.
- Successful pairing still binds exactly one Telegram user/chat and clears pending pairing state and any failed-attempt counter.
- Documentation and architecture references to the previous long `/start <code>` flow are updated coherently.

## Preserved Behavior

- Exactly one paired Telegram user controls the bridge.
- Unauthorized Telegram updates remain rejected before command, turn, attachment, steering, follow-up, or stop handling.
- Pending updates are still not skipped during an active pairing window, so the first valid pairing message can be consumed.
- Pre-setup stale updates should not be allowed to pair the bridge after a new setup window opens.
- Bot token and bridge configuration privacy remain intact.

## Out of Scope

- Multi-user or team pairing.
- Local identity-confirmation prompts after the PIN is entered.
- A hosted relay, webhook setup, or broader Telegram setup redesign.
- Changing topic routing, session selection, or ordinary command semantics.

## Validation

Run `npm run check`. The check suite now includes `scripts/check-pairing-and-format.ts` helper-level coverage for PIN parsing, pairing-window expiry/staleness, pairing-state clearing, failed-attempt limit constants, and local-user mirror formatting. Review the runtime pairing gate in `src/broker/updates.ts` for group/bot rejection, unauthorized post-pairing rejection, persisted failed-attempt limiting, and active-pairing pending-update behavior.

## Coordination Note

This task is intended to be implemented in the same near-term slice as `format-pi-user-telegram`, but it should remain independently reviewable because it touches authorization behavior.

## Decisions

- 2026-04-25: Implementation uses a persisted pairingCreatedAtMs plus pairingFailedAttempts in TelegramConfig. Pending pairing requires a current hash, creation time, and expiry; old pre-PIN pending pairing state is cleared and setup must be rerun. Wrong PIN candidates are limited to five attempts before the pairing state is cleared.
- 2026-04-25: Review found Telegram message dates are second-granular, so stale-pre-setup detection now compares message.date against floor(pairingCreatedAtMs / 1000) and allows messages from the setup second.
- 2026-04-25: Review found /topicsetup could bypass the general pairing/authorization gate. Update handling now performs pairing and paired-user authorization before command-specific topic setup, while still allowing an already paired authorized user to run /topicsetup in a forum group.
- 2026-04-25: Review found pre-authorization media groups could be queued before pairing and then dispatched after pairing. Media-group queuing now requires the message to already be from the paired user in an allowed chat at receipt time; otherwise the update goes through the normal pairing/authorization gate and is not batched for later dispatch.
