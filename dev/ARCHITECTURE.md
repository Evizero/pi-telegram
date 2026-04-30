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
- multiple local sessions may be connected at once, so session identity,
  replacement continuity, and routing must be explicit
  (`StRS-multi-session-supervision`, `SyRS-register-session-route`,
  `SyRS-session-replacement-route-continuity`,
  `SyRS-list-and-select-sessions`, `SyRS-topic-routes-per-session`);
- busy-turn control must default ordinary mobile input to follow-up work while
  preserving explicit steering for urgent intervention and cancellation for
  obsolete or mistaken follow-ups (`StRS-busy-turn-intent`,
  `SyRS-busy-message-default-followup`,
  `SyRS-queued-followup-steer-control`, `SyRS-cancel-queued-followup`,
  `SyRS-queued-control-finalization`, `SyRS-follow-queues-next-turn`);
- non-urgent Telegram session controls such as manual compaction should be
  schedulable during active work without aborting that work, and they must act
  as ordered barriers for later dependent follow-up turns
  (`StRS-deferred-session-controls`, `SyRS-idle-telegram-compact`,
  `SyRS-queue-busy-compact`, `SyRS-compact-barrier-ordering`,
  `SyRS-queued-compact-durability`, `SyRS-compact-request-coalescing`);
- activity and final responses must stay intelligible, chronologically clear,
  and non-duplicated even when legacy preview cleanup, Telegram edits, chunks,
  pi/provider auto-retry, and Telegram delivery retries are involved
  (`StRS-activity-final-feedback`, `SyRS-activity-history-rendering`,
  `SyRS-final-preview-deduplication`, `SyRS-final-delivery-fifo-retry`,
  `SyRS-retry-aware-agent-finals`, `SyRS-final-text-before-error-metadata`);
- broker lease loss is a normal multi-session lifecycle outcome; stale broker
  state writes must be blocked without allowing already-running broker
  maintenance to crash the pi session process
  (`StRS-delivery-continuity`, `StRS-multi-session-supervision`,
  `SyRS-broker-lease-loss-standdown`);
- durable JSON artifacts are recovery boundaries, so malformed, unreadable, or
  schema-invalid records must be visible invalid-state conditions rather than
  implicit absence, and independent per-file recovery records should not block
  each other when one record is corrupt
  (`StRS-delivery-continuity`, `SyRS-durable-json-invalid-state`,
  `SyRS-durable-maintenance-file-isolation`);
- Telegram update, callback-query, webhook, retry, file, draft, media, and topic
  constraints are part of the runtime contract, not optional polish
  (`StRS-api-constrained-maintenance`, `SyRS-webhook-before-polling`,
  `SyRS-telegram-retry-after`, `SyRS-telegram-text-method-contracts`,
  `SyRS-interactive-model-picker`, `SyRS-inbound-file-privacy-limits`,
  `SyRS-outbound-photo-document-rules`);
- Telegram files and local artifacts cross a trust boundary and must remain
  bounded, private, and explicit (`StRS-attachment-exchange`,
  `SyRS-inbound-attachment-untrusted`, `SyRS-outbound-attachment-safety`,
  `SyRS-explicit-artifact-return`, `SyRS-bridge-secret-privacy`);
- installing the extension should not make ordinary unconnected pi startup pay
  the cost of broker/client/Telegram runtime construction; the heavy runtime is
  justified when Telegram is invoked or a valid recovery handoff exists
  (`StRS-inactive-startup-overhead`, `SyRS-lazy-inactive-runtime`);
- maintainers need clear runtime ownership boundaries so data models and
  configuration policy do not accumulate in broad shared buckets that obscure
  which broker, client, pi, Telegram, or IPC concern a change affects
  (`StRS-runtime-boundary-legibility`, `SyRS-shared-boundary-ownership`).

## Quality goals

### Continuity of control

The operator should be able to connect, observe, steer, follow up, stop, and
receive final results without caring which local session currently owns the
broker role.
This goal drives durable broker state, route reuse during live connections and
bounded reconnect windows, pending-turn retry, final retry, explicit session
lifecycle handling, and controlled stand-down when an old broker discovers it no
longer owns the lease.

### Local-first authority

Telegram must not become the execution environment.
It carries commands, messages, activity/final updates, and files, but shell
execution, workspace mutation, model selection, credentials, and session state
remain inside pi on the local computer.
This goal drives the pi-hook boundary, outbound attachment allowlisting, and the
extension-owned broker design.

### Telegram API correctness

Telegram's Bot API constraints are architectural constraints because violating
them breaks the remote control loop.
The architecture must preserve long polling instead of webhooks, `retry_after`
semantics, update-offset durability, file limits, text limits, draft eligibility,
forum-topic rules, and media-group batching.
Telegram IO policy is centralized under `src/telegram/`: low-level API calls
preserve structured and HTTP retry metadata, `errors.ts` owns Telegram error
classification, and `message-ops.ts` owns shared send/edit/delete/callback
message operations. Broker and client feature modules should call those policy
helpers instead of adding local regular-expression classifiers or fallback logic;
in particular, fallback from Markdown, edit, or photo upload must never consume a
rate-limit window signaled by Telegram.

### Delivery durability without duplication

A message, album, activity update, preview, final answer, or attachment failure
must not be silently lost; it also must not be repeated in a way that confuses
the operator.
This goal drives durable pending turns, completed-turn dedupe, FIFO final retry,
chunk-aware preview finalization, and serialized persistence/flush paths.

### Connection-scoped Telegram views

Telegram topics and routes are temporary views into connected local pi sessions,
not the durable session history.
The architecture should preserve routes while the session remains connected,
while it is plausibly recoverable through a bounded automatic reconnect path, or
while a user-initiated pi session replacement is handing Telegram reachability to
the replacement session. Explicit disconnect, terminal process close,
crash/death after reconnect grace, and successful cleanup should end the
Telegram view without deleting local pi history.

Current-state clarification: pending turns, media groups, visible preview
message references, and assistant-final payloads are persisted in `BrokerState`
today. The broker-owned assistant-final ledger records delivery progress for
final text chunks and queued attachments so retryable delivery resumes from
recorded progress instead of restarting visible Telegram output from the
beginning.

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
Reliability code should prefer one explicit owner per lifecycle concern over
parallel retry, replay, cleanup, or preview mechanisms that are almost but not
quite the same feature.

