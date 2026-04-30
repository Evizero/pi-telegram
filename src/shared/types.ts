// Transitional compatibility barrel for the former broad runtime data model.
// New code should import from the bounded owner modules instead:
// - ../telegram/types.js for Telegram Bot API DTOs and Telegram message-operation state
// - ../broker/types.js for broker durable state, routes, sessions, and command controls
// - ../client/types.js for client turn/final payloads and client IPC result contracts
// - ./config-types.js for persisted bridge configuration shape
// - ./ipc-types.js for local IPC envelopes and responses
export type * from "./config-types.js";
export type * from "../telegram/types.js";
export type * from "../broker/types.js";
export type * from "../client/types.js";
export type * from "./ipc-types.js";
