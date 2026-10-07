import type { ConnectionClient } from "./api";

export type VoiceEvent = {
  call_id: string;
  status: string;
  message?: string;
  transcript?: {
    item_id: string;
    delta?: string;
    text?: string;
    role?: string;
  };
};
export interface VoiceTransport {
  connect(): Promise<void>;
  call(method: string, params: Record<string, unknown>): Promise<any>;
  close(): void;
}

/** A dedicated socket gives every voice call its own server cleanup owner.
 * Closing it ends voice even after the main UI changes its routing lease. */
export class BrowserVoiceTransport implements VoiceTransport {
  private socket: WebSocket | null = null;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private connectingReject: ((error: Error) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly client: ConnectionClient,
    private readonly event: (event: VoiceEvent) => void,
  ) {}

  connect(): Promise<void> {
    const url = new URL("ws", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      this.connectingReject = reject;
      this.timer = setTimeout(() => {
        this.close();
        reject(new Error("Voice bridge connection timed out"));
      }, 8000);
      socket.onmessage = (message) => {
        let data;
        try {
          data = JSON.parse(message.data);
        } catch {
          return;
        }
        if (data?.hello === true) {
          clearTimeout(this.timer);
          this.connectingReject = null;
          resolve();
          return;
        }
        if (
          data?.connection_id !== this.client.connectionId ||
          data.connection_generation !== this.client.serverRuntimeGeneration
        )
          return;
        if (data.event === "voice.updated" && data.data) this.event(data.data);
        const request = this.pending.get(data.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(data.id);
        if (data.error)
          request.reject(
            new Error(data.error.message || "Voice request failed"),
          );
        else request.resolve(data.result);
      };
      socket.onclose = () => {
        this.fail();
        this.event({
          call_id: "",
          status: "error",
          message: "Voice bridge disconnected",
        });
      };
      socket.onerror = () => this.fail();
    });
  }

  call(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Voice bridge is disconnected"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Voice bridge request timed out"));
      }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket!.send(
          JSON.stringify({
            id,
            method,
            params,
            connection_id: this.client.connectionId,
            connection_generation: this.client.serverRuntimeGeneration,
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Voice bridge send failed"));
      }
    });
  }

  private fail() {
    clearTimeout(this.timer);
    this.connectingReject?.(new Error("Voice bridge disconnected"));
    this.connectingReject = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Voice bridge disconnected"));
    }
    this.pending.clear();
  }
  close() {
    this.fail();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket.close();
    }
    this.socket = null;
  }
}