### Low inactive footprint

The extension should be cheap to keep installed when Telegram is not connected.
Ordinary pi startup may register command names, tool schemas, prompt guidance,
and lightweight lifecycle sentinels, but it should not import or construct the
broker/client/Telegram runtime graph unless Telegram is invoked or a valid
session-replacement handoff must be recovered. This goal preserves the extension
as a passive capability until the operator actually needs remote supervision.

## Quality scenarios

### Inactive startup stays light

A user starts pi in a repository where pi-telegram is installed but does not run
setup, connect, attach, or recover a previous Telegram-supervised session. The
extension registers the pi-visible command/tool/prompt surface and enough
lifecycle hooks to delegate later, but broker polling, client IPC, Telegram API
helpers, activity/final delivery, and background timers remain unloaded and
unconstructed. The important property is that installing the bridge does not
make every local pi session pay the full remote-supervision runtime cost.

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
The broker converts it into a pending turn for the selected route, and the
client queues it as follow-up work by default rather than steering immediately.
If the user sends `/steer ...` or activates an authorized steer control for a
still-queued follow-up, the same transport explicitly delivers steering for the
active turn.
If the user activates the sibling cancel control for that same still-queued
follow-up, the bridge withdraws that queued turn without stopping the active
turn or disturbing unrelated queued work.
When a queued follow-up becomes non-actionable without a button press, the
broker should finalize the visible queued-status message where Telegram editing
is possible so stale buttons do not imply an action is still available.
`/follow ...` remains a compatibility and accessibility path for explicit
queued follow-up work.
The important property is intent preservation and clarity: ordinary mobile notes
wait their turn, urgent intervention is still one explicit action away,
obsolete or mistaken follow-ups can be withdrawn, and old Telegram controls do
not misrepresent durable queue state while each action targets a specific
route/turn.

### Queued manual compaction barrier

The selected pi session is busy and the paired user sends `/compact` from
Telegram because the next mobile instruction should run after the session is
summarized.
The bridge should acknowledge that compaction is queued, leave the active pi
turn running, and represent the pending compaction as a first-class ordered
session operation rather than as fake conversation text.
When earlier active and queued work settles, the client starts pi manual
compaction; ordinary messages and `/follow ...` turns received after the queued
compaction remain behind that barrier until the compaction completion or failure
callback releases them.
Explicit steering remains an urgent active-turn correction path, while ordinary
messages and `/follow ...` preserve follow-up ordering behind the compaction
barrier.
The important property is lifecycle ordering: Telegram `/compact` can be
requested early from a phone without aborting useful work, and later queued
messages see a clear compaction boundary before they start.

### Telegram rate limit during final delivery

A final assistant response is ready, but Telegram returns `retry_after` while
cleaning up a detached preview, sending a final text chunk, or sending an
attachment.
The Telegram API layer preserves the retry signal; final delivery remains queued
in FIFO order; newer finals do not bypass older ones; final text is not edited
into an older preview message; and successful chunks are not resent in a way that
duplicates the visible response.
The important property is durable, ordered completion through Telegram delivery
or explicit terminal failure, not mere client-to-broker acceptance.

Current-state clarification: assistant-final payloads are represented as
first-class persisted broker state. The client only needs to retry until the
broker durably accepts the final; the broker delivery ledger then owns FIFO
Telegram delivery, retry windows, terminal outcomes, and partial-progress resume.

### Pi provider auto-retry before Telegram finalization

A pi turn reaches `agent_end` with a retryable transient provider failure such
as `fetch failed` or `terminated`, and pi's session layer may automatically
retry and later produce a normal assistant final.
The Telegram bridge must treat the transient failure as an intermediate pi
runtime state rather than as the Telegram final answer.
The active Telegram turn remains associated with the retry path until a stable
assistant final or clear terminal failure is known; stale preview rendering from
the failed attempt is cleared or superseded; and raw provider error metadata is
not allowed to replace useful non-empty assistant final text.
The important property is that Telegram reflects the stable outcome the local pi
session reaches, not the first retryable provider failure event observed at the
extension hook boundary.

Migration note: the current extension event surface exposes `agent_end` before
pi session auto-retry handling completes. Until the extension can consume an
explicit retry lifecycle event, client-side finalization needs a narrow deferred
state or grace path around retryable assistant errors.

### Broker turnover with pending work

The current broker session shuts down or misses its lease while pending turns or
retryable delivery work exists.
Another connected extension process may acquire the lease, load broker state,
resume polling, retry pending turns for online clients, and continue any delivery
work that is represented in durable broker state.
The important property is that broker turnover preserves work for still-live or
reconnecting sessions without turning a closed or dead session's Telegram topic
into permanent history.

Current-state clarification: pending turns, media groups, selector selections,
and assistant finals have this durable handoff shape today. Assistant finals
resume from their broker delivery ledger rather than from the client-side IPC
request that originally handed off the final. Route cleanup on session close or
expired reconnect grace is a planned correction to the current offline-preserve
behavior.

### Session close or crash cleanup

A connected pi session explicitly disconnects, closes normally, or stops
heartbeating because the process died.
Normal shutdown should unregister the session and request Telegram topic/route
cleanup immediately. Heartbeat or IPC loss is two-stage: after the heartbeat
staleness threshold the broker may mark the session offline for display, but it
records a reconnect-grace start time and preserves the route until the bounded
automatic reconnect grace expires. If the session reconnects in time, the
existing route continues; if it does not, the broker unregisters the session and
deletes its Telegram topic or selector route.
The important property is that Telegram shows a temporary view for the current
connection, while native pi history remains on the local machine for `/resume`
and later reconnection in a new Telegram view.

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

### Local broker IPC trusts the same OS user

The broker IPC surface is a local same-user coordination boundary, not a
hardened multi-tenant security boundary. Broker sockets, tokens, config, and
state are kept private from remote callers and other OS users through local
filesystem permissions, but processes running as the same local user are trusted.

