# State and reliability

This page explains the durable runtime state and reliability mechanisms that preserve Telegram control continuity across busy turns, Telegram retry windows, broker turnover, session lifecycle churn, and partial final delivery.

For source-level details, start with `src/shared/paths.ts`, `src/extension.ts`, `src/broker/types.ts`, `src/client/types.ts`, `src/broker/finals.ts`, `src/broker/telegram-outbox.ts`, and `src/broker/updates.ts`.

## Runtime file locations

| Artifact | Location | Purpose |
| --- | --- | --- |
| Telegram config | `~/.pi/agent/telegram.json` | Bot token/identity, allowed user/chat, pairing state, topic routing config. |
| Broker root | `~/.pi/agent/telegram-broker` | Default local broker scope before a bot ID is known. |
| Bot-scoped broker root | `~/.pi/agent/telegram-broker/bot-<botId>` | Lease/state/token/IPC scope once bot identity is known. |
| Lease file | `leader.lock/lock.json` under broker root | Current broker owner, process, socket, epoch, expiry. |
| Takeover lock | `takeover.lock` under broker root | Serializes broker takeover attempts. |
| Broker state | `state.json` under broker root | Durable sessions, routes, pending turns, finals, media groups, outbox, controls, selections, progress. |
| IPC token | `broker-token` under broker root | Same-user local IPC bearer token. |
| Disconnect requests | `disconnect-requests/*.json` | Durable explicit disconnect requests for broker processing. |
| Client pending finals | `client-pending-finals/*.json` under broker root | Client-side pre-broker-acceptance assistant-final handoff records. |
| Client pending-final lock | `client-pending-finals.lock` under broker root | Cross-process lock for client pending-final file processing. |
| Session handoffs | `session-replacement-handoffs/*.json` | Native `/new`, `/resume`, `/fork` route-continuity handoff records. |
| Telegram downloads | `~/.pi/agent/tmp/telegram/<session-id>` | Private session-scoped inbound file storage. |

These are local runtime artifacts, not repository artifacts. Token-bearing files must stay private.

## Broker lease and broker state

Exactly one connected process should own the broker lease at a time. The broker lease records owner identity, process, startup time, lease epoch, socket path, expiry, update time, and bot ID when known.

Broker state records the continuity surface:

- recent and last processed Telegram update IDs;
- sessions and routes;
- pending media groups;
- pending turns;
- queued follow-up control records;
- active activity message refs;
- assistant preview refs;
- pending assistant finals and delivery progress;
- pending route cleanups and Telegram outbox jobs;
- selector selections;
- model/git control records;
- pending manual compaction operations;
- completed turn IDs and timestamps.

Writes are serialized and fenced by the current broker owner/epoch. Stale broker persistence must stand down rather than resurrecting old state or crashing the hosting pi process.

## Durable JSON boundary

Malformed, unreadable, or schema-invalid durable JSON is not treated as if the file were missing. Invalid state is diagnosed with artifact context so maintainers can inspect the original file. Directory-scanned maintenance records are isolated per file so one corrupt pending-final, disconnect, or handoff record does not block unrelated valid recovery work.

## Telegram polling and update offsets

The broker owns Telegram polling:

1. Delete any webhook before using `getUpdates`.
2. Poll with allowed update types including messages, edited messages, and callback queries.
3. Authenticate pairing/user/chat before dispatch.
4. Durably handle, reject, or queue each update.
5. Advance `lastProcessedUpdateId` only after durable handling.
6. Keep recent update IDs for dedupe after retry or broker restart.

Telegram `retry_after` is a control signal. The bridge should wait and preserve state rather than immediately retrying, falling back to another method, or advancing offsets through a rate-limit window.

## Pending turns

A Telegram message becomes a durable pending turn before client delivery. The turn contains route/session identity, content, history text, attachments, delivery mode, and optional manual-compaction blocker.

Important semantics:

- ordinary busy messages queue as follow-up by default;
- `/follow` queues explicitly;
- `/steer` targets active-turn steering;
- pending turns are removed only after pi/client acceptance, final handoff, cancellation, disconnection, or terminal lifecycle handling;
- completed turn IDs prevent duplicate/redelivered Telegram updates from re-executing already consumed turns;
- turns behind a queued manual-compaction operation do not overtake the compaction barrier.

## Queued follow-up controls

When a busy follow-up can still be steered, the broker may create a route-scoped tokenized inline control record. The visible Telegram message can offer `Steer now` and `Cancel` actions.

The broker state remains authority. Callback handling must verify paired user, chat, route/session, target turn, and current control status before mutating anything. If a turn is no longer actionable, callbacks fail closed even if Telegram button cleanup was delayed.

Queued-control finalization edits are retryable through the broker Telegram outbox when necessary.

