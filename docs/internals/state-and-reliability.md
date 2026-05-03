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

These are local runtime artifacts, not repository artifacts. Token-bearing files must stay private. `writeConfig()` ensures `~/.pi/agent` is `0700` before writing `telegram.json`, and the shared JSON writer creates temporary JSON files with restrictive `0600` permissions and exclusive creation before token or broker-state bytes are written. The final file is also chmodded to `0600` before the atomic rename completes. The broker IPC token file uses the same private-file mode.

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

### Broker heartbeat and diagnostics

`src/broker/lease.ts` and `src/broker/heartbeat.ts` distinguish lease loss from ordinary renewal contention. A live `takeover.lock` can briefly block lease renewal while the current broker still owns a live lease; that is classified as renewal contention, not a generic heartbeat failure. One-off contention does not increment the heartbeat failure counter or stand the broker down. Repeated contention crosses a bounded threshold and reports a pi-safe diagnostic so users can see that broker coordination is degraded while the broker remains active.

True lease loss remains strict: missing, expired, mismatched-owner, or mismatched-epoch leases make the broker stand down through the controlled stale-broker path. Generic heartbeat or maintenance failures use a separate failure counter; repeated failures are reported and then attempt broker stop without letting a failed stop reject the heartbeat cycle.

Heartbeat cycles are serialized with in-flight state so a slow renewal or maintenance pass cannot overlap the next timer tick and create self-inflicted contention. User-visible heartbeat/background diagnostics route through the `src/pi/diagnostics.ts` reporter when the extension has a current pi context; the reporter currently uses pi UI notifications for `notify` events and avoids injecting diagnostic text as agent-turn input.

The footer/statusbar is a separate durability surface from these diagnostics. `telegramStatusText()` renders stable bridge state only—hidden/cleared, not configured, broker session count, connected route, or disconnected—and must not accept raw transient error/detail overrides. Poll-loop retry failures, ordinary `retry_after` waits, and other retryable coordination noise therefore refresh durable status after backoff or stay quiet instead of briefly replacing the footer. Actionable repeated or terminal failures, such as repeated heartbeat contention/failure, terminal final-delivery or route-cleanup failures, and invalid durable-state reports, notify through pi-safe diagnostics with dedupe where persistent failures could otherwise spam the operator.

## Durable JSON boundary

`readJson()` returns `undefined` only for missing files. Malformed JSON, unreadable files, directories, permission failures, and other non-missing read failures surface as durable JSON errors with path context instead of being treated as absent state.

Schema validation happens at the durable-state boundary before records drive runtime behavior. Central artifacts such as Telegram config, the broker lease, the takeover lock, and `state.json` fail closed when their shape is invalid so the bridge does not silently replace corrupt state with defaults or use incomplete coordination data. Durable JSON errors carry the artifact path; broker-state maintenance paths that catch invalid artifacts report that path through pi diagnostics when a current pi context is available.

Directory-scanned maintenance records are isolated per file. A malformed, unreadable, or schema-invalid client pending-final, disconnect request, or session-replacement handoff is preserved for diagnosis and reported, while later valid files in the same directory continue to process. Valid stale or empty records may still be removed by their lifecycle-specific cleanup rules; invalid records are not deleted merely because they failed to parse or validate.

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

When a busy follow-up can still be steered, the broker may create a route-scoped tokenized inline control record. The visible Telegram message can offer sibling `Steer now` and `Cancel` actions for the same queued turn.

The broker record maps the compact Telegram callback token to the queued turn, route, session, target active turn, visible status message, current status, expiry, and terminal display text. `offered` is still actionable; `converting` and `cancelling` are in-flight client handshakes; `converted`, `cancelled`, and `expired` are terminal control states. Terminal state is UI cleanup and callback authority, not proof that Telegram editing already succeeded.

The client remains the authority for queue mutation. To steer or cancel, the broker asks the selected client over IPC to atomically remove the exact queued or manual-compaction-deferred turn before the broker consumes the pending turn. Cancelling one follow-up does not abort the active turn or remove unrelated queued work; `/stop` remains the broader escape hatch.

Callback handling must verify paired user, chat, route/session, target turn, and current control status before mutating anything. If a turn is no longer actionable, callbacks fail closed even if Telegram button cleanup was delayed.