Low-friction session attachment is intentional. A same-user process that can
access broker artifacts may attach or impersonate a pi session, and that risk is
accepted within the product threat model rather than mitigated through approval
prompts, per-session pairing, or additional user-visible authorization steps.

### Durable state is owned by the broker scope

Broker state and lease files live under the configured bot-scoped broker
directory beneath `~/.pi/agent/telegram-broker/`.
Configuration lives in `~/.pi/agent/telegram.json` with legacy broker config
fallback.
Downloaded Telegram files live under `~/.pi/agent/tmp/telegram/`.
They are retained in private per-session temp directories while the associated
session remains active, reconnectable, or still has pending Telegram turn/final
state that may depend on them, then removed on authoritative session end or a
conservative orphan sweep.
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
- Session routes are explicit temporary views and must be reused during live
  connection/reconnect grace or removed deliberately; route creation must not
  race into duplicate topics.
- Explicit disconnect and normal shutdown unregister the session and clean up its
  route/topic; heartbeat or IPC loss preserves the route only until bounded
  reconnect grace expires.
- Pending turns and media groups are retryable durable broker state until
  consumed, processed, or terminally failed.
- Malformed, unreadable, or schema-invalid durable JSON artifacts must not be
  treated as missing state; they should be diagnosed with artifact context and
  left intact unless a lifecycle-specific rule has classified them as safe to
  discard. Directory-scanned maintenance records should isolate bad files so
  unrelated valid recovery work can continue.
- Broker maintenance tasks that discover lease loss must stand down or discard
  stale in-memory work without producing unhandled asynchronous rejections or
  persisting stale state.
- Assistant final delivery must remain retryable durable broker state until the
  final is delivered to Telegram or terminally failed.
- Retryable pi/provider errors are not stable assistant finals while pi may
  auto-retry the same active Telegram turn; the bridge must defer Telegram
  finalization until retry success or a clear terminal failure.
- Busy ordinary messages queue as follow-up by default; explicit steering
  commands or controls target the active turn; queued-control buttons must be
  removed or finalized when they no longer represent an actionable queued turn.
- Non-urgent Telegram controls that are queued behind active work, such as
  manual compaction, must be represented as ordered session operations rather
  than fake user messages, and later follow-up turns must not overtake their
  barrier.
- Activity collection preserves history; Telegram rendering may debounce but may
  not erase collected event meaning.
- Final delivery detaches streamed preview messages before appending final
  assistant content as new Telegram messages; preview edits must not become the
  visible final response.
- Telegram `retry_after` is a control signal, not a generic failure.
- Telegram attachments are untrusted and local files are uploaded only through
  explicit pi attachment intent and allowlisted paths.
- No TypeScript source file should grow beyond 1,000 lines; responsibility
  boundaries should be maintained by extraction, not by renaming a god file.
- The pi-visible registration surface belongs to a lightweight bootstrap layer;
  the broker/client/Telegram runtime should be demand-loaded and must not
  register duplicate pi commands, tools, or event hooks after loading.

## Runtime surfaces

### pi extension surface

`index.ts` is the package entrypoint and should stay tiny.
The target architecture is that it imports only a lightweight bootstrap facade
that gives pi the extension factory and registers the pi-visible surface.

The bootstrap registers pi commands such as setup, connect, disconnect, and
status; registers the `telegram_attach` tool definition; observes pi session and
assistant events through lightweight delegating hooks; and injects a
Telegram-specific prompt suffix that explains attachment and trust-boundary
rules to the agent. The heavy broker/client/Telegram runtime is loaded through a
memoized dynamic import only when a command/tool/event actually requires runtime
state or when session-replacement recovery has a matching handoff.

Current-state clarification: the implementation still imports
`registerTelegramExtension` from `src/extension.ts` eagerly. Planned lazy-loading
work should split this into bootstrap-owned registration and runtime-owned
behavior without changing the public command/tool surface.

### Telegram surface

The Telegram surface is a paired bot chat plus optional topic routing.
It receives messages, commands, callback queries, media groups, and files through
polling.
It sends text replies, inline-keyboard prompts, activity previews, final answers,
typing indicators, photos, documents, and topic-management calls through the Bot
API.

Telegram commands and callback controls are operator controls, not an independent
application surface.
They exist to choose sessions, inspect status, steer work, queue follow-ups,
stop runs, change the selected local model, manage routing, and keep the bridge
paired.

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
Read paths must distinguish true absence from invalid durable state. Missing
files can initialize first-run or no-pending-work defaults; malformed,
unreadable, or schema-invalid files are corruption or recovery conditions that
should keep their original artifact available for diagnosis unless a specific
lifecycle cleanup rule safely supersedes it.

### Repository planning surface

PLN artifacts under `dev/`, `docs.md`, and `AGENTS.md` define purpose,
requirements, API constraints, and agent workflow rules.
These files are not runtime inputs for the extension, but they are
architecture-relevant because they constrain future changes.

## Persisted artifact model

### Telegram configuration

`TelegramConfig` stores bot token and identity, paired user/chat IDs, pairing
PIN hash, setup-window timing, failed-attempt count, topic mode, fallback mode,
and fallback supergroup chat. It is the local authority for pairing and routing
setup.
Token-bearing config must remain private and must not be echoed to Telegram or
logs in normal operation.

### Broker lease

`BrokerLease` stores owner identity, process ID, startup time, lease epoch,
socket path, expiry, update time, and optional bot ID.
The lease prevents multiple sessions from polling Telegram at once.
Broker takeover must be explicit through lease expiry or valid replacement, not
implicit parallel polling. Renewal may briefly encounter a live takeover lock
while the current broker still owns a live lease; that condition is broker
coordination contention, not generic heartbeat failure or lease loss. Repeated
live contention must become pi-safe diagnostic state, while missing, expired,
changed-owner, or changed-epoch leases still require controlled stand-down.

### Broker state

