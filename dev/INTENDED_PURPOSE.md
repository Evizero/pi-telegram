---
version: 0.2
status: draft
last_updated: 2026-04-25
---

# Intended Purpose

## Motivation

Agent sessions are easy to start at a computer and hard to supervise once the operator leaves that computer.
A pi session may be running tests, editing files, waiting for review, or streaming a long answer while the user walks away with only a phone.
Without a remote control surface, the user has to choose between staying at the machine, abandoning the run until later, or losing the chance to steer the agent at the moment new context matters.

The important failure is not lack of another chat UI.
The failure is loss of continuity between a local agent session and the user's real movement through the day.
The code, shell, credentials, working tree, and agent runtime should remain on the laptop or workstation, while the user gets enough mobile presence to watch, steer, stop, and continue the work safely.

Telegram is a practical control surface because users already carry it, and the official Bot API exposes message delivery, file transfer, long polling, forum topics, and draft/streaming primitives through an HTTP interface.[^telegram-api]
Those primitives are useful but constrained: polling and webhooks are mutually exclusive, update offsets define delivery safety, hosted file downloads have a 20 MB cap, and draft streaming only works under Telegram's method contract.[^telegram-updates][^telegram-files][^telegram-drafts]
`pi-telegram` exists to turn those primitives into a dependable pi-session babysitting loop rather than a loose notification script.

## Product

`pi-telegram` is a pi extension that connects a paired Telegram bot to one or more running pi sessions so the user can supervise and control those sessions from a phone while the actual agent work continues on the original computer.
It mirrors session activity, delivers final answers and attachments, accepts Telegram messages as agent input, and routes busy-session messages either as steering or queued follow-up work.

The product's governing principle is continuity of control.
A Telegram message should reach the right pi session at the right lifecycle point, even if that session is already busy, the broker changes, Telegram rate-limits a request, or multiple sessions are connected at once.
The bridge is successful when remote supervision feels like staying present with the local session, not like starting a second disconnected conversation.

## Intended users

The primary user is a developer or agent operator who runs pi sessions on a desktop or laptop and wants to keep supervising them while away from that machine.
They may have one session open in a single repository, or several sessions running across different projects.
They are comfortable configuring a Telegram bot and trusting a local extension, but they should not need to maintain a separate server or expose the workstation to inbound network traffic.

Secondary users are future maintainers and coding agents working on this repository.
For them, the purpose of the bridge is not merely to "send Telegram messages."
It is to preserve the user's agency over local pi sessions across distance, interruption, long-running turns, and multi-session work.
That distinction should guide requirements, architecture, reviews, and bug triage.

## Use environment

`pi-telegram` runs inside pi on the same machine as the agent sessions and project workspaces.
Telegram is the remote operator interface; the local machine remains the execution environment for tools, files, credentials, model configuration, and session state.

The expected environment is opportunistic and interrupt-driven.
The user may connect Telegram before a run starts, after a run is already active, or while several sessions are online.
Mobile commands may arrive while pi is generating, while tools are running, while Telegram is rate-limiting, or while the current broker session shuts down and another connected session must take over.

## Operating model

The bridge treats Telegram as a connection-scoped remote control view and pi as the authority for execution.
A paired Telegram user can select or address currently connected sessions, send text and files into pi, receive activity previews and final answers, stop active work, steer an in-flight turn, or queue follow-up work for later.
Telegram topics and routes are not the durable session history; that history remains on the local machine and can be continued with native pi resume flows before Telegram is connected again.

Multi-session support is part of the product identity, not an optional convenience.
One connected session acts as the broker that polls Telegram and owns shared routing state.
Other sessions register with it and receive turns through local IPC.
If the broker goes away, the system should preserve enough state for still-connected sessions, pending turns, and final responses to recover rather than silently losing work.
If a pi session explicitly disconnects, closes, dies, or fails to reconnect after the built-in automatic reconnect window, its temporary Telegram topic or route should be cleaned up; reconnecting later may create a new Telegram view over the resumed local session.

Activity streaming is advisory but important.
The remote user needs enough live feedback to know whether a session is thinking, using tools, waiting, stopped, or finished.
The bridge should debounce Telegram edits and respect Bot API limits, but it must not discard the underlying history merely because the mobile preview is rate-limited.

## Essential capabilities

The product needs to support these capabilities because they serve remote session babysitting directly:

