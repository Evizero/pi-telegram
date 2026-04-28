---
title: "Stop streaming assistant text previews"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["send-assistant-text-only-at-final"]
---
User voice note (2026-04-28, transcribed with local Whisper large from Telegram OGG):

> You know, I changed my mind on streaming. We don't really need the final agent message or the agent message streamed. So we can just like wait for the full message and then send it because the models are so fast that the streaming doesn't add any value really. Investigate what that could mean for the planning and for redesigning this a little bit and report back.

Initial interpretation: this supersedes or at least broadens the prior narrower plan to silence streamed assistant previews. Instead of keeping streamed assistant text previews but making them non-alerting, the desired direction may be to stop sending assistant text previews at all during normal turns and rely on live activity plus the final answer.

Potential implications to investigate:

- Requirements: `StRS-activity-final-feedback`, `SyRS-final-preview-deduplication`, and `SyRS-silent-passive-telegram-updates` currently assume streamed/provisional assistant previews exist. They may need to shift from "stream previews quietly" to "do not expose assistant text until final, while preserving activity visibility".
- Architecture: `dev/ARCHITECTURE.md` currently says assistant text streams through `PreviewManager`; that would become misleading if the new baseline is final-only assistant text.
- Implementation: `src/pi/hooks.ts` currently posts `assistant_preview` on every assistant `message_update`; `src/extension.ts` routes those to `PreviewManager`; `src/telegram/previews.ts` owns visible preview messages and cleanup. A clean redesign may remove or bypass this normal path rather than only changing notification flags.
- Current task impact: ready task `silence-streamed-assistant-preview` may be obsolete or should be rewritten before implementation. It solved the double-notification symptom but preserved a preview system that the user now says may not be valuable.
