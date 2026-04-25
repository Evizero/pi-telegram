# Architecture

## Document mode

This document is a mixed architecture document with separated modes.

The **architecture contract** is the normative design guidance for future work.
It describes the structure that must be preserved or deliberately revised when
requirements change.

The **current-state clarification** grounds that contract in the code that now
exists under `src/`.
The implementation already follows the main product shape: a pi extension owns
Telegram polling, broker election, local IPC, session routing, activity
rendering, previews, attachments, and pi hooks.

The **migration notes** call out remaining pressure points.
They are not implementation tasks by themselves, but they identify places where
future tasks should preserve the contract while improving the code shape.

## Scope

This architecture covers the `pi-telegram` extension runtime, its Telegram Bot
API boundary, its local broker/client coordination, its pi integration points,
and its repository planning and guidance artifacts.

The architecture deliberately does not define a hosted relay service, a public
webhook deployment, a multi-user collaboration model, a general Telegram bot
framework, or an independent remote execution environment.
Those are outside the intended purpose and current StRS/SyRS baseline.

The central product structure is simple: Telegram is the remote control surface;
pi sessions remain the execution authority; one extension-owned broker bridges
between them without a separate daemon.
Everything else exists to preserve that boundary under real Telegram constraints
and multi-session lifecycle churn.

## Architectural drivers

The strongest drivers come directly from the intended purpose and requirements:

- remote operators need to babysit local pi sessions from Telegram while work
  continues on the originating computer (`StRS-remote-session-supervision`,
  `SyRS-deliver-telegram-turn`, `SyRS-local-authority-boundary`);
- the extension itself must perform brokering, polling, and routing without an
  external daemon, relay server, or inbound workstation endpoint
  (`StRS-no-inbound-server-operation`, `SyRS-extension-owned-broker`,
  `SyRS-no-inbound-workstation-endpoint`);
- one paired Telegram user controls the bridge, and unauthorized updates must
  fail closed (`StRS-paired-user-control`, `SyRS-pair-one-user`,
  `SyRS-reject-unauthorized-telegram`);
- multiple local sessions may be connected at once, so session identity and
  routing must be explicit (`StRS-multi-session-supervision`,
  `SyRS-register-session-route`, `SyRS-list-and-select-sessions`,
  `SyRS-topic-routes-per-session`);
- busy-turn control must distinguish steering from follow-up work
  (`StRS-busy-turn-intent`, `SyRS-busy-message-steers`,
  `SyRS-follow-queues-next-turn`);
- activity and final responses must stay intelligible and non-duplicated even
  when Telegram previews, edits, chunks, and retries are involved
  (`StRS-activity-final-feedback`, `SyRS-activity-history-rendering`,
  `SyRS-final-preview-deduplication`, `SyRS-final-delivery-fifo-retry`);
- Telegram update, webhook, retry, file, draft, media, and topic constraints are
  part of the runtime contract, not optional polish
  (`StRS-api-constrained-maintenance`, `SyRS-webhook-before-polling`,
  `SyRS-telegram-retry-after`, `SyRS-telegram-text-method-contracts`,
  `SyRS-inbound-file-privacy-limits`, `SyRS-outbound-photo-document-rules`);
- Telegram files and local artifacts cross a trust boundary and must remain
  bounded, private, and explicit (`StRS-attachment-exchange`,
  `SyRS-inbound-attachment-untrusted`, `SyRS-outbound-attachment-safety`,
  `SyRS-explicit-artifact-return`, `SyRS-bridge-secret-privacy`).

## Quality goals

### Continuity of control

The operator should be able to connect, observe, steer, follow up, stop, and
receive final results without caring which local session currently owns the
broker role.
This goal drives durable broker state, route reuse, pending-turn retry, final
retry, and explicit session lifecycle handling.

### Local-first authority

Telegram must not become the execution environment.
It carries commands, messages, previews, and files, but shell execution,
workspace mutation, model selection, credentials, and session state remain
inside pi on the local computer.
This goal drives the pi-hook boundary, outbound attachment allowlisting, and the
extension-owned broker design.

