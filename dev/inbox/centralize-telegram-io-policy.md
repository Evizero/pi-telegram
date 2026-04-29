---
title: "Centralize Telegram IO policy instead of scattering API edge handling"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["centralize-telegram-io-policy"]
---
Source: Telegram voice note transcribed on 2026-04-28. The user clarified that the earlier audit was too micro-detail oriented and asked to zoom out across files to judge whether the codebase is becoming incoherent, duplicated, divergent, or duct-taped together, and whether a cleanup is needed.

Capture: Telegram API usage crosses text, previews, attachments, typing, finals, activity, setup, route cleanup, updates, and command controls. These paths repeatedly decide how to preserve `message_thread_id`, classify Telegram errors, honor retry-after, edit versus send, delete or finalize messages, and split output.

Concern: the codebase may have multiple Telegram micro-policies that can diverge under new features.

Desired cleanup direction: define a Telegram IO policy layer for reply targeting, retry classification, chunking, edit fallback, message-not-found handling, topic preservation, and upload behavior. Feature modules should call that policy instead of reimplementing edge decisions.



## Simplification pass note (2026-04-28)

Potential simplification: create `telegram/message-ops.ts` or similar for repeated Telegram message behaviors: edit-not-modified handling, delete-not-found handling, Markdown fallback, callback-answer best effort, chunking/edit fallback, topic `message_thread_id` preservation, and shared retry/terminal error predicates.
