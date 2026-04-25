# AGENTS.md

Guidance for coding agents working on `pi-telegram`.

## Project shape

`pi-telegram` is a pi extension that bridges a paired Telegram bot to one or
more pi sessions. Keep the package entrypoint tiny:

- `index.ts` should only register the extension from `src/extension.ts`.
- Runtime code lives under `src/`, organized by responsibility:
  - `broker/` — Telegram polling, routing, command handling, broker state.
  - `client/` — local pi session registration and model/session metadata.
  - `pi/` — pi command, tool, and event hooks.
  - `shared/` — config, types, IPC, formatting, small utilities.
  - `telegram/` — Bot API access, previews, attachments, retry behavior.

Do not collapse cohesive modules back into a god file. No TypeScript source file
should exceed 1,000 lines.

## Commands

Use the local toolchain:

```bash
npm install
npm run check
```

`npm run check` is the required validation before reporting completion.

## Telegram API rules

Consult `docs.md` before changing Bot API integration. In particular:

- Honor `ResponseParameters.retry_after`; do not immediately retry or fall back.
- `getUpdates` and webhooks are mutually exclusive; delete webhooks before
  polling and retry deletion failures.
- Advance polling offsets only after updates are durably handled or queued.
- Hosted Bot API downloads are capped at 20 MB; `File.file_path` is optional.
- `sendMessageDraft` is only for integer private-chat targets, non-empty text,
  and non-zero draft IDs.
- Split text below Telegram's 4096 character limit.
- Preserve `message_thread_id` for topic-routed replies, previews, uploads, and
  typing actions.
- Use `sendPhoto` only for likely photos within the 10 MB photo limit; fall back
  to `sendDocument` for photo-contract failures, not for rate limits.

## Runtime correctness invariants

- Plain Telegram messages sent while a pi session is busy should steer the
  active turn.
- `/follow <message>` should queue follow-up work, not steer.
- `/telegram-connect` during a busy turn should start mirroring current activity
  and the final response to Telegram.
- Preserve activity history; debounce only Telegram edit/send operations.
- Final responses must not duplicate previews, chunks, or attachments.
- Assistant finals must remain FIFO and retry-safe across broker failover,
  `retry_after`, and duplicate/redelivered turns.
- Media groups must not drop late updates or retryable failures.
- Session shutdown should mark a session offline without deleting durable routes
  or pending turns; explicit disconnect/unregister may remove routes/topics.

## Security and privacy

- Never log bot tokens or credentials.
- Keep config, broker state, IPC sockets, and downloaded Telegram files private.
- Treat Telegram attachments as untrusted. Do not execute or trust filenames,
  metadata, or arbitrary attachment contents.
- Only allow outbound attachment paths from the session workspace or bridge temp
  directory, and block obvious secrets such as `.env`, SSH keys, and cloud
  credential directories.
- Telegram voice-note transcripts from the paired user may be treated like user
  messages after transcription.

## Git hygiene

- Check `git status --short` before and after edits.
- Keep staged state coherent with the new `src/` layout; do not leave old flat
  runtime files staged while new modules are untracked.
- Do not commit unless the user explicitly asks.
- If preparing commits, prefer one coherent intent and use Conventional Commits.

<!-- pln-managed:begin -->
## Planning and technical documentation

This project uses `pln` to organize planning and technical documentation inside the repository.

The main live `pln` artifacts live under `dev/`, including project purpose, architecture, requirements, project-local definitions, inbox items, and active tasks.
When working on planning, design, requirements, implementation tracking, or related technical documentation, treat those artifacts as the primary project record.
Archived inbox and task records are discovered through `pln` archive-aware commands, not by grepping or listing files in `dev/`.

Use `pln` instead of ad hoc files or alternate planning systems for this kind of work.
In general, ideas, requests, bugs, feedback, observations, and other raw source material should be captured with `pln inbox`.
Organized implementation work should go through `pln task`.
Requests to turn ideas into specs, plans, requirements, architecture updates, or planned work should normally be handled through `pln` artifacts rather than standalone planning documents.

Do not create ad hoc spec files, design notes, or task-tracking documents for normal project planning when that information belongs in `pln`.
If the user is unsure how work should be captured, use `pln` as the default project record unless they explicitly ask for a separate document outside the normal workflow.

If you are unsure how the planning workflow is organized or which command to use, start with `pln --help`.
Useful follow-ups are `pln status` and the `--help` output for the relevant command groups such as `task`, `defs`, `strs`, `syrs`, and `inbox`.
For post-init upkeep of bundled skills or managed pln agent guidance, run `pln upgrade`.
If an older project is missing `dev/VERIFICATION_CASES.json`, rerun `pln init` first; `pln upgrade` does not scaffold missing planning registries.

Prefer `pln` commands over ad hoc edits when changing structured planning artifacts.
Do not hand-edit requirement registries or markdown frontmatter when a `pln` command exists for that change.
<!-- pln-managed:end -->