### Telegram API correctness

Telegram's Bot API constraints are architectural constraints because violating
them breaks the remote control loop.
The architecture must preserve long polling instead of webhooks, `retry_after`
semantics, update-offset durability, file limits, text limits, draft eligibility,
forum-topic rules, and media-group batching.

### Delivery durability without duplication

A message, album, activity update, preview, final answer, or attachment failure
must not be silently lost; it also must not be repeated in a way that confuses
the operator.
This goal drives durable pending turns, completed-turn dedupe, FIFO final retry,
chunk-aware preview finalization, and serialized persistence/flush paths.

Current-state clarification: pending turns and media groups are persisted in
`BrokerState` today, but assistant-final payloads are still partly held in
process memory while moving from the client to broker delivery path.
The architectural contract is stronger than that current implementation: final
responses need a durable broker-delivery ledger or equivalent persisted state
until Telegram delivery succeeds or a terminal non-retryable outcome is recorded.

### Trust-boundary clarity

The bridge handles bot tokens, IPC sockets, local files, downloaded Telegram
attachments, and potentially sensitive generated artifacts.
Future work must keep private data private, treat Telegram attachments as
untrusted, and require explicit pi attachment intent before uploading local
artifacts back to Telegram.

### Maintainer and agent legibility

The repository must remain understandable to future human and agent maintainers.
Responsibility folders, `docs.md`, `AGENTS.md`, local TypeScript validation, and
PLN requirements all exist so future changes can be checked against purpose,
requirements, Telegram API constraints, and architecture instead of chat memory.

## Quality scenarios

### Mid-turn mobile takeover

A pi turn is already running when the operator decides to leave the computer and
runs `/telegram-connect`.
The pi hooks register the session, the broker creates or reuses the route, the
current turn starts reporting activity to Telegram, and the final answer is
delivered to the route when the turn completes.
The important property is continuity: connection attaches to the active local
session rather than only future turns.
If route creation or broker registration is transiently unavailable, retryable
state must survive long enough for the next heartbeat or broker attempt.

### Busy Telegram message routing

The selected pi session is busy and the paired user sends a normal Telegram
message.
The broker converts it into a pending turn for the selected route and the client
delivers it with steering semantics.
If the user sends `/follow ...` instead, the same transport delivers follow-up
work queued after the active turn.
The important property is intent preservation: normal busy messages affect the
current run, while explicit follow-up messages do not.

### Telegram rate limit during final delivery

A final assistant response is ready, but Telegram returns `retry_after` while
sending a preview edit, text chunk, or attachment.
The Telegram API layer preserves the retry signal; final delivery remains queued
in FIFO order; newer finals do not bypass older ones; and successful chunks are
not resent in a way that duplicates the visible response.
The important property is durable, ordered completion through Telegram delivery
or explicit terminal failure, not mere client-to-broker acceptance.

Current-state clarification: the implementation has retry-aware final queues, but
assistant-final payloads are not yet represented as first-class persisted broker
state.
That is a known gap against the architecture contract and `SyRS-final-delivery-fifo-retry`.

### Broker turnover with pending work

The current broker session shuts down or misses its lease while pending turns or
retryable delivery work exists.
Another connected extension process may acquire the lease, load broker state,
resume polling, retry pending turns for online clients, and continue any delivery
work that is represented in durable broker state.
The important property is that ordinary shutdown marks sessions offline and
stops ephemeral typing loops without deleting durable routing or retryable work.

Current-state clarification: pending turns and media groups have this durable
handoff shape today.
Assistant finals need the same persisted handoff shape before broker turnover can
be said to fully preserve final delivery.

### Telegram album ingestion

Telegram sends several updates for one media group, and a late album update
arrives while the first flush is being prepared.
The broker batches updates by media-group key, snapshots the processed update
IDs, prepares a single turn, removes only processed updates, and reschedules
late or retryable updates.
The important property is complete attachment context without either dropping or
duplicating album members.

## Traceability and provenance model

The primary planning chain is:

`dev/INTENDED_PURPOSE.md` → `dev/STAKEHOLDER_REQUIREMENTS.json` →
`dev/SYSTEM_REQUIREMENTS.json` → `dev/tasks/` implementation work.

The current architecture is downstream of the intended purpose and the StRS/SyRS
sets created for remote supervision, authorization, brokering, delivery,
Telegram API correctness, attachment safety, and maintainability.
If future architecture text needs a runtime behavior not covered by SyRS, the
requirement layer should be updated rather than hiding the behavior here.

The companion provenance chain preserves human source basis and API basis:

- `dev/references/*.md` stores captured voice-note directives such as no
  external broker daemon and local execution boundary;
- `docs.md` stores Telegram Bot API source links and bridge-specific API notes;
- `AGENTS.md` stores agent-facing repository rules;
- `README.md` stores the user-facing setup and operation workflow;
- Git history preserves implementation and planning changes together.

Architecture changes that reinterpret imposed human directives, Telegram API
constraints, or local-first trust boundaries must update the relevant planning
and guidance artifacts in the same coherent change slice.

## Constraints and boundaries

### Extension-owned brokering

Brokering belongs inside the pi extension process family.
One connected session acts as broker by holding the broker lease, polling
Telegram, owning shared broker state, and dispatching work to client sessions.
No design should require a separately installed daemon, hosted relay, external
broker service, or public inbound endpoint as the normal operating mode.

### Pi remains the execution authority

Telegram handlers may create pi user input, steering, follow-up work, stop
requests, model/session commands, and explicit attachment deliveries.
They must not create an independent Telegram-side shell, file editor, credential
reader, model runtime, or workspace mutation channel.

### Telegram is an untrusted external boundary

Telegram users, chats, updates, files, filenames, MIME types, API descriptions,
and retry behavior all cross a boundary.
The broker must authenticate the paired user before dispatch, preserve structured
API error data, treat attachments as user-provided files, and keep downloaded
files private.

### Durable state is owned by the broker scope

Broker state and lease files live under the configured bot-scoped broker
directory beneath `~/.pi/agent/telegram-broker/`.
Configuration lives in `~/.pi/agent/telegram.json` with legacy broker config
fallback.
Downloaded Telegram files live under `~/.pi/agent/tmp/telegram/`.
These files are local runtime artifacts, not repository planning artifacts.

### Planning and source guidance are repository artifacts

`dev/`, `docs.md`, and `AGENTS.md` are repository-owned project memory.
They should be changed deliberately through PLN/guided workflows and kept in Git
with related code when they explain the same behavior.

## Architectural invariants

- Exactly one paired Telegram user owns bridge control in the current product
  identity.
- The normal runtime uses Telegram long polling after webhook deletion, not a
  public webhook endpoint.
- The broker role is elected among extension processes and is not an external
  service.
- Session routes are explicit and must be reused or removed deliberately; route
  creation must not race into duplicate topics.
- Ordinary shutdown marks sessions offline; explicit disconnect unregisters and
  may remove routes/topics.
- Pending turns and media groups are retryable durable broker state until
  consumed, processed, or terminally failed.
- Assistant final delivery must become retryable durable broker state until the
  final is delivered to Telegram or terminally failed; the current in-memory
  final queue is a migration gap, not the target architecture.
- Busy ordinary messages steer; explicit follow-up messages queue after the
  active turn.
- Activity collection preserves history; Telegram rendering may debounce but may
  not erase collected event meaning.
- Final preview finalization is chunk-aware and must avoid duplicate visible
  responses.
- Telegram `retry_after` is a control signal, not a generic failure.
- Telegram attachments are untrusted and local files are uploaded only through
  explicit pi attachment intent and allowlisted paths.
- No TypeScript source file should grow beyond 1,000 lines; responsibility
  boundaries should be maintained by extraction, not by renaming a god file.

## Runtime surfaces

### pi extension surface

`index.ts` is the package entrypoint and should stay tiny.
It imports `registerTelegramExtension` from `src/extension.ts` and gives pi the
extension factory.