`BrokerState` stores recent Telegram update IDs, last processed update ID,
session registrations, routes, pending media groups, pending turns, queued-turn
control records, visible assistant preview message references, pending
assistant-final deliveries, pending Telegram outbox jobs, completed turn IDs,
and timestamps.
Architecture contract for queued session controls: when a Telegram control such
as `/compact` must wait for active work, broker state should preserve enough
operation identity, route/session ownership, and idempotency data to retry,
resume, or terminally clear that operation without treating it as ordinary user
conversation text.
It is the durable handoff record for polling safety, bounded route continuity,
broker turnover, pending work retry, queued follow-up controls, visible Telegram
cleanup retry, and dedupe.

Architecture contract and current implementation: selector-mode session
selections created by `/use` are route-continuity state persisted in
broker-scoped state until they expire, are changed, or become invalid.
Selector selections also ensure a selector route exists for the selected
chat/session so later commands can resolve the selected session.

Writes must be serialized and fenced by the current broker lease owner/epoch so
an older or stale broker persistence operation cannot resurrect completed turns,
regress update offsets, requeue stale cleanups, or discard newer routes or
selections.
A stale broker discovered by that fence is expected to stand down or ignore the
stale in-memory operation; lease-loss detection is not itself a fatal error for
the hosting pi session process.

### Session registration

`SessionRegistration` stores session identity, owner, process, cwd, project and
Git metadata, model summary, status, active turn ID, queue count, heartbeat,
reconnect-grace timestamp, client socket path, and topic name.
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
Queued session-control operations, such as a deferred manual-compaction barrier,
should remain distinct from `PendingTelegramTurn`: they carry session/route
identity and lifecycle status, but they are not user content and should not be
eligible for queued-turn steer/cancel controls unless a future requirement adds
a specific control surface for them.
Queued-turn control records are broker-owned state that map compact Telegram
callback tokens to a specific queued turn, route, session, target active turn,
visible status message, status, and expiry. They are not execution authority by
themselves: callback handling must ask the client to atomically remove a still-
queued turn before steering or cancelling it, then consume the pending turn
through the same durable turn lifecycle used by normal delivery. When a queued
turn becomes non-actionable without a callback, the broker should edit any known
visible status message to remove action buttons and show a terminal state where
Telegram editing succeeds. The broker Telegram outbox owns retry timing for
those visible status edits; the durable control state remains authoritative and
stale callbacks must fail closed when the turn has started, expired, converted,
cancelled, or disappeared even if the visible edit is delayed or terminal.

`BrokerState.pendingRouteCleanups` remains the route-lifecycle cleanup intent
record created when local routes are detached. The broker Telegram outbox owns
the resulting Telegram topic deletion job, including retry-at state, explicit
terminal outcomes, and replay after broker turnover. Local route unregister and
session-replacement/grace-period preservation decisions stay in lifecycle code;
the outbox only retries the visible Telegram side effects after a route has
already been detached or preserved by that lifecycle decision.

Assistant final payloads pair a pending turn with final text, stop/error state,
and queued outbound attachments.
`BrokerState.pendingAssistantFinals` persists those payloads plus delivery
progress until Telegram delivery succeeds or a terminal non-retryable outcome is
recorded. `BrokerState.assistantPreviewMessages` records visible preview message
IDs so broker takeover can detach existing previews before appending fresh final
messages, rather than editing older preview messages into final content. The
ledger tracks final text chunk progress and outbound attachment progress so
retries and broker turnover can resume without intentionally resending
already-recorded visible output.

## Architectural decomposition

### Bootstrap facade and runtime composition

The target entrypoint shape separates eager registration from heavy runtime
composition. A lightweight bootstrap module owns command/tool/hook registration,
prompt suffix injection, lazy-load policy, and cheap lifecycle sentinels. It must
not import broker polling, client runtime hosting, Telegram API IO, local IPC, or
final-delivery machinery on ordinary startup.

The heavy runtime composition root, currently `src/extension.ts` and potentially
a future `src/runtime/extension-runtime.ts`, wires pi, broker, client, Telegram,
previews, activity, config, IPC, and state together after bootstrap loads it. It
owns behavior, not pi surface registration, so lazy loading cannot create
second copies of commands, tools, or event handlers.

Current-state note: `src/extension.ts` is under the 1,000-line guard rail but is
still both the eager import target and the runtime composition root. Planned
lazy-loading work should extract the bootstrap/runtime seam while continuing to
extract cohesive broker lease/state/session lifecycle pieces where orchestration
pressure grows.

### Broker modules: `src/broker/`

`broker/updates.ts` owns Telegram update polling, authorization gate entry,
media-group batching, polling offset initialization, webhook removal before
polling, offline marking, and retrying pending turns.

`broker/commands.ts` is the thin Telegram command/callback dispatcher and route-aware
composition point for operator controls. Focused command/control modules own the
cohesive semantics behind that dispatcher: `broker/model-command.ts` owns `/model`
and model-picker callbacks, `broker/git-command.ts` owns `/git` menus and Git
action callbacks, `broker/queued-turn-control-handler.ts` owns queued follow-up
steer/cancel control lifecycle, and `broker/inline-controls.ts` centralizes common
tokenized inline-control message binding, route/session validation, callback
acknowledgement, and edit-or-send policy. These broker modules must continue to
use `src/telegram/` IO policy helpers rather than local Telegram error classifiers.

`broker/activity.ts` separates activity collection from Telegram rendering.
`ActivityReporter` sends ordered activity updates to the broker; `ActivityRenderer`
renders those updates with debounced Telegram sends/edits and typing loops.

`broker/lease.ts` owns file-based broker lease acquisition and renewal
classification. `broker/heartbeat.ts` owns heartbeat-cycle counters and overlap
suppression so one-off live takeover-lock contention does not advance generic
failure stand-down, repeated contention becomes actionable diagnostic state, and
true lease loss still routes through controlled stand-down.

`broker/sessions.ts` owns broker-side session offline and unregister cleanup.
It distinguishes offline state from explicit unregister and ensures typing loops
and local route detach/preservation follow the right lifecycle. For detached
routes, it records cleanup intent and hands visible queued-control finalization
and Telegram topic deletion to the broker Telegram outbox instead of performing
ad hoc retry loops inline.