- pair exactly one authorized Telegram user with a bot through an explicit setup flow;
- connect and disconnect pi sessions without restarting the project or the bot;
- list, select, and route among multiple active sessions;
- mirror current activity when Telegram connects mid-turn;
- deliver ordinary Telegram messages into pi as user input;
- treat ordinary messages sent during busy work as queued follow-up work by default;
- let the operator explicitly steer active work through commands or Telegram controls when needed;
- stop active work from Telegram;
- stream useful previews and deliver final assistant responses without duplicates;
- move inbound Telegram files into private local storage and expose them to pi as attachments;
- send requested local artifacts back to Telegram when pi explicitly attaches them;
- survive Telegram retry windows, update redelivery, bounded automatic reconnect windows, and broker turnover without corrupting routing or losing queued work;
- clean up temporary Telegram topics and routes when a connected pi session disconnects, closes, dies, or fails to reconnect automatically.

These are purpose-level capabilities, not a complete requirements list.
A feature belongs when it strengthens continuity of control over local pi sessions.
A feature is suspect when it turns the bridge into a general Telegram bot framework, a hosted agent service, or a second independent agent runtime.

## Scope boundaries

`pi-telegram` is not a hosted remote IDE, a cloud execution platform, or a replacement for pi's local terminal UI.
It should not move agent execution, shell access, or workspace authority into Telegram.
The phone is the control surface; the computer remains the place where work happens.

It is not a general-purpose Telegram bot framework.
The bridge should implement the Telegram behavior needed for pi supervision, not expose a broad plugin platform for arbitrary bot products.
Forum topics, drafts, albums, file handling, and commands belong only insofar as they improve session routing, visibility, and control.
Telegram topics are temporary views into connected pi sessions, not archival records or the source of session continuity.

It is not a multi-user collaboration product.
The current identity is a paired-user bridge for one operator supervising their own sessions.
Group and forum features may organize multiple sessions, but they do not imply arbitrary team membership, public bot use, or shared access control.

It is not a secret manager or data-loss-prevention system.
It should protect obvious sensitive paths, keep downloaded Telegram data private, and avoid leaking tokens, but the user remains responsible for trusting the installed extension and the Telegram account used to operate it.

## Assumptions and dependencies

The user has a Telegram account, can create a bot through BotFather, and can install or run a pi extension locally.
The local machine must be online enough to poll Telegram and execute pi work.
Telegram Bot API availability, rate limits, message size limits, file limits, and topic/draft method behavior are external constraints the bridge must respect rather than paper over.

The trust boundary is local-first.
The bridge assumes the paired Telegram user is authorized to steer the local pi sessions they connected.
It does not assume arbitrary Telegram chats, files, filenames, or message metadata are trustworthy.

## Traceability

- Upstream human basis: voice note from the project owner on 2026-04-25 describing the goal as babysitting pi sessions from a phone while work continues on the laptop, including one or multiple sessions and connection during an active turn.
- Preserved wording for interpretation: "babysit sessions I write on the computer or laptop" and "control it then smoothly from my phone and everything still runs on the laptop."
- Local grounding artifacts: `README.md`, `AGENTS.md`, `docs.md`, `src/extension.ts`, and the responsibility folders under `src/`.
- Downstream anchors: stakeholder requirements, system requirements, architecture, verification cases, and implementation tasks under `dev/` should trace back to this purpose.

## References

[^telegram-api]: Telegram, "Telegram Bot API", official documentation, accessed 2026-04-25, https://core.telegram.org/bots/api
[^telegram-updates]: Telegram, "Getting updates" and `getUpdates`, official Bot API documentation, accessed 2026-04-25, https://core.telegram.org/bots/api#getting-updates and https://core.telegram.org/bots/api#getupdates
[^telegram-files]: Telegram, `File` / `getFile`, official Bot API documentation, accessed 2026-04-25, https://core.telegram.org/bots/api#file and https://core.telegram.org/bots/api#getfile
[^telegram-drafts]: Telegram, `sendMessageDraft`, official Bot API documentation, accessed 2026-04-25, https://core.telegram.org/bots/api#sendmessagedraft

## Deferred scope

- [OUT-OF-SCOPE] hosted relay service — no current product identity for running a cloud broker or exposing local sessions through an inbound public service.
- [OUT-OF-SCOPE] team access control — no current product identity for multiple Telegram users sharing control of the same pi sessions.
- [OUT-OF-SCOPE] arbitrary bot applications — Telegram features should remain subordinate to pi session supervision.
- [OUT-OF-SCOPE] full remote development environment — Telegram should not become the place where local execution, workspace browsing, or credential authority moves.
