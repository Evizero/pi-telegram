---
title: "Attachment safety check fails on macOS /var realpath"
type: "bug"
created: "2026-04-29"
author: "pi agent"
status: "rejected"
planned_as: []
---
Discovered during planning validation on 2026-04-29 while running `npm run check` after planning the stale-broker lease-loss task.

The TypeScript typecheck passed and the activity check suite progressed through many checks, then failed in `scripts/check-security-setup-attachments.js` with a path alias mismatch:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ '/private/var/folders/.../pi-telegram-attachments-.../artifact.txt'
- '/var/folders/.../pi-telegram-attachments-.../artifact.txt'

at checkOutboundAttachmentSecretPathGuard (.../scripts/check-security-setup-attachments.js:29:16)
```

This appears unrelated to the stale-broker planning edits. It likely reflects macOS `/var` symlink normalization: the implementation or check returns a realpath under `/private/var` while the expected fixture path uses `/var`.

Follow-up: normalize expected and actual paths consistently in the attachment safety check or helper so validation is stable on macOS temp directories without weakening the outbound attachment path guard.


Implementation note (2026-04-29): fixed opportunistically while validating stale-broker implementation by comparing the expected safe attachment path with `realpath(safe)`, matching the helper's canonical-path behavior without weakening the guard.



Closed during stale-broker implementation validation: the assertion now compares against the canonical realpath expected by resolveAllowedAttachmentPath; no separate task was needed because this was a test expectation fix only.