`broker/telegram-outbox.ts` owns the broker-side persisted Telegram side-effect
outbox for cleanup-oriented side effects. Its current scope is queued-control
status-message finalization and Telegram forum-topic deletion after route
cleanup. It provides idempotent job IDs, legacy-state migration from older
`pendingRouteCleanups` and queued-control retry markers, serialized drain
behavior, retry-at / `retry_after` handling, terminal topic-cleanup diagnostics,
and broker-lease assertion hooks. It deliberately does not own assistant final
text chunk or attachment delivery; `broker/finals.ts` remains the FIFO final
ledger for those higher-risk delivery steps.

### Client modules: `src/client/`

`client/session-registration.ts` collects local session metadata used by broker
routing and session lists.

`client/info.ts` formats client-visible status and model information.
These modules keep session identity and model metadata separate from Telegram
command parsing.

Client turn and finalization modules own execution-side lifecycle decisions.
`client/turn-lifecycle.ts` is the named owner for active Telegram turn state,
queued follow-up state, awaiting-final gates, abort callbacks, completed and
disconnected turn dedupe, outbound attachment queueing on an active turn, and
the shared manual-compaction queue boundary used by turn delivery, abort, route
shutdown, and pi hooks. It is also the natural owner for ordered client-side
session-operation scheduling when a queued Telegram control, such as deferred
manual compaction, must act as a barrier between earlier active work and later
Telegram turns. Retry-aware active-turn finalization and client-side
assistant-final handoff also belong under `src/client/` rather than in broker
modules or Telegram API modules. The client may protect assistant-final handoff
until the broker durably accepts the payload, but after acceptance the broker
final ledger owns delivery, retry ordering, terminal outcomes, and visible
progress.

### pi integration: `src/pi/`

`pi/hooks.ts` composes focused pi hook registrars for commands/status,
`telegram_attach`, local-input mirroring, prompt suffixing, session lifecycle,
activity mirroring, and assistant finalization. It owns the boundary where local
pi events become Telegram activity/finals and where `telegram_attach` queues
explicit outbound artifacts. It should not own Telegram Bot API mechanics or
broker polling.

`pi/diagnostics.ts` provides the pi-safe reporting adapter for extension
background diagnostics. User-visible diagnostics should go through status,
notification, or displayed custom session-message surfaces as appropriate rather
than raw terminal writes; non-actionable transient coordination noise should stay
silent or status-only.

Current-state note: pi-side activity construction uses shared activity-line
formatters while `broker/activity.ts` owns Telegram rendering, debouncing, and
typing-loop side effects. Pi hook modules should depend on shared activity
contracts plus injected reporter interfaces, not on broker implementation modules.

### Telegram modules: `src/telegram/`

`telegram/api.ts` is the low-level Bot API and file-download boundary.
It preserves structured Telegram API errors, optional `file_path`, retry signals,
download limits, and private local file writes.

`telegram/retry.ts` centralizes retry-after sleeping behavior around Telegram
requests that can be safely retried.

`telegram/previews.ts` is a migration/compatibility boundary for legacy or
in-flight assistant preview state. The target normal path should not stream
assistant text through it, but durable final delivery may still detach preview
message state so the broker final ledger can finalize older turns with
retry-safe progress tracking.

`telegram/attachments.ts` owns outbound attachment method selection and fallback
between photo and document delivery.

`telegram/turns.ts` owns durable Telegram turn construction and deterministic
turn IDs.

### Shared modules and bounded runtime contracts: `src/shared/` plus owner modules

Shared code is a low-level support surface, not the default home for every runtime
concept. Stable cross-boundary concepts should have an explicit owner:
Telegram Bot API DTOs belong with the Telegram boundary, broker durable-state
records belong with broker/state ownership, local IPC envelopes and request/
response contracts belong with IPC ownership, client turn/final lifecycle records
belong with client lifecycle ownership, and command/control state records belong
with the broker command/control modules that interpret them.

The first split of this surface is implemented. `telegram/types.ts` owns
Telegram DTOs and Telegram message-operation state; `broker/types.ts` owns
broker durable state, routes, sessions, and command-control records;
`client/types.ts` owns turn/final payloads and client IPC result contracts;
`shared/ipc-types.ts` owns IPC envelopes; and `shared/config-types.ts` owns the
persisted bridge configuration shape.

Configuration policy is semantically grouped rather than collected in one global
bag: `shared/paths.ts` owns mutable broker path scope, `shared/file-policy.ts`
owns bridge file/attachment limits, `broker/policy.ts` owns broker/session timing
and broker control TTL/update limits, `telegram/policy.ts` owns Telegram method
limits, and `shared/prompt.ts` owns the prompt suffix. Changing one policy should
not appear to change unrelated behavior.

`shared/ipc.ts` owns local IPC transport mechanics.
`shared/activity-lines.ts`, `shared/format.ts`, `shared/messages.ts`,
`shared/routing.ts`, `shared/pairing.ts`, `shared/ui-status.ts`, and
`shared/utils.ts` own reusable low-level activity-line presentation, formatting,
message extraction, structural routing/pairing/status helpers, and small runtime
helpers.

Compatibility re-exports from broad shared files are acceptable only as migration
aids. New concepts should be added to the owning bounded surface rather than
expanding `shared/types.ts` or `shared/config.ts` by default. Shared modules must
not grow broker policy, Telegram command semantics, or imports from broker,
client, pi, or Telegram policy modules except for explicit compatibility barrels.

## Dependency direction and allowed exceptions

The intended dependency direction is:

- `index.ts` depends only on the lightweight bootstrap facade.
- The bootstrap facade may depend on pi extension types, small prompt/tool
  schema helpers, and a cheap handoff sentinel, but not on broker/client/Telegram
  runtime policy modules.
- The runtime composition root composes all heavy runtime modules after demand
  loading and may depend on each responsibility folder.
- Responsibility modules should depend on `shared/*` and on narrower peer
  interfaces passed in as dependency objects.
- Telegram API mechanics live under `telegram/*` and should not depend on pi
  hooks or broker command policy.
- Broker modules may depend on Telegram abstractions through injected functions
  or narrow imports, but should not own low-level multipart/download details.
- Pi hooks may call broker/client orchestration callbacks but should not poll
  Telegram or mutate broker lease files directly.
- Shared modules must not import broker, client, pi, or Telegram policy modules.

