---
title: "Simpler mobile pairing PIN"
type: "request"
created: "2026-04-25"
author: "Christof Salis"
status: "open"
planned_as: []
---
Source note from user (2026-04-25):

> i dont think a new user should have to type that (for a mobile phone) long code. 4 digit pin is fine to pair isnt it. does it even need a command?

Preserved questions / desired direction:

- Reduce first-time Telegram/mobile pairing friction.
- Consider replacing the current long code with a short 4-digit PIN if that is safe enough for the pairing threat model.
- Investigate whether pairing should require typing a Telegram command at all, or whether a simpler bot interaction can initiate/complete pairing.

Notes for later planning:

- Balance mobile ergonomics against bot-token/account hijack and accidental pairing risks.
- Clarify whether the pairing code is only useful during a short local setup window, whether attempts are rate-limited, and whether pairing requires local confirmation in pi.


## Deep dive / opinion (2026-04-25)

Current implementation and planning constraints:

- `/telegram-setup` collects the bot token, calls `getMe`, then generates `randomBytes(5).toString("base64url")` as a pairing code, stores only `pairingCodeHash`, and expires it after 10 minutes. That is about 40 bits of secret before hashing.
- The bot pairs the first private Telegram user who sends `/start <code>` while the hash and expiry are current. It then records `allowedUserId` and `allowedChatId` and clears the pairing hash.
- Current polling intentionally does not skip pending updates while pairing is pending, so the first `/start <code>` can be received.
- Current docs/architecture/requirements say pairing is through a generated `/start <code>` and exactly one paired user controls the bridge. Changing this flow needs planning updates, not only code edits.

Threat-model read:

- A 4-digit PIN is only ~13.3 bits. With the current no-attempt-counter flow, it is too weak as the only remote secret for a bot that can control local pi sessions. Telegram/flood limits help, but they are not a crisp security boundary this project should rely on.
- A 4-digit PIN becomes much more acceptable if pairing also requires local confirmation in pi or strict global attempt limits plus a very short TTL. Since first-time setup already happens at the local computer, local confirmation is a natural fit.
- The current long code is not the real product requirement; the real requirement is explicit single-user pairing. We should reduce mobile typing friction without weakening that property.

Best direction, in my opinion:

1. Keep a high-entropy nonce internally.
2. Stop asking the phone user to type it. Show a `https://t.me/<bot_username>?start=<nonce>` deep link and, ideally, a QR code in pi. Telegram deep linking sends `/start <nonce>` to the bot after the user opens the link/taps Start, so the implementation can keep the command-based validation while the user does not type a command.
3. Keep textual `/start <nonce>` only as a fallback for weird clients or no-QR environments.
4. Consider adding local approval after the phone opens the link: pi shows the Telegram display name/username/id and asks the local user to approve. With local approval, the link nonce can remain strong but accidental/wrong-account pairing becomes easier to catch.

Answer to user questions:

- “Is a 4-digit PIN fine?” Not as the only factor in the current first-valid-code-wins design. Fine only with local confirmation and/or tight attempt limits.
- “Does it need a command?” Not from the user’s perspective. Telegram deep links still produce `/start <param>` under the hood, but the user can just tap a link or scan a QR code.


## User counterpoint (2026-04-25)

User challenged the attack likelihood: during first-time setup the operator is literally at the computer, pairing should happen within a couple minutes at most, and an attacker would first have to find/know the specific bot. This materially changes the practical risk assessment for a short PIN.

Planning implication:

- Reassess whether a 4-digit PIN is acceptable for an attended, very short pairing window when the bot username is not broadly discoverable.
- Distinguish cryptographic strength from practical product risk for a personal local-first bridge.
- Still account for stale/pending Telegram updates and accidental wrong-account pairing if considering “pair first private message” or no-command flows.


## Pairing direction refinement (2026-04-25)

User accepted the short attended-PIN direction but requested a 5-minute setup window rather than 2 minutes. Current preferred direction:

- Visible pairing secret should be a 4-digit PIN.
- Pairing window should be 5 minutes.
- Bot should accept the PIN as plain private-chat text, with `/start <pin>` and deep-link forms as compatible alternatives.
- Keep basic guardrails: private chat only, ignore/drop pre-setup stale updates, failed-attempt limiting, and preferably local identity confirmation or at least clear local/Telegram confirmation of the paired account.
