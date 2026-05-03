# Maintenance guide

This guide is for maintainers and coding agents changing `pi-telegram`.

## Required validation

Before reporting code changes complete, run:

```bash
npm run check
```

This runs:

```bash
npm run typecheck
npm run check:behavior
```

`check:behavior` executes the TypeScript behavior checks discovered by `scripts/run-behavior-check.mjs` as `scripts/check-*.ts`.

## Repository shape

Keep the package entrypoint tiny:

- `index.ts` should only register the extension/bootstrap.
- `src/bootstrap.ts` owns lightweight pi-visible registration and lazy-load policy.
- `src/extension.ts` is the heavy runtime composition root.
- Runtime code is organized by responsibility:
  - `src/broker/` — polling, routing, command handling, broker state, broker lifecycle;
  - `src/client/` — local session registration, turn lifecycle, final handoff, local session controls;
  - `src/pi/` — pi command, tool, prompt, event, and diagnostic boundaries;
  - `src/telegram/` — Bot API access, retry, previews, attachments, typing, temp files;
  - `src/shared/` — config, paths, IPC, formatting, small cross-boundary utilities.

Do not collapse cohesive modules back into a god file. No TypeScript source file should exceed 1,000 lines.

## Planning and requirements workflow

This repository uses `pln` for project planning records under `dev/`.

Useful commands:

```bash
pln status
pln strs list
pln syrs list
pln task list --archived
pln inbox list --archived
pln documentation status
```

When work changes purpose, requirements, architecture, tasks, or documentation-curation state, use the appropriate `pln` workflow rather than creating ad hoc planning files.

Authority layers:

1. `dev/INTENDED_PURPOSE.md` — product scope and boundaries.
2. `dev/STAKEHOLDER_REQUIREMENTS.json` — stakeholder needs.
3. `dev/SYSTEM_REQUIREMENTS.json` — implementable behavior requirements.
4. `dev/ARCHITECTURE.md` — architecture contract and current-state clarifications.
5. `dev/tasks` / archived tasks — implementation work records.
6. `docs/` — durable user/maintainer synthesis.

Docs may summarize requirements and architecture, but they should not create new obligations by themselves.

## Telegram API rules

Before changing Bot API integration, read [`telegram-bot-api.md`](telegram-bot-api.md). Important invariants:

- `getUpdates` and webhooks are mutually exclusive; delete webhooks before polling and retry deletion failures.
- Honor `ResponseParameters.retry_after`; do not immediately retry or fall back.
- Advance polling offsets only after an update is durably handled, rejected, or queued.
- Hosted Bot API downloads are capped at 20 MB; `File.file_path` is optional.
- Split text below Telegram's 4096-character limit.
- Use `sendMessageDraft` only for eligible integer private-chat targets, non-empty text, and non-zero draft IDs.
- Preserve `message_thread_id` for topic-routed replies, previews, uploads, typing actions, and cleanup.
- Use `sendPhoto` only for likely photos within photo limits; fall back to `sendDocument` for photo-contract failures, not rate limits.

## Security and privacy rules

- Never log bot tokens or credentials.
- Keep config, broker state, IPC sockets, and downloaded Telegram files private.
- When changing persisted JSON helpers or config setup, preserve private creation: token-bearing config/state temp files must be created with restrictive permissions before secret bytes are written, not chmodded only after a default-permission write.
- Treat Telegram attachments, filenames, MIME types, metadata, and content as untrusted.
- Do not execute or trust attachment contents merely because they came from the paired user.
- Allow outbound uploads only from the session workspace or bridge temp directory
  after canonical path resolution.
- Block obvious secrets such as `.env`, SSH keys, SSH/AWS/Azure/Kubernetes
  credential directories, Google Cloud config, and application-default
  credential files; keep symlink/realpath behavior covered when changing this
  guard.
- Use `telegram_attach` for explicit artifact return; do not send local artifacts merely because a path appears in text.

## Common change areas and checks