Allowed exceptions are narrow composition conveniences in the runtime
composition root.
Because the extension is a single-process plugin, the runtime composition root
may hold closure state and dependency injection glue that would be over-abstracted
if forced into a framework.
When that glue becomes cohesive policy, it should move into the owning folder.
Bootstrap exceptions must stay smaller: they may detect whether runtime loading
is necessary, but they should not grow broker polling, Telegram IO, route
lifecycle, or final-delivery policy.

Current-state clarification: shared activity-line presentation now lives under
`src/shared/activity-lines.ts`. `src/pi/` constructs activity lines through that
shared contract and an injected reporter interface, while `src/broker/activity.ts`
keeps ownership of Telegram rendering, debouncing, and typing-loop side effects.

## Key runtime scenarios

### Setup and pairing

The pi setup command collects the bot token and writes local config.
It then displays an attended 4-digit PIN with a 5-minute setup window.
The broker polls Telegram after deleting any webhook.
Before pairing, only a private message containing the current PIN, or a private
`/start <PIN>` deep-link fallback, can bind `allowedUserId` and `allowedChatId`.
The pairing gate rejects stale pre-setup updates, expired PINs, group messages,
bot messages, and repeated failed guesses before command or turn dispatch.
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
`SyRS-register-session-route`, `SyRS-session-replacement-route-continuity`,
`SyRS-list-and-select-sessions`, and `SyRS-topic-routes-per-session`.

### Session replacement handoff

A connected local pi session is replaced through native `/new`, `/resume`, or
`/fork`.
The old extension runtime receives a replacement shutdown reason, records a
bounded handoff instead of treating the route as finally disconnected, and tears
down only the runtime-local resources that cannot survive rebinding.
The replacement runtime receives `session_start` with the replacement reason and
consumes that handoff to reconnect or retarget Telegram reachability for the new
logical session.
If replacement does not complete, or if the user explicitly disconnects or the
process exits normally, existing route cleanup and reconnect-grace rules still
own the Telegram view.

This scenario protects `SyRS-session-replacement-route-continuity`,
`SyRS-cleanup-route-on-close`, and
`SyRS-cleanup-route-after-reconnect-grace`.

### Telegram update to pi turn

Polling fetches updates with an offset derived from durable broker state.
The broker rejects unauthorized updates, handles commands and callback-query
controls first, batches albums when needed, prepares attachments, creates a
durable turn for ordinary input, and dispatches it to the selected session's
client socket.
Delivery mode controls whether the client steers, queues follow-up work, or
starts a normal turn.
Session-control commands that need ordering, such as busy-time `/compact`,
should use a distinct queued-operation path instead of being injected as pending
turn content; repeated controls without distinct supported instructions should
coalesce or acknowledge the existing operation rather than stacking redundant
barriers.
Consumed-turn IPC removes durable pending state only after pi has accepted the
turn semantics, and queued-control-operation state should have the same explicit
accepted, consumed, cleared, or terminal lifecycle discipline.

Interactive callback controls, such as the `/model` picker, are still routed
session controls. They must preserve route context, authorize the paired user,
act on the target local session through IPC, and acknowledge or reject the
callback without turning the button press into an agent conversation message.

This scenario protects `SyRS-deliver-telegram-turn`,
`SyRS-durable-update-consumption`, `SyRS-media-group-batching`,
`SyRS-busy-message-default-followup`, `SyRS-queued-followup-steer-control`,
`SyRS-cancel-queued-followup`, `SyRS-queued-control-finalization`,
`SyRS-follow-queues-next-turn`, and `SyRS-interactive-model-picker`.

### Unsupported Telegram runtime reload

Telegram does not expose a `/reload` bridge command. The current pi extension
API exposes runtime reload only to command handlers, not to ordinary extension
contexts or LLM-callable tools, and injecting an internal slash command through
`sendUserMessage()` can surface the command as user content instead of executing
it. The bridge therefore intentionally omits Telegram-triggered runtime reload
rather than advertising a control path that requires laptop access or can leak
internal commands into the conversation.

If pi later exposes a safe direct reload API for extension contexts, Telegram
reload can be reconsidered as a new feature with durable route reattachment.
Until then, runtime reload remains a local pi action outside the Telegram bridge.

### Activity and final response

Pi event hooks collect thinking and tool activity and report it to the broker.
The broker renders activity through debounced Telegram edits without erasing the
ordered activity model. Typing indicators are advisory rendering side effects;
they must not block activity ingestion, final handoff, or assistant-final
delivery.
Assistant response text is not a live Telegram streaming surface in the target
architecture. Activity rendering remains the live supervision channel while the
assistant is working; assistant text is delivered once through final delivery
when pi reports the completed turn. This avoids provisional assistant-message
notifications and preview replacement churn while preserving enough live
progress visibility to decide whether to intervene.
On final response, the broker first persists an assistant-final ledger entry,
closes outstanding activity, detaches or cleans up any existing preview state
left by older runtimes or in-flight migration, and then appends final assistant
text as new Telegram messages. Long text is chunked, attachments are sent only
from explicit pi queues, progress is persisted after visible delivery steps, and
retryable failures keep final delivery pending without allowing newer finals to
bypass the older one.

Migration note: current code still contains `PreviewManager` and an
`assistant_preview` IPC handler for legacy or in-flight preview compatibility.
Those paths should remain only for cleanup, compatibility, or explicit future
opt-in behavior; they are not the normal assistant-text delivery path.

This scenario protects `SyRS-activity-history-rendering`,
`SyRS-final-preview-deduplication`, `SyRS-final-delivery-fifo-retry`,
`SyRS-telegram-text-method-contracts`, and `SyRS-explicit-artifact-return`.

### File ingress and egress

Inbound Telegram file metadata is treated as untrusted.
The Telegram API layer enforces hosted Bot API download caps through message
metadata, `getFile`, HTTP headers, and streaming byte counts; missing
`file_path` fails clearly; downloaded files are written privately into
session-scoped temp directories.
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
Every activity update, preview, final, upload, typing action, command reply, and
interactive callback control must preserve the intended route context.
Losing route identity is equivalent to losing session control.

### Logical session identity versus runtime instance identity

