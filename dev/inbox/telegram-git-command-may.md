---
title: "Telegram /git command may be incomplete and undocumented"
type: "bug"
created: "2026-04-29"
author: "Christof Stocker"
status: "planned"
planned_as: ["fix-and-document-telegram-git-status"]
---
User reported from Telegram: "I don’t think /git fully works and also it’s not in readme".

Observed status output included:

```
Git status
Branch: main @ 6003d9ab2b71
Upstream: origin/main (+2/-0)
State: unknown — bounded Git query incomplete
Note: Unstaged content detection is metadata-only and may miss same-size edits within the same mtime second.
```

Preserve both aspects for triage: the command may not fully report repository state, and the README may omit the /git command documentation.
