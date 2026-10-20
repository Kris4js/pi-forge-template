import type { Readable } from "node:stream";
import { ErrorCodes } from "../protocol.ts";

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Handler = (params: any) => unknown | Promise<unknown>;

type Message = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/**
 * Bidirectional JSON-RPC 2.0 peer over newline-delimited JSON.
 * Records are split on LF only (not readline), since U+2028/U+2029 are legal inside JSON strings.
 */
export class Peer {
  private readonly handlers = new Map<string, Handler>();
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private closed = false;

  constructor(
    input: Readable,
    private readonly write: (line: string) => void,
    private readonly log: (msg: string) => void = () => {},
  ) {
    let buffer = "";
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.trim()) this.dispatch(line);
      }
    });
    input.on("end", () => this.close(new Error("IPC input closed")));
  }

  handle(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error("IPC closed"));
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  close(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(reason);
    this.pending.clear();
  }

  private send(message: Message): void {
    if (this.closed) return;
    this.write(JSON.stringify(message) + "\n");
  }

  private dispatch(line: string): void {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      this.send({ jsonrpc: "2.0", id: null, error: { code: ErrorCodes.parseError, message: "parse error" } });
      return;
    }

    if (message.method === undefined) {
      const id = typeof message.id === "number" ? message.id : Number(message.id);
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (message.error) waiter.reject(new RpcError(message.error.code, message.error.message, message.error.data));
      else waiter.resolve(message.result);
      return;
    }

    void this.serve(message);
  }

  private async serve(message: Message): Promise<void> {
    const isRequest = message.id !== undefined && message.id !== null;
    const handler = this.handlers.get(message.method!);
    if (!handler) {
      if (isRequest) {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: ErrorCodes.methodNotFound, message: `unknown method ${message.method}` },
        });
      }
      return;
    }
    try {
      const result = await handler(message.params ?? {});
      if (isRequest) this.send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
    } catch (error) {
      const rpc =
        error instanceof RpcError
          ? error
          : new RpcError(ErrorCodes.internal, error instanceof Error ? error.message : String(error));
      if (!(error instanceof RpcError)) this.log(`handler ${message.method} failed: ${rpc.message}`);
      if (isRequest) {
        this.send({ jsonrpc: "2.0", id: message.id, error: { code: rpc.code, message: rpc.message, data: rpc.data } });
      }
    }
  }
}