## Manual compaction as a barrier

Telegram `/compact` is modeled as a session operation, not a message injected into the conversation.

- Idle session: start compaction immediately.
- Busy session or earlier queued work: persist a pending manual-compaction operation.
- Later ordinary/follow-up turns are blocked behind the operation.
- Steering remains urgent and is not blocked by the barrier.
- Repeated compaction requests coalesce while one is queued/running.
- Stop/cancel paths clear queued compaction and dependent blocked turns where appropriate.

## Activity rendering

Activity collection and Telegram rendering are separate:

- pi hooks capture thinking/tool events;
- the client reports activity to the broker;
- broker `ActivityRenderer` debounces visible Telegram sends/edits and typing loops;
- durable active activity message refs let the broker continue or clean activity around finals and broker turnover.

Rendering may throttle, but collected activity meaning should not be discarded merely because Telegram updates are debounced or rate-limited.

## Assistant final delivery

Assistant final delivery is broker-owned after durable acceptance.

Client side:

- retry-aware finalization defers transient provider/assistant failures without useful final text when pi may retry;
- final text wins over error metadata when non-empty;
- client final handoff persists only the pre-broker-acceptance ambiguity window in `client-pending-finals/*.json`, coordinated by `client-pending-finals.lock`;
- after broker acceptance, client retry should not become a parallel final-delivery system.

Broker side:

- `pendingAssistantFinals` records the final before visible Telegram output;
- repeated handoffs for the same turn/final are idempotent;
- delivery is FIFO;
- text chunks, sent chunk indexes, message IDs, attachment indexes, preview cleanup state, retry-at times, and terminal outcomes are persisted;
- partial success resumes from recorded progress after retry or broker turnover;
- terminal non-retryable failures close the final and allow later finals to proceed.

This design prevents known duplicate-final failure modes from long answers, IPC timeout ambiguity, broker restart/takeover, and attachment-after-text retries.

## Telegram outbox

`src/broker/telegram-outbox.ts` owns cleanup-oriented Telegram side effects that need retry but are not assistant final text/attachment delivery.

Current outbox scope:

- queued-control status-message finalization;
- route topic deletion after route cleanup.

The outbox stores idempotent job IDs, status, attempts, retry time, terminal reason, and completion time. It honors `retry_after` and asserts the current broker lease before side effects.

Assistant final delivery stays in `src/broker/finals.ts` because final chunks/attachments have stricter FIFO and visible-progress requirements.

## Route and session lifecycle

Routes are connection-scoped Telegram views:

- explicit disconnect unregisters and cleans up immediately;
- normal shutdown unregisters and cleans up unless a native session replacement handoff succeeds;
- heartbeat or IPC loss marks a session offline first;
- reconnect grace preserves a route for bounded automatic recovery;
- expired reconnect grace unregisters the session and records route/topic cleanup;
- successful `/new`, `/resume`, or `/fork` replacement can preserve Telegram reachability for the replacement runtime.

Native pi history remains local and is not stored in Telegram topics.

## Attachments and temp cleanup

Inbound Telegram attachments are downloaded to private session temp directories and treated as untrusted. The session temp directory is retained only while the session is active, within reconnect grace, or while pending Telegram state may still depend on the files. Cleanup runs on authoritative session end and through conservative orphan sweeps.

Outbound attachments require explicit `telegram_attach` intent and path validation. The bridge blocks obvious secrets and unrelated local files before upload.

## Retry and terminal-outcome principles

- Preserve `retry_after`; do not treat it as a generic failure.
- Do not fall back from Markdown, edit, or `sendPhoto` on rate limits.
- Preserve `message_thread_id` for route-scoped replies, uploads, activity, typing, and cleanup.
- Split long text below 4096 characters.
- Advance update offsets only after durable handling.
- Persist progress after each acknowledged visible final step.
- Distinguish retryable transient failures from explicit terminal outcomes.
- Let stale brokers/clients stand down without unhandled async rejections.

## Validation anchors

Behavior checks that cover this page include:

- `scripts/check-durable-json-loading.ts`
- `scripts/check-telegram-io-policy.ts`
- `scripts/check-final-delivery.ts`
- `scripts/check-client-final-handoff.ts`
- `scripts/check-retry-aware-finalization.ts`
- `scripts/check-telegram-outbox.ts`
- `scripts/check-telegram-queued-controls.ts`
- `scripts/check-manual-compaction.ts`
- `scripts/check-client-compact.ts`
- `scripts/check-session-disconnect-requests.ts`
- `scripts/check-session-replacement-handoff.ts`
- `scripts/check-session-topic-setup-and-offline-grace.ts`
- `scripts/check-telegram-temp-cleanup.ts`
