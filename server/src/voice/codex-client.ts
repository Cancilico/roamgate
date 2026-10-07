import { EventEmitter } from "node:events";
import WebSocket from "ws";

export type JsonObject = Record<string, any>;
export interface CodexVoiceClient {
  connect(): Promise<void>;
  request(method: string, params: JsonObject): Promise<JsonObject>;
  on(
    event: "notification",
    listener: (method: string, params: JsonObject) => void,
  ): this;
  on(event: "closed", listener: () => void): this;
  close(): void;
}

/** A client of the existing daemon; never starts or stops a Codex process. */
export class CodexClient extends EventEmitter implements CodexVoiceClient {
  private socket: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: JsonObject) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      method: string;
    }
  >();

  constructor(private readonly path: string) {
    super();
  }

  connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.open();
    return this.ready;
  }

  private async open() {
    const socket = new WebSocket(`ws+unix:${this.path}:/`, {
      maxPayload: 8 * 1024 * 1024,
    });
    this.socket = socket;
    socket.on("message", (raw) => {
      let message: JsonObject;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      const pending =
        message.method === undefined ? this.pending.get(message.id) : undefined;
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(
            new Error(`Codex voice API request failed: ${pending.method}`),
          );
        else pending.resolve(message.result ?? {});
      } else if (
        typeof message.method === "string" &&
        message.id === undefined
      ) {
        this.emit("notification", message.method, message.params ?? {});
      }
      // Server requests belong to the existing terminal approval UI. This
      // observer does not respond, approve, or change the thread's policy.
    });
    socket.on("close", () => {
      this.rejectPending();
      this.emit("closed");
    });
    socket.on("error", () => this.rejectPending());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("Codex daemon connection timed out"));
      }, 8000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Codex daemon is unavailable"));
      });
      socket.once("close", () => {
        clearTimeout(timer);
        reject(new Error("Codex daemon connection closed"));
      });
    });
    await this.request("initialize", {
      clientInfo: { name: "roamgate_voice", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized" }));
  }

  request(method: string, params: JsonObject): Promise<JsonObject> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Codex daemon is disconnected"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer, method });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Codex daemon send failed"));
      });
    });
  }

  private rejectPending() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Codex daemon is disconnected"));
    }
    this.pending.clear();
  }

  close() {
    this.rejectPending();
    this.socket?.terminate();
    this.socket = null;
  }
}
