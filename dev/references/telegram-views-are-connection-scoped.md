---
title: "Telegram views are connection-scoped"
category: "normative"
authority: "Project owner"
section: "Chat directive"
edition: "2026-04-25"
status: "active"
captured: "2026-04-25"
captured_by: "pi agent"
---
i want the topic to go away as i said. for example if i close a pi process it shoudl go away. if i want to continue work and start pi with /resume i can always connect it again to continue in a new topic. so nothing is lost the session history is on machine, not telegram. telegram is a temporary interface with ephermeral views into a section that last for the duration of connection. any disconnect or death (also crash) should clean up. the only exception is if built in automatic reconnect (for example if inet speed is slow or something) can fix it, in which case the topic should wait.
