---
title: "Telegram git status command"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["implement-telegram-git-repository"]
---
User requested investigation, not implementation, of Telegram-side commands for compact repository state without causing agent turns. Voice-note source context: 'could we add some commands in telegram itself for basically git status ... often wanting to just see without causing agent turns or sending anything to the agent ... a compact view not literally what git status outputs but a parsed compact markdown telegram messenger friendly view of git status just for me investigate and report back.'

Refinement from user: make /git open an inline-button menu for subcommands instead of immediately running status. Initial buttons should include Status and one other useful read-only option. Candidate second button: Summary, showing branch/upstream plus concise counts/recent HEAD context without file list; alternative candidate is Diffstat, showing changed-file counts and insertions/deletions but no patch content.

User confirmed the second button should be Diffstat.
