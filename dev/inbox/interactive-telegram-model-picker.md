---
title: "Interactive Telegram /model picker"
type: "request"
created: "2026-04-27"
author: "Christof Salis"
status: "planned"
planned_as: ["implement-interactive-telegram-model"]
---
User request (2026-04-27): Improve Telegram `/model` so the user does not have to read a long numbered list and then send `/model 23`. Desired flow: `/model` should send an interactive Telegram message asking which model to switch to, with buttons for available models. If there are more than a reasonable maximum number of buttons, reserve the last button as a “More” button that pages to the next set of model buttons.

Investigation notes:
- Current implementation is in `src/broker/commands.ts` (`handleModelCommand`). `/model` or `/model list [filter]` queries `query_models`, slices to 30 results, sends plain text lines, and caches those shown models in memory under `modelListCache` for `MODEL_LIST_TTL_MS`.
- `/model <number>` resolves against that cache; otherwise `/model <selector text>` calls `set_model`. If the cache is expired/missing, numeric selection tells the user to send `/model` first.
- `sendTelegramTextReply` in `src/telegram/text.ts` only wraps `sendMessage` text/thread/notification options today; no `reply_markup` support is currently exposed through `sendTextReply`.
- Telegram polling in `src/broker/updates.ts` currently requests only `allowed_updates: ["message", "edited_message"]`, and `TelegramUpdate` in `src/shared/types.ts` has no callback-query shape. Inline keyboard model selection would need callback query support in update types, polling allowed updates, authorization/routing, and command dispatch.
- `docs.md` currently covers `sendMessage`/`editMessageText` but does not yet document inline keyboards, callback queries, `answerCallbackQuery`, or callback-data constraints, so Bot API notes should be extended before implementation.

Possible implementation direction:
- Keep existing `/model <selector>` and `/model <number>` compatibility.
- Make bare `/model` send a prompt with an inline keyboard. Each model button should map to a compact callback payload or a short-lived broker-side selection token; avoid putting long provider/model IDs directly into callback data if it risks Telegram limits.
- Use a bounded page size (for example 8-12 visible model buttons) and make the last button `More` when additional models exist. Pressing `More` should update the message to the next page (or send a replacement) while preserving `message_thread_id` for topic-routed sessions.
- On model-button callback, verify the Telegram user/chat is authorized and the route/session still matches, call `set_model`, acknowledge the callback, and update/send a confirmation.
- State/retry considerations: callback handling should not break polling offset durability, rate-limit handling, broker failover expectations, or duplicate/redelivered update id handling. Decide whether pagination/model-selection state must survive broker restart or can be short-lived with a graceful “selection expired; send /model again” message.



Follow-up investigation: the “multi sub” extension is the user-level pi extension at `~/.pi/agent/extensions/multi-sub.ts`. Its header calls it the “Multi-Subscription extension for pi”; it registers extra OAuth subscription accounts and cloned models, with `/subs` and `/pool` commands. Although the source file is `multi-sub.ts`, its config is named `multi-pass.json` (`~/.pi/agent/multi-pass.json`, with optional project override `.pi/multi-pass.json`).

Current local config shows two extra ChatGPT Codex subscriptions:
- `openai-codex-2` labeled `private`
- `openai-codex-3` labeled `vertify max`

The extension clones every built-in `openai-codex` model for each extra provider, preserving the same model id and appending the subscription index/label to the model name. That means the model catalog can legitimately contain repeated ids like:
- `openai-codex/gpt-5.5` (base/original)
- `openai-codex-2/gpt-5.5` (private)
- `openai-codex-3/gpt-5.5` (vertify max)

Design implication for the interactive Telegram model picker: buttons must disambiguate provider/subscription, not just model id. For duplicated ids, show the subscription/provider tag prominently (for example `gpt-5.5 — base`, `gpt-5.5 — private`, `gpt-5.5 — vertify max`) and make callback payloads select the exact `provider/id`, not the display name or bare model id.



User refinement (2026-04-27): the multi-sub extension is optional, but when the target session's model catalog indicates it is present, the Telegram `/model` flow should be two-stage:
1. First show buttons to choose the subscription/provider account.
2. After a subscription is clicked, show only the models available for that selected subscription.

Design notes:
- Do not make `pi-telegram` require the multi-sub extension or import user-local extension code. The picker should gracefully fall back to a flat model picker when no subscription grouping is detectable.
- Detection can be based on the model catalog returned by the target Session Client. Multi-sub registers cloned providers such as `openai-codex-2` and `openai-codex-3`, with the same model ids as the base provider and labels embedded in cloned model names, so `clientQueryModels` may need to return enough display metadata for the broker to group by provider/subscription.
- The first-stage subscription buttons should display human-friendly labels where available (`base`, `private`, `vertify max`, etc.) while preserving the exact provider name internally.
- The second-stage model buttons should be scoped to the chosen provider/subscription and select exact `provider/id` values.
- If only one provider/subscription group exists after filtering, skip the first stage and show model buttons directly.
- If a `/model list <filter>`-style filter remains supported, decide whether it filters subscriptions, models within each subscription, or both; keep text selector compatibility regardless.
