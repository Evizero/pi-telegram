export interface IpcEnvelope<TPayload = unknown> {
	schema_version: 1;
	id: string;
	type: string;
	session_id?: string;
	connection_nonce?: string;
	payload: TPayload;
	sent_at_ms: number;
}

export interface IpcResponse<TPayload = unknown> {
	schema_version: 1;
	id: string;
	ok: boolean;
	payload: TPayload | null;
	error: { code: string; message: string } | null;
	sent_at_ms: number;
}