A pi session's Telegram route identity must be tied to the logical pi session
for the duration of a connection and its bounded automatic reconnect grace, not
merely to the current extension runtime instance.
Ordinary extension/runtime churn tears down in-memory closures, IPC sockets, and
broker/client process state, but it should not by itself create a duplicate
Telegram route while the reconnect window is still active.
After explicit disconnect, terminal shutdown, or reconnect-grace expiry, the old
Telegram route is no longer the session's identity; a later native `/resume` plus
Telegram connect may create a new route/topic over the resumed local history.
For user-initiated session replacement, the route may instead be carried forward
through a bounded handoff to the replacement runtime so `/new`, `/resume`, or
`/fork` continues supervision rather than ending it.

Runtime instance identifiers are appropriate for ephemeral concerns such as IPC
socket filenames, owner IDs, leases, and heartbeat liveness.
Logical session identifiers are appropriate for broker registration, bounded
route reuse, replacement handoff, and selector choices.
Current implementation keeps those identities separate so offline-and-reconnect
can reuse route state. Session replacement handoff is a planned extension of the
same boundary: replacement should continue Telegram reachability only when the
replacement runtime starts successfully, while terminal close/death still cleans
up after the appropriate lifecycle boundary. Telegram-triggered runtime reload
and reload reattachment are intentionally unsupported until pi exposes a safe
direct reload API for extension contexts.

### Durable versus ephemeral state

Lease files, broker state, pending turns, queued-turn controls, pending media
groups, cleanup intents, and reconnect-grace metadata are durable coordination
state that survives ordinary runtime churn.
Routes are durable only as active or reconnectable Telegram views; they should be
removed when the connection lifecycle ends and any required topic cleanup has
reached a retry-safe outcome.
Downloaded Telegram attachment temp directories are similarly session-scoped:
they persist only while a live/reconnectable session or pending Telegram
delivery state still depends on them, then become sweepable local artifacts.
Selector-mode session choices are persisted in broker state. Assistant finals
become broker-owned durable delivery state when the broker accepts them into the
assistant-final ledger. Client-side final persistence, where it exists, should be
limited to the pre-acceptance handoff ambiguity window and must not become a
parallel durable delivery system.
Typing loops, in-flight preview timers, current socket attempts, and local
activity flushes are ephemeral.
Future code must not delete durable or target-durable delivery state merely to
clean up ephemeral work, but route cleanup is allowed to end the Telegram view
because native session history is local rather than stored in Telegram.

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
it must not become the only source of activity truth. Typing indicators remain
advisory and must not sit in the critical path for recording activity events,
acknowledging activity IPC, or allowing assistant final delivery to progress.

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

### Lazy startup seam

Current implementation eagerly imports the full runtime graph from `index.ts` via
`src/extension.ts`, which makes ordinary pi startup pay the TypeScript/Jiti cost
of broker, client, Telegram, IPC, and delivery modules even when Telegram is not
connected. Planned lazy-loading work should introduce a bootstrap/runtime seam:
bootstrap keeps the pi-visible surface available, while the heavy runtime is
demand-loaded for explicit Telegram use or valid session-replacement recovery.

The seam is a migration architecture concern, not a change to product authority:
it must preserve mid-turn connect, replacement handoff, attachment safety,
shutdown cleanup, and no-external-daemon operation. The main design risk is
allowing runtime to load too late for active-turn finalization or registering pi
surfaces twice after dynamic import.

### Composition root size

`src/extension.ts` remains the largest file, but it is now below the 1,000-line
guard rail after the client runtime host and turn-lifecycle extractions. It is
still a transitional runtime composition root; future work should keep shrinking
it by extracting cohesive broker lease/state/session lifecycle and client
final-handoff composition where those seams become clear.
Extraction should preserve dependency injection and ownership boundaries rather
than merely moving a god file to another name.

Recent maintainability slices extracted the client runtime host and explicit
client turn lifecycle under `src/client/`. Later slices may extract broker
runtime hosting, broker IPC routing, state-store concerns, and narrower
client-final-handoff composition while leaving broker polling/election, Telegram
command semantics, route cleanup, and broker-owned final delivery behavior
unchanged.

### Shared boundary split

`src/shared/types.ts` and `src/shared/config.ts` are explicit migration seams
rather than target architecture. `shared/types.ts` now acts as a narrow
transitional type barrel over owner modules, and `shared/config.ts` owns persisted
config read/write plus a limited `CONFIG_PATH` compatibility export. Runtime code
should import owner modules directly. The migration preserves JSON shapes,
constant values, lazy-startup import behavior, and existing validation coverage;
any retained compatibility surface should shrink over time and should not be
used as the default place for new runtime concepts.

### Behavior-check harness pressure

The repository's reliable local validation command is `npm run check`, which
must type-check the extension and execute the behavior-check suite. Those checks
now cover many important broker, client, Telegram, final-delivery, route
lifecycle, pi-hook, setup, and attachment behaviors, but the harness remains a
migration pressure point.

Future validation-suite work should preserve existing behavioral coverage while
making check discovery, typed fixtures, and behavior-domain organization more
explicit. The validation harness should support maintainability and future
runtime refactors; it should not become a parallel runtime architecture or a
reason to change broker/client/Telegram behavior in validation-only slices.

### Runtime state in closures

The composition root currently holds substantial mutable runtime state in
closures.
That is workable for a single extension process but makes some flows harder to
review.
Future extraction may introduce narrower state containers for broker runtime,
client runtime, preview/final delivery, and pi-hook lifecycle.

### Assistant-final durability and pi auto-retry

`SyRS-final-delivery-fifo-retry` requires final responses to remain retryable
until Telegram delivery succeeds or a terminal non-retryable outcome is recorded.
The broker now persists assistant-final payloads in
`BrokerState.pendingAssistantFinals` before visible Telegram final delivery. The
client-side retry queue and any client-side pending-final files should protect
only the handoff until durable broker acceptance; after that, the broker delivery
ledger owns FIFO ordering, `retry_after` delay, terminal outcome classification,
and resumable chunk and attachment progress.

