# Telegram Bot API notes for `pi-telegram`

Last reviewed: 2026-04-27 against the official Telegram Bot API docs.

This maintained documentation page captures the Bot API details that matter for this bridge so future
changes do not require rereading the whole Telegram documentation. It replaces the old top-level
Bot API scratch note; update this page when Telegram API policy changes.

Official sources used throughout:

- Official Bot API: <https://core.telegram.org/bots/api>
- Making requests: <https://core.telegram.org/bots/api#making-requests>
- Local Bot API server: <https://core.telegram.org/bots/api#using-a-local-bot-api-server>
- Getting updates: <https://core.telegram.org/bots/api#getting-updates>
- `getUpdates`: <https://core.telegram.org/bots/api#getupdates>
- `deleteWebhook`: <https://core.telegram.org/bots/api#deletewebhook>
- `ResponseParameters`: <https://core.telegram.org/bots/api#responseparameters>
- `Chat` / `Message`: <https://core.telegram.org/bots/api#chat>, <https://core.telegram.org/bots/api#message>
- `InputFile`: <https://core.telegram.org/bots/api#inputfile>
- `File` / `getFile`: <https://core.telegram.org/bots/api#file>, <https://core.telegram.org/bots/api#getfile>
- `sendMessage`: <https://core.telegram.org/bots/api#sendmessage>
- `sendMessageDraft`: <https://core.telegram.org/bots/api#sendmessagedraft>
- `sendChatAction`: <https://core.telegram.org/bots/api#sendchataction>
- `editMessageText`: <https://core.telegram.org/bots/api#editmessagetext>
- `InlineKeyboardMarkup` / `InlineKeyboardButton`: <https://core.telegram.org/bots/api#inlinekeyboardmarkup>, <https://core.telegram.org/bots/api#inlinekeyboardbutton>
- `CallbackQuery` / `answerCallbackQuery`: <https://core.telegram.org/bots/api#callbackquery>, <https://core.telegram.org/bots/api#answercallbackquery>
- `sendPhoto`: <https://core.telegram.org/bots/api#sendphoto>
- `sendDocument`: <https://core.telegram.org/bots/api#senddocument>
- `ForumTopic`: <https://core.telegram.org/bots/api#forumtopic>
- `createForumTopic`: <https://core.telegram.org/bots/api#createforumtopic>
- `deleteForumTopic`: <https://core.telegram.org/bots/api#deleteforumtopic>

Prefer the official Telegram links above when updating this file. Inline source
links are repeated near the sections they support so future agents can verify a
specific claim quickly.

## Request and response contract