When a queued follow-up starts normally, is cancelled, is steered, is cleared, expires, or otherwise becomes non-actionable, the broker terminalizes the control and edits the known status message to remove buttons where possible. Those visible cleanup edits are retryable through the broker Telegram outbox, honoring per-control and broker-wide backoff from Telegram `retry_after` or transient edit failures. Route/session cleanup attempts queued-control status edits before topic deletion when Telegram permits it, but visible cleanup failure cannot resurrect cancelled work, duplicate delivery, or block local execution.

## Manual compaction as a barrier

Telegram `/compact` is modeled as a session operation, not a message injected into the conversation.

- Idle session: start compaction immediately.
- Busy session or earlier queued work: persist a pending manual-compaction operation.
- Later ordinary/follow-up turns are blocked behind the operation.
- Steering remains urgent and is not blocked by the barrier.
- Repeated compaction requests coalesce while one is queued/running.
- Stop/cancel paths clear queued compaction and dependent blocked turns where appropriate.

## Activity rendering

Activity collection and Telegram rendering are separate; see [Activity rendering](activity-rendering.md) for row-level presentation and lifecycle details.

- pi hooks capture thinking/tool events;
- the client reports activity to the broker in order;
- broker `ActivityRenderer` debounces visible Telegram sends/edits and typing loops;
- hidden/untitled thinking uses a transient `⏳ working ...` placeholder rather than persisting empty `🧠 thinking ...` history;
- durable active activity message refs let the broker continue, retry, or clean activity around finals and broker turnover.

Rendering may throttle, but collected activity meaning should not be discarded merely because Telegram updates are debounced or rate-limited.

## Assistant final delivery

Assistant final delivery is broker-owned after durable acceptance.

Client side:

- retry-aware finalization defers transient provider/assistant failures without useful final text when pi may retry;
- final text wins over error metadata when non-empty;
- client final handoff persists only the pre-broker-acceptance ambiguity window in `client-pending-finals/*.json`, coordinated by `client-pending-finals.lock`;
- after broker acceptance, client retry should not become a parallel final-delivery system.

The retry-aware path exists because pi can emit an `agent_end` for a transient provider failure before its session-level auto-retry produces the assistant answer visible locally. The 2026-04-26 bug report (`inbox:assistant-final-lost-with`) described Telegram receiving low-context strings such as `fetch failed` or `terminated`, while the local pi session later showed a normal final and the broker had already completed the Telegram turn. The implementing task (`task:keep-telegram-finals-pending-across-pi`) corrected that boundary.

Current finalization treats retryable assistant/provider errors without final text as intermediate: it keeps the active Telegram turn, clears/supersedes the stale preview best effort, starts a bounded deferred-final grace, cancels only the watchdog when a retry begins, and consumes the deferred marker when retry output starts. If no retry begins, the deferred error-only payload is flushed through the same final-handoff path so queued Telegram work is not blocked indefinitely. If stop, disconnect, shutdown, or another cleanup path must release the deferred turn, the release path clears the deferred state and may hand off an aborted cleanup final instead of showing the transient provider error.

This client-side retry awareness is separate from Telegram Bot API delivery retry. A Telegram `sendMessage`/`editMessageText` failure named `fetch failed` is broker delivery state and remains retryable in the final ledger; it is not converted into Telegram-visible final text. Conversely, an error-only assistant/provider final that survives the deferred grace is rendered as a bridge failure message, while any non-empty assistant final text remains the visible final even when stop/error metadata is also present.

Broker side:

- `pendingAssistantFinals` records the final before visible Telegram output;
- repeated handoffs for the same turn/final are idempotent;
- delivery is FIFO;
- text chunks, sent chunk indexes, message IDs, attachment indexes, preview cleanup state, retry-at times, and terminal outcomes are persisted;
- partial success resumes from recorded progress after retry or broker turnover;
- terminal non-retryable failures close the final and allow later finals to proceed.

This design prevents known duplicate-final failure modes from long answers, IPC timeout ambiguity, broker restart/takeover, attachment-after-text retries, and premature Telegram finalization during pi/provider auto-retry.

## Telegram outbox

`src/broker/telegram-outbox.ts` owns cleanup-oriented Telegram side effects that need retry but are not assistant final text/attachment delivery.

Current outbox scope:

- queued-control status-message finalization;
- route topic deletion after route cleanup.

The outbox stores idempotent job IDs, status, attempts, retry time, terminal reason, and completion time. It honors `retry_after`, fans rate-limit barriers across pending cleanup jobs, and accepts broker-lease assertion hooks on fenced maintenance paths before side effects. Ordinary transient edit/delete failures defer only the failed job, while Telegram `retry_after` can set a broker-wide outbox retry barrier so unrelated cleanup does not hammer the Bot API during the rate-limit window.

