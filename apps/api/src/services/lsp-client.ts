/**
 * Low-level JSON-RPC client for LSP communication over stdio.
 *
 * Handles Content-Length framing, request/response matching, and
 * server-sent notifications (e.g. publishDiagnostics).
 *
 * Ported from legacy-bridge/backend/src/agent/lspClient.ts
 */

import { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ---------------------------------------------------------------------------
// LSP protocol types (subset we need)
// ---------------------------------------------------------------------------

export interface LspPosition {
  line: number; // 0-based
  character: number; // 0-based
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspSymbolInformation {
  name: string;
  kind: number;
  location: LspLocation;
  containerName?: string;
}

export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

export interface LspHoverResult {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { kind: string; value: string }>;
  range?: LspRange;
}

// Symbol kind numbers to readable names (used by lsp-manager.ts)
const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
  6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
  11: "Interface", 12: "Function", 13: "Variable", 14: "Constant",
  15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object",
  20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
  25: "Operator", 26: "TypeParameter",
};

export function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] || `Unknown(${kind})`;
}

const SEVERITY_NAMES: Record<number, string> = {
  1: "Error", 2: "Warning", 3: "Info", 4: "Hint",
};

export function severityName(severity?: number): string {
  return severity ? SEVERITY_NAMES[severity] || "Unknown" : "Unknown";
}

// ---------------------------------------------------------------------------
// JSON-RPC connection
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;

export class JsonRpcConnection {
  private nextId = 0;
  private buffer = "";
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private notificationHandlers = new Map<
    string,
    (params: unknown) => void
  >();
  private alive = true;

  constructor(private proc: ChildProcess) {
    if (!proc.stdout || !proc.stdin) {
      throw new Error("LSP process must have stdio pipes");
    }
    proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.stderr?.on("data", () => {}); // drain stderr to prevent blocking
    proc.on("exit", () => this.onClose());
    proc.on("error", () => this.onClose());
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /** Register a handler for server-sent notifications (e.g. publishDiagnostics). */
  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Send a JSON-RPC request and wait for the response. */
  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.alive) throw new Error("LSP connection is closed");
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `LSP request "${method}" timed out after ${REQUEST_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (!this.alive) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Gracefully close the connection. */
  close(): void {
    if (!this.alive) return;
    this.alive = false;
    // Reject all pending requests
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error("LSP connection closed"));
    }
    this.pending.clear();
    try {
      this.proc.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    // Force kill after 3 seconds if still alive
    setTimeout(() => {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 3000).unref();
  }

  // -- Private ---------------------------------------------------------------

  private send(msg: JsonRpcMessage): void {
    const json = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n`;
    try {
      this.proc.stdin!.write(header + json);
    } catch {
      // stdin closed — connection is dead
      this.onClose();
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    // Try to parse complete messages from the buffer
    while (this.tryParseMessage()) {
      /* keep parsing */
    }
  }

  private tryParseMessage(): boolean {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return false;

    const header = this.buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // Malformed header — skip past it
      this.buffer = this.buffer.slice(headerEnd + 4);
      return true;
    }

    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (this.buffer.length < bodyStart + contentLength) return false; // incomplete body

    const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
    this.buffer = this.buffer.slice(bodyStart + contentLength);

    try {
      const msg = JSON.parse(body) as JsonRpcMessage;
      this.handleMessage(msg);
    } catch {
      // Malformed JSON — ignore
    }
    return true;
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Response to a request
    if (
      "id" in msg &&
      typeof msg.id === "number" &&
      this.pending.has(msg.id)
    ) {
      const { resolve, reject, timer } = this.pending.get(msg.id)!;
      clearTimeout(timer);
      this.pending.delete(msg.id);
      const resp = msg as JsonRpcResponse;
      if (resp.error) {
        reject(new Error(resp.error.message));
      } else {
        resolve(resp.result);
      }
      return;
    }

    // Server-sent notification
    if ("method" in msg && !("id" in msg)) {
      const handler = this.notificationHandlers.get(msg.method);
      if (handler) {
        try {
          handler((msg as JsonRpcNotification).params);
        } catch {
          /* ignore handler errors */
        }
      }
    }
  }

  private onClose(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error("LSP process exited"));
    }
    this.pending.clear();
  }
}