The extension registers pi commands such as setup, connect, disconnect, and
status; registers the `telegram_attach` tool; observes pi session and assistant
events; and injects a Telegram-specific prompt suffix that explains attachment
and trust-boundary rules to the agent.

### Telegram surface

The Telegram surface is a paired bot chat plus optional topic routing.
It receives messages, commands, media groups, and files through polling.
It sends text replies, activity previews, final answers, typing indicators,
photos, documents, and topic-management calls through the Bot API.

Telegram commands are operator controls, not an independent application surface.
They exist to choose sessions, inspect status, steer work, queue follow-ups,
stop runs, manage routing, and keep the bridge paired.

### Local IPC surface

Broker and client extension processes communicate over local IPC sockets under
the broker directory.
IPC carries registration, heartbeat, turn delivery, abort, activity updates,
assistant final delivery, session offline notifications, and consumed-turn
notifications.
This surface is local-only and part of the no-external-daemon design.

### Filesystem state surface

The runtime persists config, lease, token, broker state, and downloaded files in
user-local `.pi/agent` paths.
Persistence is part of delivery durability and broker turnover; it must remain
private and serialized where stale writes could resurrect old state.

### Repository planning surface

PLN artifacts under `dev/`, `docs.md`, and `AGENTS.md` define purpose,
requirements, API constraints, and agent workflow rules.
These files are not runtime inputs for the extension, but they are
architecture-relevant because they constrain future changes.

## Persisted artifact model

### Telegram configuration

`TelegramConfig` stores bot token and identity, paired user/chat IDs, pairing
code hash and expiry, topic mode, fallback mode, and fallback supergroup chat.
It is the local authority for pairing and routing setup.
Token-bearing config must remain private and must not be echoed to Telegram or
logs in normal operation.

### Broker lease

`BrokerLease` stores owner identity, process ID, startup time, lease epoch,
socket path, expiry, update time, and optional bot ID.
The lease prevents multiple sessions from polling Telegram at once.
Broker takeover must be explicit through lease expiry or valid replacement, not
implicit parallel polling.

### Broker state

`BrokerState` stores recent Telegram update IDs, last processed update ID,
session registrations, routes, pending media groups, pending turns, completed
turn IDs, and timestamps.
It is the durable handoff record for polling safety, route continuity, broker
turnover, pending work retry, and dedupe.

Architecture contract: selector-mode session selections created by `/use` are
also route-continuity state and should be persisted in broker-scoped state until
they expire, are changed, or become invalid.
Current-state clarification: selector choices are currently held in the in-memory
`selectedSessionByChat` map in `src/broker/commands.ts`, so selector continuity
across broker turnover is a migration gap.

Writes must be serialized so an older persistence operation cannot resurrect
completed turns or discard newer routes or selections.

### Session registration

`SessionRegistration` stores session identity, owner, process, cwd, project and
Git metadata, model summary, status, active turn ID, queue count, heartbeat,
client socket path, and topic name.
This record is what lets Telegram show useful session choices without moving
execution out of pi.

### Telegram route

`TelegramRoute` binds a pi session to a chat and optional `message_thread_id`.
Routes may represent private bot topics, forum-supergroup topics, or a
single-chat selector mode.
Every send path that belongs to a routed session must preserve this route
context.

### Pending turn and assistant final

`PendingTelegramTurn` captures the selected session, Telegram route, attachments,
content, history text, and delivery mode.
It is currently persisted under `BrokerState.pendingTurns` so broker retry and
turn consumption have a durable handoff point.

Assistant final payloads pair a pending turn with final text, stop/error state,
and queued outbound attachments.
The architecture contract requires these payloads, or an equivalent delivery
ledger, to be persisted until Telegram delivery succeeds or a terminal
non-retryable outcome is recorded.
Current-state clarification: `pendingAssistantFinals` is an in-memory queue in
`src/extension.ts`, so final delivery durability across broker process loss is a
known migration gap.

## Architectural decomposition

### Composition root: `src/extension.ts`

