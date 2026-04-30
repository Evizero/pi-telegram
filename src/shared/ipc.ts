import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, readFile, rm } from "node:fs/promises";

import { BROKER_DIR, TOKEN_PATH } from "./paths.js";
import { MAX_FILE_BYTES } from "./file-policy.js";
import type { IpcEnvelope, IpcResponse } from "./ipc-types.js";
import { ensurePrivateDir, errorMessage, now, randomId } from "./utils.js";

export async function postIpc<TResponse>(
	socketPath: string,
	type: string,
	payload: unknown,
	targetSessionId: string | undefined,
	fallbackToken: string,
	sourceConnectionNonce?: string,
): Promise<TResponse> {
	const token = await readFile(TOKEN_PATH, "utf8").catch(() => fallbackToken);
	const envelope: IpcEnvelope = {
		schema_version: 1,
		id: randomId("msg"),
		type,
		session_id: targetSessionId,
		connection_nonce: sourceConnectionNonce,
		payload,
		sent_at_ms: now(),
	};
	const body = JSON.stringify(envelope);
	return await new Promise<TResponse>((resolveValue, reject) => {
		const req = httpRequest(
			{
				socketPath,
				path: "/ipc",
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(body),
					authorization: `Bearer ${token.trim()}`,
				},
				timeout: 5000,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					try {
						const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as IpcResponse<TResponse>;
						if (!parsed.ok) reject(new Error(parsed.error?.message || parsed.error?.code || "IPC failed"));
						else resolveValue(parsed.payload as TResponse);
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		req.on("timeout", () => req.destroy(new Error("IPC timeout")));
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

function sendIpcResponse(res: ServerResponse, requestId: string, payload: unknown, error?: { code: string; message: string }): void {
	const response: IpcResponse = {
		schema_version: 1,
		id: requestId,
		ok: !error,
		payload: error ? null : payload,
		error: error ?? null,
		sent_at_ms: now(),
	};
	const text = JSON.stringify(response);
	res.writeHead(error ? 400 : 200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
	res.end(text);
}

async function readRequest(req: IncomingMessage): Promise<IpcEnvelope> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_FILE_BYTES * 2) throw new Error("IPC body too large");
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as IpcEnvelope;
}

export async function createIpcServer(
	socketPath: string,
	fallbackToken: () => string,
	handler: (envelope: IpcEnvelope) => Promise<unknown>,
): Promise<Server> {
	await ensurePrivateDir(BROKER_DIR);
	await rm(socketPath, { force: true }).catch(() => undefined);
	const server = createServer((req, res) => {
		void (async () => {
			try {
				if (req.method !== "POST") throw new Error("Only POST is supported");
				const expected = (await readFile(TOKEN_PATH, "utf8").catch(() => fallbackToken())).trim();
				const auth = req.headers.authorization ?? "";
				if (!expected || auth !== `Bearer ${expected}`) {
					res.writeHead(401).end("unauthorized");
					return;
				}
				const envelope = await readRequest(req);
				const payload = await handler(envelope);
				sendIpcResponse(res, envelope.id, payload);
			} catch (error) {
				sendIpcResponse(res, "unknown", null, { code: "ipc_error", message: errorMessage(error) });
			}
		})();
	});
	await new Promise<void>((resolveValue, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			server.on("error", (error) => {
				console.warn("[pi-telegram] IPC server error:", errorMessage(error));
			});
			resolveValue();
		});
	});
	await chmod(socketPath, 0o600).catch(() => undefined);
	return server;
}