Sources: [Making requests](https://core.telegram.org/bots/api#making-requests),
[ResponseParameters](https://core.telegram.org/bots/api#responseparameters).

- Use HTTPS endpoint shape:
  `https://api.telegram.org/bot<token>/<METHOD_NAME>`.
- Telegram accepts GET and POST, but this bridge should use POST for normal
  JSON calls and `multipart/form-data` for uploads.
- JSON request bodies are valid for non-upload methods.
- Uploads must use multipart form data.
- API responses have:
  - `ok: true` plus `result` on success.
  - `ok: false`, `description`, and `error_code` on failure.
  - Optional `parameters` for machine-actionable failures.
- Do not parse correctness from human-readable descriptions unless there is no
  structured alternative. Descriptions can change.
- Store Telegram integer IDs in JS `number` only where safe. Telegram notes many
  IDs may exceed 32 bits but fit within 52 significant bits, so JavaScript
  numbers are acceptable for Bot API chat/user/file sizes currently described
  that way.

## Flood control and retry behavior

Source: [ResponseParameters](https://core.telegram.org/bots/api#responseparameters).

`ResponseParameters.retry_after` is the authoritative signal for flood control.
When present:

- Wait at least that many seconds before repeating the request.
- Do not immediately fall back to a different method if the original failure was
  rate limiting.
- Do not reprocess the same update every few seconds while Telegram asked us to
  wait.
- Preserve FIFO ordering for queued assistant finals during retry windows.
- Do not retry a multi-step final from the beginning after a partial success if
  the retry would duplicate already-sent text or attachments.

Implementation implications:

- JSON Bot API calls, multipart uploads, and file downloads should all preserve
  retry information.
- Non-OK file download HTTP responses may also include retry information in the
  response body or `Retry-After` header; convert those into retry-aware errors.
- Polling, media group preparation, final delivery, and preview edits should all
  honor retry windows.

## Polling with `getUpdates`

Sources: [Getting updates](https://core.telegram.org/bots/api#getting-updates),
[`getUpdates`](https://core.telegram.org/bots/api#getupdates).

Telegram offers two mutually exclusive delivery modes: long polling with
`getUpdates`, or webhooks.

Rules for this bridge:

- Call `deleteWebhook` before long polling.
- Do not proceed with `getUpdates` while webhook removal is failing; retry
  webhook removal first.
- Use positive long-poll timeout for normal operation.
- Recalculate `offset` after every successful server response.
- Confirm updates by next polling with `offset = highest_processed_update_id + 1`.
- Persist `lastProcessedUpdateId` only after the update is durably handled or
  durably queued.
- Deduplicate recent `update_id`s to tolerate retries or broker restarts.
- Negative offset is dangerous: it retrieves from the end of the queue and
  forgets older updates. Use it only for first-time initialization where dropping
  old backlog is intentional, and persist a non-undefined checkpoint afterward
  even if Telegram returned no updates.
- `allowed_updates` changes do not affect updates already queued on Telegram, so
  code must tolerate unwanted update types briefly.

Current project policy:

- Request message-like updates plus `callback_query` because inline-keyboard command controls, such as the model picker, arrive as callback queries rather than messages.
- We drop old backlog during non-pairing initialization, but not repeatedly.
- Pairing mode should not skip updates because the first valid PIN message, or
  `/start <PIN>` fallback, must be delivered.

## Webhooks

Sources: [`getUpdates`](https://core.telegram.org/bots/api#getupdates),
[`deleteWebhook`](https://core.telegram.org/bots/api#deletewebhook).

We do not run a webhook server in this bridge.

Relevant constraints:

- `getUpdates` will fail while an outgoing webhook is configured.
- `deleteWebhook` removes webhook integration.
- `drop_pending_updates` controls whether pending webhook/getUpdates backlog is
  discarded.

Bridge policy:

- Use `deleteWebhook({ drop_pending_updates: false })` before polling so we do
  not discard legitimate user messages.
- If webhook deletion fails transiently, keep retrying instead of entering a
  `getUpdates` conflict loop.

## Text messages and previews

Sources: [`sendMessage`](https://core.telegram.org/bots/api#sendmessage),
[`sendMessageDraft`](https://core.telegram.org/bots/api#sendmessagedraft),
[`editMessageText`](https://core.telegram.org/bots/api#editmessagetext).

### `sendMessage`

Important constraints:

- `chat_id` may be an integer or a username string depending on target.
- `message_thread_id` is valid for forum supergroups and private chats when the
  bot has forum topic mode enabled.
- Message text has a 1-4096 character limit after entity parsing.

Bridge policy:

- Split long final replies below the 4096-character limit.
- Use plain text fallback only for formatting/entity failures, not for
  `retry_after` failures.
- Avoid sending empty strings; use a placeholder only when a message must exist.
- Use `disable_notification` only for passive visibility updates that should not alert the operator, currently broker activity-renderer status messages and mirrored local pi-user input. Do not make assistant previews, final replies, setup/command replies, explicit errors, or attachment failure notices silent by default.

### `sendMessageDraft`

Relevant Bot API facts:

- Available to all bots since Bot API 9.5.
- Intended for streaming a partial generated message.
- `chat_id` is an integer target private chat.
- `draft_id` is required and must be non-zero.
- Text must be 1-4096 characters after entity parsing.
- `message_thread_id` is optional.

Bridge policy:

- Only call `sendMessageDraft` for integer private-chat targets.
- Do not use it for forum supergroups or username string targets.
- Do not send an empty draft as a cleanup operation; empty text violates the
  method contract.
- Do not globally disable draft streaming because of request-specific failures
  such as bad chat/thread IDs.
- Only treat a real method-not-found/endpoint-not-found response as evidence
  that draft streaming is unavailable on the current Bot API endpoint.
- If draft streaming cannot be used, fall back to visible preview messages plus
  `editMessageText`.

### `editMessageText`

Important constraints:

- New text is 1-4096 characters after entity parsing.
- Telegram can return “message is not modified” when content is unchanged.
- Telegram currently only allows editing messages without reply markup or with
  inline keyboards.

Bridge policy:

- Treat “message is not modified” as success.
- Compare the exact truncated preview text before editing so long streaming
  previews do not repeatedly send no-op edits after 4096 characters.
- Preserve `retry_after`; do not treat rate limiting as a formatting failure.

### Inline keyboards and callback queries

Sources: [`InlineKeyboardMarkup`](https://core.telegram.org/bots/api#inlinekeyboardmarkup),
[`InlineKeyboardButton`](https://core.telegram.org/bots/api#inlinekeyboardbutton),
[`CallbackQuery`](https://core.telegram.org/bots/api#callbackquery),
[`answerCallbackQuery`](https://core.telegram.org/bots/api#answercallbackquery),
[`editMessageText`](https://core.telegram.org/bots/api#editmessagetext).

Relevant Bot API facts:

- `sendMessage` and `editMessageText` can carry `reply_markup` with an inline
  keyboard.
- `callback_data` on an inline keyboard button is limited to 1-64 bytes.
- Button presses arrive as `callback_query` updates and contain the pressing
  user, optional originating message, and optional data.
- Telegram clients show progress after a callback button is pressed until the
  bot calls `answerCallbackQuery`; even an empty acknowledgement is useful.

Bridge policy:

- Keep callback data compact. Store long or sensitive selection state in broker
  state behind a short token instead of putting full provider/model lists in
  Telegram callback data.
- Authorize callback queries by paired user and allowed chat before treating a
  button press as a session control.
- Preserve route and topic context when editing callback-originated messages or
  sending fallback replies.
- For controls that mutate local session state, such as `/model`, act through
  the target session IPC and preserve exact local identifiers like
  `provider/model-id`; do not let Telegram display text become the authority.
- Call `answerCallbackQuery` for handled, expired, malformed, or rejected picker
  callbacks, but still propagate `retry_after` so polling offsets are not
  advanced through a rate-limit window.

## Typing/activity indicators

Source: [`sendChatAction`](https://core.telegram.org/bots/api#sendchataction).

`sendChatAction` is for short-lived user-visible status.

Relevant constraints:

- The status lasts up to 5 seconds and is cleared when a bot message arrives.
- Telegram recommends using it only when a response will take noticeable time.
- Supported action values include `typing`, `upload_photo`, and
  `upload_document`.
- `message_thread_id` applies in forum/private-topic modes.

Bridge policy:

- Use a cadence shorter than 5 seconds for active long-running turns.
- Stop typing loops when a turn completes, aborts, errors, or when a session is
  marked offline.
- Include `message_thread_id` whenever replying inside a topic.

## Files and downloads

Sources: [`File`](https://core.telegram.org/bots/api#file),
[`getFile`](https://core.telegram.org/bots/api#getfile),
[local Bot API server](https://core.telegram.org/bots/api#using-a-local-bot-api-server).

### Hosted Bot API limits

With the default hosted Bot API server:

- `getFile` prepares files for download.
- Download URLs are formed from returned `file_path`.
- Download links are valid for at least 1 hour.
- Bots can download files up to 20 MB.
- `file_path` is optional; a successful `getFile` response may not include a
  usable download path.
- Telegram may not preserve the original filename or MIME type in `getFile`, so
  save filename/MIME metadata from the original message when available.

Bridge policy:

- Enforce a 20 MB download cap before and during download.
- Check incoming `file_size`, returned `File.file_size`, HTTP `Content-Length`,
  and streaming byte count.
- Fail clearly if `file_path` is absent.
- Download immediately after `getFile` or call `getFile` again if a link expired.
- Save Telegram-provided filenames/MIME types from the message object when
  available, not from `getFile`.
- Store downloaded files in private local session directories/files (`0700`
  dirs, `0600` files) because Telegram attachments may contain private data.
- Keep downloaded files while the runtime still needs their session-scoped temp
  directory for active, reconnectable, or pending Telegram work.
- Do not delete session temp directories merely because the broker shuts down,
  loses the lease, or is taken over. Cleanup belongs to authoritative session end
  or conservative orphan sweeping after protected state checks.

### Local Bot API server

Telegram supports running a local Bot API server. If we ever add support for it:

- Downloads can avoid the hosted 20 MB cap.
- Uploads can go up to 2000 MB.
- The returned `file_path` may be an absolute local path.
- The API base URL must become configurable; do not hard-code
  `https://api.telegram.org` everywhere if implementing this.

## File uploads and outbound attachments

Sources: [`InputFile`](https://core.telegram.org/bots/api#inputfile),
[`sendPhoto`](https://core.telegram.org/bots/api#sendphoto),
[`sendDocument`](https://core.telegram.org/bots/api#senddocument).

### General upload rules

- Multipart form data is required for uploaded files.
- `InputFile` represents file contents sent by multipart upload.
- The hosted Bot API has much smaller limits than a local Bot API server.

Bridge policy:

- Cap outbound uploads conservatively unless/until local Bot API support is
  implemented.
- Resolve outbound attachment paths against the pi session cwd unless absolute.
- Canonicalize candidate paths with `realpath` before allowlist and secret-path
  decisions. This blocks symlink escapes and means tests should compare
  canonical paths on platforms such as macOS where `/var` may resolve under
  `/private/var`.
- Restrict attachment paths to the workspace or the bridge temp directory.
- Block obvious secrets such as `.env`, `.env.*`, SSH key basenames,
  SSH/AWS/Azure/Kubernetes credential directories, Google Cloud config under
  `.config/gcloud`, and application-default credential files.

### Photos: `sendPhoto`

Important constraints for uploaded photos:

- Uploaded photo size must be at most 10 MB.
- Width + height must not exceed 10000.
- Width/height ratio must be at most 20.
- `message_thread_id` is valid for forum supergroups and private chats with bot
  topic mode enabled.

Bridge policy:

- Only try `sendPhoto` for likely images within the 10 MB size cap.
- If Telegram rejects an image for photo-specific constraints, fall back to
  `sendDocument`.
- Do not fall back from `sendPhoto` to `sendDocument` on `retry_after`; wait and
  retry instead.

### Documents: `sendDocument`

Use `sendDocument` for:

- Non-image files.
- Images that are too large or invalid for `sendPhoto`.
- Images that Telegram rejects due to photo-specific constraints.

## Media groups / albums

Sources: [`Message`](https://core.telegram.org/bots/api#message),
[`getUpdates`](https://core.telegram.org/bots/api#getupdates),
[`ResponseParameters`](https://core.telegram.org/bots/api#responseparameters).

Telegram albums arrive as multiple updates sharing a `media_group_id`.

Bridge policy:

- Debounce album preparation briefly so all group updates can arrive.
- Snapshot the group being processed.
- If new album updates arrive while processing, remove only processed update IDs
  and reschedule the rest.
- If preparation hits `retry_after`, keep the pending group and reschedule after
  Telegram’s requested delay.
- Only drop the group after successful preparation or a non-retryable failure.

## Topics and routing

Sources: [`Chat`](https://core.telegram.org/bots/api#chat),
[`ForumTopic`](https://core.telegram.org/bots/api#forumtopic),
[`createForumTopic`](https://core.telegram.org/bots/api#createforumtopic),
[`deleteForumTopic`](https://core.telegram.org/bots/api#deleteforumtopic).

### `message_thread_id`

Telegram supports `message_thread_id` on many send methods for:

- Forum supergroups.
- Private chats when the bot has forum topic mode enabled.

Bridge policy:

- Preserve `message_thread_id` on replies, previews, uploads, typing actions,
  and topic-routed messages.
- Do not send topic IDs to methods/targets where they are not valid.

### `createForumTopic`

Important constraints:

- Can create topics in forum supergroups and in private chats with a user.
- In supergroups, the bot must be an administrator and have topic-management
  rights.
- Topic names must be 1-128 characters.

Bridge policy:

- `/topicsetup` should only accept forum supergroups (`chat.type ===
  "supergroup"` and `chat.is_forum === true`).
- Private-chat topic routing is allowed only when the bot/user supports forum
  topic mode.
- Route creation must be locked per session so concurrent registration does not
  create duplicate topics.
- If topic setup fails, restore the previous routing config/state.

### `deleteForumTopic`

Important constraints:

- Deletes the topic and its messages.
- Works for forum supergroups and private chats with a user.
- In supergroups, the bot needs appropriate admin/delete rights.

Bridge policy:

- Delete topics/routes when a connected pi session explicitly disconnects,
  reaches terminal shutdown that is not continued by a successful replacement
  handoff, or remains unreachable after the bounded automatic reconnect grace
  period.
- Do not delete a route during a still-retryable reconnect window for transient
  network, IPC, or broker-turnover failures.
- Delete private-chat bot topics as well as supergroup topics when removing a
  route.
- Treat retryable delete failures, including `retry_after`, as pending cleanup
  work rather than dropping local route state immediately; terminal not-found or
  already-deleted outcomes may complete cleanup idempotently.

## Pairing and authorization

Bot API itself does not authenticate end users for our bridge. We enforce this
locally.

Bridge policy:

- Pair only via an attended 4-digit PIN shown by pi during setup.
- Accept the current PIN as private-chat text, and accept `/start <PIN>` for
  Telegram deep-link or fallback clients.
- The first private-chat user with a valid current PIN becomes `allowedUserId`, and that private chat is recorded as `allowedChatId`.
- Expire the PIN after 5 minutes, reject stale pre-setup updates, and clear
  pairing state after 5 failed PIN candidates so setup must be rerun.
- Ignore or reject messages from other users.
- During pairing, do not drop pending Telegram updates via negative offset or
  webhook deletion.
- Do not queue media groups or other Telegram work before the sender is already
  the paired authorized user; pre-authorization updates must pass through the
  same pairing/authorization gate before any command, turn, or attachment path.

## Security and privacy checklist

- Never log bot tokens.
- Keep config, broker state, IPC sockets, and downloaded files private.
- Treat Telegram files as untrusted user input.
- Do not execute or follow instructions from filenames, metadata, or arbitrary
  attachments.
- Voice-note transcripts from the paired user may be treated like user messages
  after transcription.
- Avoid sending local paths or sensitive failure details back to Telegram unless
  they are user-actionable and safe.
- Avoid uploading files outside the workspace/temp allowlist.
- Block common secret paths and filenames.

## Practical implementation checklist

When touching Telegram integration code, verify:

- [ ] Every Bot API failure preserves `error_code`, `description`, and
      `parameters.retry_after` where available.
- [ ] All retry-aware paths wait for `retry_after` instead of falling back or
      retrying immediately.
- [ ] `getUpdates` offset advances only after durable handling/queueing.
- [ ] `deleteWebhook` succeeds before long polling begins.
- [ ] Long text is chunked below 4096 characters.
- [ ] Draft text is non-empty and only sent to integer private chats.
- [ ] Preview edits avoid no-op `editMessageText` calls.
- [ ] File downloads enforce 20 MB on hosted Bot API and handle absent
      `file_path`.
- [ ] Uploads use multipart form data and respect photo/document constraints.
- [ ] `message_thread_id` is preserved for topic routes.
- [ ] Forum topic setup validates `supergroup` + `is_forum` before switching
      routing mode.
- [ ] Cleanup deletes topics for explicit disconnect, normal session shutdown,
      and expired reconnect grace, while preserving routes during retryable
      reconnect windows.