`SyRS-retry-aware-agent-finals` adds a client-side pressure point before broker
acceptance: pi can emit an `agent_end` for a retryable transient provider error
before the session auto-retry layer produces the final answer the local user
sees. Finalization logic must not convert that intermediate event into a
completed Telegram final. This concern belongs in cohesive client finalization
and final-handoff modules rather than in scattered composition-root callbacks.

The intended final-handoff boundary is narrow: client code may retry or persist a
final only while broker acceptance is ambiguous. Duplicate or redelivered handoff
attempts for the same turn must converge on one broker ledger entry. Stale-client
stand-down must either prevent broker-visible final mutation or use one explicit,
tested pre-acceptance handoff exception. Client code must not reimplement broker
chunk progress, attachment progress, terminal Telegram failure classification, or
FIFO delivery ordering.

The ledger reduces duplicate visible output by skipping chunks and attachments
already recorded as delivered. It cannot provide mathematical exactly-once
semantics for the small crash window after Telegram accepts a send but before the
broker persists that success; future work should preserve the current
"persist-after-each-visible-step" discipline if it changes delivery mechanics.

### Selector-mode selection durability

`SyRS-selector-selection-durability` requires `/use` selections in selector mode
to survive broker turnover until they expire, change, or become invalid.
The current code stores those choices in `BrokerState.selectorSelections` and
refreshes the selected chat/session's selector route, so unrouted Telegram
messages and control commands keep their intended session after broker takeover
within the selection window.

### Pi activity presentation boundary

Pi-side activity mirroring constructs activity lines through
`src/shared/activity-lines.ts` and sends them through an injected activity
reporter interface. `src/broker/activity.ts` remains the owner of Telegram
activity rendering, debouncing, activity completion, and typing-loop side
effects. Future activity changes should keep this boundary: shared code may own
small presentation contracts, but pi modules should not depend on broker
implementation internals.

### Planning maturity

Purpose, StRS, SyRS, architecture, and traced implementation tasks now exist for
major bridge behavior and for the first Telegram reliability maintainability
slice. Verification cases remain mostly planned through task validation and local
check scripts rather than through a complete formal verification registry.
Requirements remain the behavior baseline; tasks are execution records for
specific implementation slices, not replacements for requirement or architecture
ownership.

## Repository mapping

- `index.ts` — package entrypoint; should only register the extension through
  the lightweight bootstrap facade.
- `src/bootstrap.ts` or equivalent — planned eager registration facade for pi
  commands, tool definitions, prompt guidance, lifecycle sentinels, and lazy-load
  policy.
- `src/extension.ts` / future `src/runtime/extension-runtime.ts` — runtime
  composition root, broker/client orchestration, state wiring, config setup,
  lease coordination, and cross-boundary callbacks after demand loading.
- `src/broker/activity.ts` — broker-side Telegram activity rendering and debouncing.
- `src/broker/commands.ts` — thin Telegram command/callback dispatcher and route-aware control composition.
- `src/broker/model-command.ts`, `src/broker/git-command.ts`, `src/broker/queued-turn-control-handler.ts`, and `src/broker/inline-controls.ts` — focused command/control semantics and shared inline-control lifecycle helpers.
- `src/broker/sessions.ts` — broker-side offline/unregister cleanup.
- `src/broker/updates.ts` — Telegram polling, authorization gate, update offset,
  media groups, offline marking, and pending-turn retry.
- `src/client/turn-lifecycle.ts` — named owner for active/queued/deferred
  Telegram turn state, awaiting-final gating, current abort callbacks,
  completed/disconnected turn dedupe, active-turn attachment queueing, and
  start-next-turn coordination.
- `src/client/final-delivery.ts` — current client-side assistant-final handoff
  retry queue; target ownership is pre-broker-acceptance handoff only, not
  durable Telegram final delivery.
- `src/client/retry-aware-finalization.ts` — client-side deferral of transient
  retryable assistant/provider final errors until a stable final or terminal
  outcome is known.
- `src/client/info.ts` — session/model status text and model command helpers.
- `src/client/session-registration.ts` — collection of local session metadata.
- `src/pi/hooks.ts` and focused `src/pi/` hook modules — pi commands, pi events,
  prompt suffix, local-input mirroring, assistant finalization triggers, and
  `telegram_attach` tool integration.
- `src/shared/config.ts` — persisted Telegram bridge config read/write and a
  limited `CONFIG_PATH` compatibility export; unrelated policy constants should
  not be added here by default.
- `src/shared/paths.ts` — mutable broker path scope and local path constants.
- `src/shared/file-policy.ts` — bridge file/attachment limits shared across
  Telegram upload/download and local IPC surfaces.
- `src/shared/prompt.ts` — Telegram bridge prompt suffix text.
- `src/shared/config-types.ts` — persisted Telegram bridge config shape.
- `src/shared/types.ts` — transitional compatibility barrel for the former broad
  cross-module runtime data model; stable concepts should be imported from
  Telegram, broker, client, or IPC owner modules.
- `src/shared/ipc.ts` and `src/shared/ipc-types.ts` — local IPC transport helpers
  plus envelope/response types.
- `src/shared/activity-lines.ts`, `src/shared/format.ts`,
  `src/shared/messages.ts`, `src/shared/routing.ts`, `src/shared/pairing.ts`,
  `src/shared/ui-status.ts`, and `src/shared/utils.ts` — activity-line
  presentation, formatting, event extraction, structural routing/pairing/status
  helpers, user text, and small helpers.
- `src/broker/policy.ts` — broker/session timing, model/control TTL, and update
  retention constants.
- `src/broker/types.ts` — broker durable state, route/session records, outbox,
  final-delivery progress, and command/control records.
- `src/client/types.ts` — Telegram turn/final payloads plus client-side IPC
  request/result contracts.
- `src/telegram/policy.ts` — Telegram method-contract limits and Telegram
  cleanup timing policy.
- `src/telegram/types.ts` — Telegram Bot API DTOs and Telegram message-operation
  state.
- `src/telegram/api.ts` — low-level Telegram Bot API calls and downloads.
- `src/telegram/retry.ts` — retry-after wrapper.
- `src/telegram/previews.ts` — legacy/in-flight preview state cleanup and finalization compatibility.
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