`src/extension.ts` is the runtime composition root.
It wires pi, broker, client, Telegram, previews, activity, config, IPC, and
state together.
It may own cross-cutting orchestration that genuinely spans those boundaries,
but it should not become the permanent home for every concern.

Current-state note: this file is still large and close to the 1,000-line guard
rail.
Future work should extract cohesive broker lease/state/session lifecycle and
client turn lifecycle modules without changing the product boundaries.

### Broker modules: `src/broker/`

`broker/updates.ts` owns Telegram update polling, authorization gate entry,
media-group batching, polling offset initialization, webhook removal before
polling, offline marking, and retrying pending turns.

`broker/commands.ts` owns Telegram command dispatch and command semantics such
as session selection, status, model control, compact, follow-up, stop, broker
status, and disconnect.

`broker/activity.ts` separates activity collection from Telegram rendering.
`ActivityReporter` sends ordered activity updates to the broker; `ActivityRenderer`
renders those updates with debounced Telegram sends/edits and typing loops.

`broker/sessions.ts` owns broker-side session offline and unregister cleanup.
It distinguishes offline state from explicit unregister and ensures typing loops
and route/topic cleanup follow the right lifecycle.

### Client modules: `src/client/`

`client/session-registration.ts` collects local session metadata used by broker
routing and session lists.

`client/info.ts` formats client-visible status and model information.
These modules keep session identity and model metadata separate from Telegram
command parsing.

### pi integration: `src/pi/hooks.ts`

`pi/hooks.ts` registers pi commands, tools, and event hooks.
It owns the boundary where local pi events become Telegram activity/finals and
where `telegram_attach` queues explicit outbound artifacts.
It should not own Telegram Bot API mechanics or broker polling.

Current-state note: `pi/hooks.ts` imports activity line helpers from
`broker/activity.ts`.
That dependency is narrow and presentation-model oriented, but it crosses the
preferred folder boundary; future extraction should move shared activity DTOs or
formatters to `shared/` if the dependency grows.

### Telegram modules: `src/telegram/`

`telegram/api.ts` is the low-level Bot API and file-download boundary.
It preserves structured Telegram API errors, optional `file_path`, retry signals,
download limits, and private local file writes.

`telegram/retry.ts` centralizes retry-after sleeping behavior around Telegram
requests that can be safely retried.

`telegram/previews.ts` owns streaming preview state, draft-vs-message preview
selection, edit throttling, chunk-aware finalization, and stale preview cleanup.

`telegram/attachments.ts` owns outbound attachment method selection and fallback
between photo and document delivery.

`telegram/turns.ts` owns durable Telegram turn construction and deterministic
turn IDs.

### Shared modules: `src/shared/`

`shared/types.ts` defines the cross-module data model.
`shared/config.ts` defines paths, size limits, timing constants, prompt suffix,
and config read/write behavior.
`shared/ipc.ts` owns local IPC envelope and request/response mechanics.
`shared/format.ts`, `shared/messages.ts`, `shared/ui-status.ts`, and
`shared/utils.ts` own reusable formatting, message extraction, UI text, and
small runtime helpers.

Shared modules should stay cohesive and low-level.
They should not grow broker policy or Telegram command semantics.

## Dependency direction and allowed exceptions

The intended dependency direction is:

- `index.ts` depends only on the extension composition root.
- `src/extension.ts` composes all runtime modules and may depend on each
  responsibility folder.
- Responsibility modules should depend on `shared/*` and on narrower peer
  interfaces passed in as dependency objects.
- Telegram API mechanics live under `telegram/*` and should not depend on pi
  hooks or broker command policy.
- Broker modules may depend on Telegram abstractions through injected functions
  or narrow imports, but should not own low-level multipart/download details.
- Pi hooks may call broker/client orchestration callbacks but should not poll
  Telegram or mutate broker lease files directly.
- Shared modules must not import broker, client, pi, or Telegram policy modules.

Allowed exceptions are narrow composition conveniences in `src/extension.ts`.
Because the extension is a single-process plugin, the composition root may hold
closure state and dependency injection glue that would be over-abstracted if
forced into a framework.
When that glue becomes cohesive policy, it should move into the owning folder.