Legacy cleanup state is migrated at drain time: terminal queued-control records with unfinalized status messages become status-edit jobs, pending route cleanups become route-topic-delete jobs, and an older queued-control cleanup retry marker seeds the outbox barrier only when there are no existing outbox jobs. Completed and terminal jobs are retained briefly for idempotency, but a fresh route cleanup may replace a finished route-topic job for the same cleanup identity so topic reuse during the retention window is not suppressed.

Route topic deletion remains downstream of lifecycle decisions. Session/route cleanup records the `pendingRouteCleanups` intent after a route is detached or expires; route-cleanup drains first mark route-scoped queued controls for finalization, then let the outbox delete the topic after those visible status edits have completed or reached a terminal state. Immediate queued-control cleanup paths drain only status-edit jobs, preventing unrelated topic deletion before their routes' controls have been prepared.

Assistant final delivery stays in `src/broker/finals.ts` because final chunks/attachments have stricter FIFO and visible-progress requirements.

## Route and session lifecycle

Routes are connection-scoped Telegram views. A route is identified by session,
chat, route mode, and optional `message_thread_id`; matching by chat alone is not
enough to reuse or target it safely.

Route registration computes the expected route target from the current Telegram
routing config. Existing routes are reused only when they match the expected
mode, chat, and thread shape; disabled routing detaches current routes and rejects
reachability instead of preserving stale routes. Selector-mode `/use` selections
are scoped to the source chat and ensure a selector route for that same chat.
Forum-topic fallback requires both the stored chat identity and the
`message_thread_id`, so same-numbered threads in different chats do not collide.

Route replacement is fail-safe: the broker creates or selects the new expected
route before detaching old routes, queues cleanup only for superseded topic
routes, and clears pending cleanup when a route becomes active again. Session
replacement handoff retargets route-bound pending turns, assistant finals,
activity, manual compactions, queued controls, and selector selections to the
replacement session while leaving unrelated routes alone.

Lifecycle rules:

- explicit disconnect unregisters and cleans up immediately;
- normal shutdown unregisters and cleans up unless a native session replacement handoff succeeds;
- heartbeat or IPC loss marks a session offline first;
- reconnect grace preserves a route for bounded automatic recovery;
- expired reconnect grace unregisters the session and records route/topic cleanup;
- successful `/new`, `/resume`, or `/fork` replacement can preserve Telegram reachability for the replacement runtime.

Native pi history remains local and is not stored in Telegram topics.

## Attachments and temp cleanup

Inbound Telegram attachments are downloaded to private session temp directories and treated as untrusted. Temp cleanup is intended to follow session lifecycle rather than broker lifecycle:

- generic broker shutdown, lease loss, or takeover leaves per-session temp data in place;
- explicit disconnect, normal session shutdown, and reconnect-grace expiry unregister a session and then attempt to remove that session's temp directory;
- cleanup is skipped while broker state still has a live session, pending turn, or pending assistant final for the session ID being cleaned;
- broker startup/heartbeat maintenance sweeps old orphan session temp directories after a conservative TTL, without deleting active or pending sessions.

The implementation anchor is `src/telegram/temp-files.ts`, with lifecycle callbacks wired from `src/extension.ts` into `src/broker/sessions.ts`. `scripts/check-telegram-temp-cleanup.ts` covers live/pending preservation, unregister cleanup, offline cleanup after grace, pending-work preservation, and old-orphan sweeping.

Current-state caveat: downloaded-file creation still uses the preparing runtime's session ID in `src/extension.ts`, while routed Telegram turns may target a different `route.sessionId` in multi-session mode. The cleanup helper protects the session ID of the temp directory being cleaned, so future work should align download ownership with routed target-session ownership before relying on these docs as a full multi-session guarantee. This gap is captured in `inbox:downloaded-telegram-files-may`.

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

- `scripts/check-activity-rendering.ts`
- `scripts/check-broker-background.ts`
- `scripts/check-broker-renewal-contention.ts`
- `scripts/check-pi-status-diagnostics.ts`
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
- `scripts/check-session-route-registration.ts`
- `scripts/check-session-unregister-cleanup.ts`
- `scripts/check-session-replacement-handoff.ts`
- `scripts/check-session-topic-setup-and-offline-grace.ts`
- `scripts/check-telegram-temp-cleanup.ts`
