---
title: "Telegram starts new turn while compaction is still running"
type: "bug"
created: "2026-04-25"
author: "Christof Salis"
status: "planned"
planned_as: ["queue-telegram-input-during-compaction"]
---
User reported that after Telegram `/compact`, sending another Telegram message while compaction is still running causes Telegram to show the agent working/responding even though pi still shows compaction in progress. They suspect the extension forks work during compaction, and this also breaks follow-up behavior.

User expectation: this should match native pi behavior, where steering/follow-up during compaction works correctly instead of starting a second concurrent turn.