Current-state exception: `src/pi/hooks.ts` imports activity-line helpers from
`src/broker/activity.ts`.
This is tolerated only as a narrow activity presentation dependency.
The contract direction is to move shared activity types/formatting into
`src/shared/` if pi-side activity construction becomes broader or if broker
activity rendering stops being the natural owner.

## Key runtime scenarios

### Setup and pairing

The pi setup command collects the bot token and writes local config.
The broker polls Telegram after deleting any webhook.
Before pairing, only a private `/start <code>` matching the hashed current code
can bind `allowedUserId` and `allowedChatId`.
After pairing, updates from other users are rejected before command or turn
dispatch.

This scenario protects `SyRS-pair-one-user` and
`SyRS-reject-unauthorized-telegram`.

### Broker election and client registration

Each connected extension process can attempt broker ownership through the local
lease.
The broker owns Telegram polling and shared state; non-broker sessions register
as clients over local IPC and heartbeat with session metadata.
Registration creates or reuses routes under a per-session lock so concurrent
heartbeat and registration do not create duplicate topics.

This scenario protects `SyRS-extension-owned-broker`,
`SyRS-register-session-route`, `SyRS-list-and-select-sessions`, and
`SyRS-topic-routes-per-session`.

### Telegram update to pi turn

Polling fetches updates with an offset derived from durable broker state.
The broker rejects unauthorized updates, handles commands first, batches albums
when needed, prepares attachments, creates a durable turn, and dispatches it to
the selected session's client socket.
Delivery mode controls whether the client steers, queues follow-up work, or
starts a normal turn.
Consumed-turn IPC removes durable pending state only after pi has accepted the
turn semantics.

This scenario protects `SyRS-deliver-telegram-turn`,
`SyRS-durable-update-consumption`, `SyRS-media-group-batching`,
`SyRS-busy-message-steers`, and `SyRS-follow-queues-next-turn`.

### Activity, preview, and final response

Pi event hooks collect thinking and tool activity and report it to the broker.
The broker renders activity through debounced Telegram edits without erasing the
ordered activity model.
Assistant text streams through `PreviewManager`, which chooses draft or message
preview mode according to Telegram constraints.
On final response, preview state is finalized into one visible final sequence,
long text is chunked, attachments are sent only from explicit pi queues, and
retryable failures keep final delivery pending.

This scenario protects `SyRS-activity-history-rendering`,
`SyRS-final-preview-deduplication`, `SyRS-final-delivery-fifo-retry`,
`SyRS-telegram-text-method-contracts`, and `SyRS-explicit-artifact-return`.

### File ingress and egress

Inbound Telegram file metadata is treated as untrusted.
The Telegram API layer enforces hosted Bot API download caps through message
metadata, `getFile`, HTTP headers, and streaming byte counts; missing
`file_path` fails clearly; downloaded files are written privately.
Outbound files originate only from pi's explicit attachment queue, resolve
relative paths against session cwd, pass allowlist/secret checks, and then use
Telegram photo/document methods according to method constraints.

This scenario protects `SyRS-inbound-file-privacy-limits`,
`SyRS-inbound-attachment-untrusted`, `SyRS-outbound-attachment-safety`, and
`SyRS-outbound-photo-document-rules`.

## Cross-cutting concepts

### Route identity

Route identity is the bridge between Telegram's chat/thread world and pi's
session world.
Every activity update, preview, final, upload, typing action, and command reply
must preserve the intended route context.
Losing route identity is equivalent to losing session control.

### Durable versus ephemeral state

Lease files, broker state, routes, pending turns, and pending media groups are
current durable state that survives ordinary runtime churn.
Selector-mode session choices and queued assistant finals are target durable
state under the architecture contract, but the current implementation still keeps
those lifecycle details in memory; those gaps are called out in the migration
notes.
Typing loops, in-flight preview timers, current socket attempts, and local
activity flushes are ephemeral.
Future code must not delete durable or target-durable delivery state merely to
clean up ephemeral work.

