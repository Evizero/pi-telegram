---
title: "Reconnect after explicit Telegram disconnect should create a new topic"
type: "bug"
created: "2026-04-27"
author: "Christof Salis"
status: "planned"
planned_as: ["honor-explicit-telegram-disconnect"]
---
Source: User report/investigation request on 2026-04-27:

> i think it doesnt work if in same pi session i disconnect telegram and then connect again later. i would assume it shoudl create a new topic just like it was a fresh pi session. investigate and create inbox item if expected behavior is not true

Expected behavior confirmed from architecture:
- Explicit Telegram disconnect ends the current Telegram route/topic identity.
- A later `/telegram-connect` from the same native pi session should behave like a fresh Telegram view and create a new route/topic over the resumed local history, rather than reusing the old route/topic.

Investigation notes:
- `dev/ARCHITECTURE.md` says explicit disconnect means the old Telegram route is no longer the session identity, and a later native `/resume` plus Telegram connect may create a new route/topic.
- Broker-owned disconnect path in `src/extension.ts` calls `unregisterSession(sessionId)` before stopping the client server. `src/broker/sessions.ts` removes the session route from `brokerState.routes` and queues topic cleanup, so a later registration has no existing route and should create a new topic.
- Non-broker disconnect path queues a durable disconnect request and immediately stops the local client server. If the same pi process reconnects before the broker processes that request, `startClientServer()` creates a new connection nonce but the client socket path and pid are unchanged.
- `BrokerSessionRegistrationCoordinator.registerSession()` treats that as a refreshed registration, not a replacement, because `replacement` is false when pid and clientSocketPath match.
- `ensureRouteForSessionInBroker()` then finds the still-present old route for the same `sessionId` and returns it when the chat matches.
- Registration subsequently calls `clearDisconnectRequest(registration.sessionId)`, which can delete the pending explicit-disconnect intent before it ever removes the old route.

Likely failure mode:
- In a same pi session where this extension is not the active broker, `/telegram-disconnect` followed quickly/later by `/telegram-connect` can reuse the old route/topic if the broker has not processed the queued disconnect request yet. That violates the expected fresh-topic behavior for explicit disconnect.

Related existing inbox item:
- `non-broker-disconnect-should` already notes that non-broker disconnect can silently leave routes if broker IPC/processing is unavailable. This item preserves the more specific reconnect-before-disconnect-request-processing path where reconnect clears the pending intent and reuses the stale route.

Potential fix direction:
- Treat explicit disconnect requests as terminal route-lifecycle intents that must be honored before or during same-session re-registration.
- Do not let `registerSession()` blindly clear a matching disconnect request until the old route has been removed or the request is proven stale by a truly newer user-initiated connect.
- Consider making local `/telegram-disconnect` await broker unregister acknowledgement before hiding status, or include enough connection-generation/route-generation metadata to distinguish explicit reconnect from automatic reconnect grace.

Additional voice-note follow-up on 2026-04-27:

Transcript: "also what if it's just the one pi session meaning it would also be the broker. think about the scenarios where there exists a broker in another pi session or if the one disconnecting and reconnecting also has to do the broker. do a deep dive on this"

Scenario deep dive:

1. Disconnecting session is already the broker, idle/no pending finals:
   - `/telegram-disconnect` enters the `isBroker` branch in `disconnectSessionRoute()`.
   - It calls `unregisterSession(sessionId)` before `stopClientServer()`.
   - `unregisterSessionFromBroker()` removes the session and detaches its routes from `brokerState.routes`, then queues/retries topic deletion.
   - Later `/telegram-connect` reuses the still-live local broker lease but registers a session with no existing route, so `ensureRouteForSessionInBroker()` should call `createForumTopic` and create a new topic.
   - This scenario appears to satisfy the expected behavior unless unregister is skipped or fails.

2. Disconnecting session is already the broker, but pending assistant finals block unregister:
   - The `isBroker` branch drains ready finals and then throws `Waiting for pending Telegram final delivery before disconnecting` if this session still has a pending assistant final.
   - The `finally` block still stops the client server because `shutdownClientRoute()` itself succeeded.
   - That can leave the broker running with the old session/route still in broker state while the local UI is hidden/disconnected. A later reconnect can then find and reuse the old route.
   - This is a self-broker path where the fresh-topic expectation can fail, especially around active or retrying final delivery.

3. Another pi session is the broker, disconnect request processed before reconnect:
   - Non-broker `/telegram-disconnect` queues a disconnect request file and stops the client heartbeat/server.
   - The active broker processes disconnect requests every broker heartbeat and at broker startup.
   - If it processes the request before the user reconnects, it unregisters the session, removes the old route, and queues topic cleanup.
   - Later reconnect should create a new topic. This is the good non-broker path.

4. Another pi session is the broker, reconnect happens before request processing:
   - The old route remains in `brokerState.routes`.
   - Reconnect creates a new `connectionNonce`/`connectionStartedAtMs`, but the pid and client socket path are the same for the same extension process.
   - `registerSession()` does not classify this as a replacement and `ensureRouteForSessionInBroker()` returns the old route because the target chat still matches.
   - `registerSession()` then clears the disconnect request. Even if the request survived until processing, `processDisconnectRequestsInBroker()` would treat nonce mismatch or newer `connectionStartedAtMs` as stale and clear it rather than unregister.
   - This is the strongest likely reproduction for old-topic reuse.

5. The disconnecting session later becomes broker because the previous broker is gone:
   - The queued disconnect request still exists, but `ensureBrokerStarted()` launches request processing asynchronously and then `connectTelegramClient()` registers the local session.
   - There is an ordering race: if request processing wins, old route is removed and reconnect creates a new topic; if registration wins, old route is reused and the request can be cleared/invalidated.
   - Therefore broker self-promotion after a non-broker disconnect is also vulnerable.

6. Broker offline marking instead of explicit request processing:
   - After heartbeat expiry, `markSessionOfflineInBroker()` removes routes only when there are no pending assistant finals for that session.
   - If pending finals exist, route cleanup can be deferred/preserved. A later reconnect may reuse that route unless the explicit disconnect intent is still honored.

Implication:
- The bug is not simply "broker versus non-broker". The normal idle self-broker path looks correct; the vulnerable paths are (a) non-broker disconnect where the queued explicit-disconnect intent loses a race with reconnect, (b) promotion-to-broker while that request is pending, and (c) any path where pending final state prevents actual unregister while the client is nevertheless stopped/hidden.

Fix considerations:
- Make explicit disconnect a durable terminal route-lifecycle operation, not a best-effort side request that newer registration can erase.
- Registration should check for and honor same-session pending disconnect requests before route reuse, or disconnect should synchronously unregister with broker acknowledgement before reporting local disconnect.
- The staleness test in `processDisconnectRequestsInBroker()` probably needs to distinguish automatic reconnect/liveness churn from a user-initiated reconnect after explicit disconnect.
- Self-broker disconnect should not stop/hide the client as disconnected if unregister was intentionally deferred by pending final delivery, or it should persist a guaranteed unregister-after-final intent.
