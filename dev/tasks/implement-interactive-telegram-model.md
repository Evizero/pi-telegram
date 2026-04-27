---
title: "Implement interactive Telegram /model picker"
status: "done"
priority: 2
created: "2026-04-27"
updated: "2026-04-27"
author: "Christof Salis"
assignee: "pi-agent"
labels: ["telegram", "model-picker", "bot-api"]
traces_to: ["SyRS-interactive-model-picker", "SyRS-api-guidance-maintained", "SyRS-durable-update-consumption", "SyRS-telegram-retry-after", "SyRS-telegram-text-method-contracts", "SyRS-local-authority-boundary", "SyRS-reject-unauthorized-telegram"]
source_inbox: "interactive-telegram-model-picker"
branch: "task/implement-interactive-telegram-model"
---
## Objective

Replace the bare Telegram `/model` numbered-list workflow with an inline-button picker that lets the paired user select the exact model for the routed pi session without typing `/model 23`.

The picker must support optional multi-subscription providers without depending on the user-local `multi-sub.ts` extension. When the target session model catalog contains multiple provider/subscription groups that expose overlapping model IDs, `/model` should first ask which provider/subscription to use, then show models scoped to that provider. When there is only one relevant group, skip directly to model selection.

## Scope

- Preserve existing `/model <selector>`, `/model <number>`, and `/model list [filter]` compatibility unless a later implementation discovery shows a specific conflict that should be planned before changing behavior.
- Add Telegram inline-keyboard support for command replies and model-picker pagination.
- Add callback-query update handling for model picker button presses.
- Select models by exact `provider/id`; never select by bare model ID when provider identity is ambiguous.
- Infer provider/subscription grouping from the target session's returned model catalog rather than importing or requiring the optional multi-sub extension.
- Keep model switching owned by the target local pi session through existing IPC (`query_models` / `set_model`) so Telegram remains a control surface, not the model authority.

## Codebase grounding

Likely touchpoints:

- `docs.md`: add project-local Bot API notes for `InlineKeyboardMarkup`, callback queries, callback data limits, `answerCallbackQuery`, and any edit/send constraints relevant to inline keyboards.
- `src/shared/types.ts`: add Telegram callback-query types and any picker state/data shapes needed by broker/client IPC.
- `src/broker/updates.ts`: include `callback_query` in polling, route authorized callback updates through durable handling, and preserve retry-after behavior.
- `src/broker/commands.ts`: split current text-list `/model` behavior into reusable catalog/picker helpers, send provider/model pages, handle `More`, and keep text selectors compatible.
- `src/telegram/text.ts` or a new focused Telegram message helper: support `reply_markup`/inline keyboards without weakening existing text chunking and notification semantics.
- `src/client/info.ts`: return enough model display metadata for provider/subscription grouping while keeping `set_model` exact-selector behavior.
- `src/extension.ts`: wire any new dependency methods in the composition root without growing new policy there.

Pre-edit impact preview: this is a cross-boundary change touching Telegram update ingestion, Telegram send payloads, broker command state, model catalog formatting, and docs. The main risks are acknowledging callback updates before durable handling, losing route/session context for topic-routed replies, choosing the wrong provider when model IDs repeat, or adding a hard dependency on optional user-local extension code.

## Acceptance Criteria

- Bare `/model` sends an interactive Telegram picker for the selected/routed session.
- For a catalog like `openai-codex/gpt-5.5`, `openai-codex-2/gpt-5.5`, and `openai-codex-3/gpt-5.5`, the first picker stage shows provider/subscription choices and the second stage shows models only for the chosen provider.
- Provider/subscription buttons use useful labels where available from model names or provider metadata, while callback data or broker-side tokens preserve the exact provider.
- If the model list exceeds the chosen button budget, the final button on the page advances to the next page and does not hide a selectable model without another path to it.
- A model button calls `set_model` for the target session with the exact `provider/id` and reports success or a clear failure to Telegram.
- Callback handling rejects unauthorized users/chats and expired, malformed, mismatched, or stale picker state without changing the model.
- Existing text workflows for `/model list`, `/model <number>`, and `/model <selector>` continue to work.
- Callback-query polling and handling preserve the existing durable update-offset, duplicate-update, route context, and `retry_after` invariants.
- The implementation does not import `~/.pi/agent/extensions/multi-sub.ts` or require that extension to be installed.

## Out of Scope

- General Telegram bot menus unrelated to pi session supervision.
- New multi-user authorization modes.
- Changing how pi itself registers providers or how the optional multi-sub extension names providers.
- Moving model execution, credentials, or provider configuration into Telegram-side state.

## Validation

Run `npm run check` before reporting completion. Add focused tests or a small validation script if practical for the new picker helpers and callback parsing; otherwise include an explicit manual demonstration plan that covers flat catalogs, duplicated model IDs across providers, pagination, unauthorized callbacks, and stale callback state.

## Decisions

- 2026-04-27: Implemented the interactive picker with broker-side short callback tokens stored in broker state so Telegram callback_data stays compact and provider/model catalogs are not embedded in button data. Bare /model now uses inline buttons; /model list remains the numbered compatibility flow for /model <number>.
- 2026-04-27: Provider/subscription grouping is inferred from overlapping model IDs across providers in the target session model catalog. Single-provider or non-overlapping catalogs skip the provider stage; duplicated IDs first show provider/subscription choices and then provider-scoped model choices.
- 2026-04-27: Validation now covers callback-query rejection retry behavior, picker grouping and More pagination, exact picker/numeric model selection versus fuzzy text selection, non-critical Telegram UI failures after model changes, and retry_after redelivery of completed picker confirmations without re-running set_model.