### Retry-aware failure

Telegram `retry_after` changes control flow.
A retryable Telegram error should delay and preserve ordering; it should not
trigger formatting fallback, attachment method fallback, update acknowledgement,
or final queue bypass unless the specific operation already succeeded.

### Explicit attachment intent

Inbound attachments are user-provided context.
Outbound attachments are local files crossing into Telegram and require explicit
pi intent through `telegram_attach`.
The architecture treats these as different trust directions even though both use
Telegram file methods.

### Activity model versus rendering model

Activity history is the model; Telegram messages are a lossy rendering of that
model under API limits.
The renderer may debounce, coalesce visible edits, or use typing indicators, but
it must not become the only source of activity truth.

## Architectural decisions and rationale

### Use long polling instead of webhooks

**Context:** The user should not expose the workstation to inbound traffic or
operate extra infrastructure.
Telegram also forbids `getUpdates` while a webhook is active.

**Decision:** The normal runtime deletes webhooks and uses long polling from the
extension-owned broker.

**Consequences:** Setup stays local and simple.
The broker must handle offset durability, duplicate updates, webhook deletion
retry, and Telegram long-poll failure behavior.

### Elect one broker among extension processes

**Context:** Multiple pi sessions may connect to the same bot, but only one
process should poll Telegram.
An external daemon was explicitly rejected.

**Decision:** Connected extension processes coordinate through local lease and
IPC files; one becomes broker, others register as clients.

**Consequences:** Multi-session operation needs broker state persistence,
heartbeats, offline handling, and takeover behavior.
The design avoids a separate service but makes the composition root and broker
state more important.

### Keep Telegram as control surface, not execution surface

**Context:** The operator wants phone control while everything still runs on the
laptop.

**Decision:** Telegram updates become pi messages, commands, or attachment
queues; execution authority remains in local pi sessions.

**Consequences:** The extension must be strict about authorization, attachment
allowlists, secret handling, and untrusted inbound files.
It should not grow Telegram-native shell or workspace browsing features unless
the intended purpose and requirements are revised.

### Separate activity collection from Telegram rendering

**Context:** Telegram edits and draft previews are rate-limited and method-bound,
but the operator needs meaningful progress history.

**Decision:** Activity collection/reporting is distinct from activity rendering.
Rendering may debounce; collection preserves ordered events.

**Consequences:** Future preview or UI changes should not collapse the activity
model into the latest visible Telegram message.

### Keep Bot API constraints in project-local guidance

**Context:** Telegram's API behavior is specific and easy to regress.
Future agents may not have the original review context.

**Decision:** `docs.md` records project-relevant official Bot API constraints,
and `AGENTS.md` instructs coding agents to consult it.

**Consequences:** Runtime changes that touch Telegram should update code,
requirements, and guidance together when the API contract changes.

## Migration notes and pressure points

### Composition root size

`src/extension.ts` remains the largest file and is close to the 1,000-line
limit.
It is acceptable as the current composition root, but it should shrink as future
work extracts cohesive broker lease/state/session lifecycle and client turn
lifecycle modules.
Extraction should preserve dependency injection and ownership boundaries rather
than merely moving a god file to another name.

### Limited automated test surface

The repository currently has TypeScript checking as the reliable local
validation command.
Many SyRS acceptance criteria are test-shaped, but dedicated behavioral tests
are not yet present.
Future implementation tasks should add tests around broker persistence, preview
finalization, retry handling, attachment safety, and route lifecycle where
practical.

### Runtime state in closures

The composition root currently holds substantial mutable runtime state in
closures.
That is workable for a single extension process but makes some flows harder to
review.
Future extraction may introduce narrower state containers for broker runtime,
client runtime, preview/final delivery, and pi-hook lifecycle.

### Assistant-final durability

`SyRS-final-delivery-fifo-retry` requires final responses to remain retryable
until Telegram delivery succeeds or a terminal non-retryable outcome is recorded.
The current code keeps client-side pending assistant finals in memory and removes
some client retry state once the broker accepts the final for delivery.
That is not the final target architecture for broker turnover.
Future work should persist final-delivery payloads or an equivalent delivery
ledger in broker-scoped state, with enough chunk/attachment progress tracking to
avoid duplicate visible Telegram output after retry.