| Change area | Source paths | Behavior checks to inspect/run |
| --- | --- | --- |
| Lazy startup/bootstrap | `index.ts`, `src/bootstrap.ts`, `src/extension.ts` | `check-lazy-bootstrap.ts`, `check-runtime-pi-hooks.ts` |
| Setup/pairing gate | `src/telegram/setup.ts`, `src/shared/pairing.ts`, `src/broker/updates.ts`, `src/shared/ui-status.ts` | `check-pairing-and-format.ts`, `check-session-topic-setup-and-offline-grace.ts` |
| Telegram polling/API policy | `src/broker/updates.ts`, `src/telegram/api.ts`, `src/telegram/api-errors.ts`, `src/telegram/errors.ts`, `src/telegram/message-ops.ts`, `src/telegram/retry.ts`, `src/telegram/attachments.ts` | `check-telegram-io-policy.ts`, `check-telegram-error-boundary.ts`, `check-callback-updates.ts`, `check-telegram-text-replies.ts` |
| Preview compatibility | `src/telegram/previews.ts`, `src/telegram/policy.ts`, `src/broker/finals.ts` | `check-preview-manager.ts`, `check-telegram-io-policy.ts`, `check-final-delivery.ts` |
| Busy turns and queued controls | `src/broker/commands.ts`, `src/broker/queued-*`, `src/shared/queued-control-text.ts`, `src/client/turn-*` | `check-telegram-command-routing.ts`, `check-telegram-queued-controls.ts`, `check-client-turn-delivery.ts`, `check-manual-compaction.ts`, `check-session-unregister-cleanup.ts`, `check-telegram-outbox.ts` |
| Telegram cleanup outbox | `src/broker/telegram-outbox.ts`, `src/broker/sessions.ts`, `src/broker/routes.ts`, `src/broker/queued-turn-control-handler.ts`, `src/extension.ts` | `check-telegram-outbox.ts`, `check-session-unregister-cleanup.ts`, `check-session-disconnect-requests.ts`, `check-session-replacement-handoff.ts`, `check-telegram-queued-controls.ts` |
| Pi hook boundary | `src/pi/hooks.ts`, `src/pi/*`, `src/shared/activity-lines.ts`, `src/broker/activity.ts` | `check-runtime-pi-hooks.ts`, `check-activity-rendering.ts` |
| Pi footer/status diagnostics | `src/shared/ui-status.ts`, `src/pi/diagnostics.ts`, `src/extension.ts`, `src/broker/updates.ts`, `src/broker/heartbeat.ts` | `check-pi-status-diagnostics.ts`, `check-broker-renewal-contention.ts`, `check-durable-json-loading.ts`, `check-telegram-outbox.ts` |
| Final delivery | `src/broker/finals.ts`, `src/telegram/previews.ts`, `src/client/final-handoff.ts`, `src/client/retry-aware-finalization.ts` | `check-final-delivery.ts`, `check-client-final-handoff.ts`, `check-retry-aware-finalization.ts`, `check-activity-rendering.ts` |
| Session lifecycle/routes | `src/broker/routes.ts`, `src/broker/session-registration.ts`, `src/broker/sessions.ts`, `src/client/session-replacement.ts`, `src/shared/routing.ts` | `check-session-route-registration.ts`, `check-session-unregister-cleanup.ts`, `check-session-replacement-handoff.ts` |
| Attachments/security | `src/shared/utils.ts`, `src/shared/config.ts`, `src/telegram/api.ts`, `src/telegram/attachments.ts`, `src/client/attachment-path.ts`, `src/pi/attachments.ts` | `check-security-setup-attachments.ts`, `check-telegram-temp-cleanup.ts` |
| Model and Git controls | `src/broker/model-*`, `src/broker/git-*`, `src/client/git-status.ts` | `check-model-picker.ts`, `check-telegram-model-picker.ts`, `check-telegram-git-controls.ts`, `check-client-git-status.ts` |
| Broker lease/background | `src/broker/lease.ts`, `src/broker/heartbeat.ts`, `src/broker/background.ts` | `check-broker-background.ts`, `check-broker-renewal-contention.ts` |
| Shared boundary cleanup | `src/shared/*`, owner modules | `check-shared-boundaries.ts`, `check-ipc-policy.ts` |
| Local IPC policy | `src/shared/ipc.ts`, `src/shared/ipc-types.ts`, `src/shared/ipc-policy.ts` | `check-ipc-policy.ts`, `check-shared-boundaries.ts` |

## Safe implementation habits

- Check `git status --short` before and after edits.
- Prefer narrow modules with explicit owners over broad helpers.
- Keep local IPC timeout/body-size policy in `src/shared/ipc-policy.ts`; do not derive broker/client IPC envelope limits from Telegram attachment-size constants.
- Keep retry loops idempotent and state-backed.
- Preserve route identity as session + route mode + chat + optional thread; do not reuse or clean up routes by chat ID alone.
- Treat `retry_after` as scheduling state, not as an error to hide.
- Keep Telegram retry/error primitives in `src/telegram/api-errors.ts`; do not reintroduce imports of those primitives from `src/telegram/api.ts` outside the transport boundary.
- Preserve FIFO final delivery and visible progress records.
- Treat streamed assistant previews as temporary: settle or record cleanup limitations before final text/notices, and append final content as fresh Telegram messages rather than editing previews into finals.
- Keep cleanup-oriented Telegram outbox work scoped to queued-control status edits and route/topic cleanup unless a later reviewed migration explicitly moves another side-effect family.
- Do not make client-side final persistence a second broker final ledger.
- Do not route Telegram controls as fake user conversation text unless the requirement explicitly says so.
- Keep the Telegram footer/statusbar for durable bridge state only; route event-like diagnostics through pi-native notifications rather than LLM-visible custom session messages.
- Update docs, `docs/telegram-bot-api.md`, requirements, or architecture in the same coherent change when behavior or authority changes.

## Release and commit hygiene

Do not commit unless explicitly asked. If preparing a commit, prefer one coherent intent and Conventional Commit style. For completed tracked work, use the repository's `pln-close` workflow to align tasks, requirements, changelog evidence, and docs decisions before archiving.