### Selector-mode selection durability

`SyRS-selector-selection-durability` requires `/use` selections in selector mode
to survive broker turnover until they expire, change, or become invalid.
The current code stores those choices in `selectedSessionByChat` inside
`src/broker/commands.ts`, which is process memory only.
Future work should persist selector choices in broker-scoped state or derive them
from another durable route-selection record so unrouted Telegram messages keep
their intended session after broker takeover.

### Pi-to-broker activity dependency

`src/pi/hooks.ts` currently imports activity-line helpers from
`src/broker/activity.ts`.
This should remain narrow.
If more pi-side code starts depending on broker activity internals, split the
shared activity event model and formatting helpers into `src/shared/` while
leaving Telegram rendering in `src/broker/activity.ts`.

### Planning maturity

Purpose, StRS, SyRS, and architecture now exist, but no implementation tasks or
verification cases have been derived from them yet.
Until that happens, requirements are planning baseline rather than task-level
execution records.

## Repository mapping

- `index.ts` — package entrypoint; should only register the extension.
- `src/extension.ts` — runtime composition root, broker/client orchestration,
  state wiring, config setup, lease coordination, and cross-boundary callbacks.
- `src/broker/activity.ts` — activity model and Telegram activity rendering.
- `src/broker/commands.ts` — Telegram command router and command semantics.
- `src/broker/sessions.ts` — broker-side offline/unregister cleanup.
- `src/broker/updates.ts` — Telegram polling, authorization gate, update offset,
  media groups, offline marking, and pending-turn retry.
- `src/client/final-delivery.ts` — client-side assistant-final retry queue
  state and terminal Telegram delivery classification.
- `src/client/info.ts` — session/model status text and model command helpers.
- `src/client/session-registration.ts` — collection of local session metadata.
- `src/pi/hooks.ts` — pi commands, pi events, prompt suffix, and
  `telegram_attach` tool integration.
- `src/shared/config.ts` — config paths, broker paths, limits, timings, prompt
  suffix, and config read/write.
- `src/shared/types.ts` — cross-module runtime data model.
- `src/shared/ipc.ts` — local IPC envelope and transport helpers.
- `src/shared/format.ts`, `src/shared/messages.ts`, `src/shared/ui-status.ts`,
  `src/shared/utils.ts` — formatting, event extraction, user text, and small
  helpers.
- `src/telegram/api.ts` — low-level Telegram Bot API calls and downloads.
- `src/telegram/retry.ts` — retry-after wrapper.
- `src/telegram/previews.ts` — streaming preview state and finalization.
- `src/telegram/attachments.ts` — outbound attachment sending.
- `src/telegram/turns.ts` — Telegram turn construction and durable IDs.
- `docs.md` — source-backed Telegram Bot API notes for maintainers and agents.
- `AGENTS.md` — coding-agent operating instructions and PLN guidance.
- `dev/INTENDED_PURPOSE.md` — product identity and scope root.
- `dev/STAKEHOLDER_REQUIREMENTS.json` — stakeholder-visible needs.
- `dev/SYSTEM_REQUIREMENTS.json` — implementable/verifiable behavior baseline.
- `dev/references/` — captured human directives that constrain purpose and
  imposed requirements.

## Summary

The architecture is a local-first Telegram control bridge for pi sessions.
It keeps execution on the computer, makes Telegram a paired remote supervision
surface, elects one extension-owned broker among connected sessions, routes work
through durable local state and IPC, and treats Telegram API limits and trust
boundaries as first-class constraints.

Future work should preserve these properties unless the intended purpose and
requirements are deliberately revised: no external broker daemon, no inbound
workstation endpoint, exactly one paired controlling user, explicit session
routes, steering versus follow-up distinction, durable retry-safe delivery,
private/untrusted attachment handling, and repository-local guidance for
Telegram API behavior.
