import { randomUUID } from "node:crypto";
import {
  CodexClient,
  type CodexVoiceClient,
  type JsonObject,
} from "./codex-client";
import { activeVoiceSession } from "./ownership";

// Multiple local Roamgate connection runtimes can reach the same daemon.
const reservations = new Set<string>();
type Call = {
  id: string;
  owner: object;
  paneId: string;
  threadId: string;
  path: string;
  key: string;
  reserved: boolean;
  client: CodexVoiceClient;
  cancelled: boolean;
  started: boolean;
  foreign: boolean;
  rejectReady: (error: Error) => void;
  cleanup?: Promise<void>;
  startTask?: Promise<JsonObject>;
};

export function createVoiceBridge(args: {
  enabled: boolean;
  socketPath: string;
  local: boolean;
  herdrCall: (method: string, params: JsonObject) => Promise<JsonObject>;
  publish: (owner: object, data: JsonObject) => void;
  client?: () => CodexVoiceClient;
  readActive?: (path: string) => Promise<string | null>;
  report?: (message: string) => void;
}) {
  let current: Call | null = null;
  let disposed = false;
  const readActive = args.readActive ?? activeVoiceSession;
  const makeClient = args.client ?? (() => new CodexClient(args.socketPath));

  function available() {
    if (!args.enabled)
      throw new Error("Codex voice is disabled on this Roamgate server");
    if (!args.local)
      throw new Error("Codex voice currently supports local connections only");
    if (disposed) throw new Error("Voice connection was replaced");
  }

  function publish(call: Call, status: string, extra: JsonObject = {}) {
    if (call.cancelled) return;
    args.publish(call.owner, {
      call_id: call.id,
      pane_id: call.paneId,
      thread_id: call.threadId,
      status,
      ...extra,
    });
  }

  function release(call: Call) {
    call.client.close();
    if (call.reserved) reservations.delete(call.key);
    if (current === call) current = null;
  }

  async function cleanup(call: Call) {
    if (call.cleanup) return call.cleanup;
    call.cancelled = true;
    call.rejectReady(new Error("Voice call ended"));
    call.cleanup = (async () => {
      try {
        await call.startTask?.catch(() => undefined);
        // Never stop a voice call created or replaced by another client.
        if (
          call.path &&
          !call.foreign &&
          (await readActive(call.path)) === call.id
        )
          await call.client.request("thread/realtime/stop", {
            threadId: call.threadId,
          });
      } catch {
        args.report?.("Voice cleanup could not confirm completion");
      } finally {
        release(call);
      }
    })();
    return call.cleanup;
  }

  async function capabilities() {
    if (!args.enabled || !args.local || disposed) return { available: false };
    const client = makeClient();
    try {
      await client.connect();
      await client.request("thread/realtime/listVoices", {});
      return { available: true };
    } catch {
      return {
        available: false,
        reason: "Codex daemon voice API is unavailable",
      };
    } finally {
      client.close();
    }
  }

  async function start(
    owner: object,
    params: JsonObject,
    isCurrent: () => boolean,
  ) {
    available();
    if (current)
      throw new Error(
        "A Roamgate voice call is already active on this connection",
      );
    const paneId = params.pane_id;
    const sdp = params.sdp;
    if (
      typeof paneId !== "string" ||
      !paneId ||
      typeof sdp !== "string" ||
      !sdp.startsWith("v=0") ||
      sdp.length > 128 * 1024
    )
      throw new Error("Invalid voice pane or SDP offer");
    if (
      params.call_id !== undefined &&
      (typeof params.call_id !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(params.call_id))
    )
      throw new Error("Invalid voice call id");
    // Reserve this runtime before the first await, including pending starts.
    const client = makeClient();
    let resolveReady!: (sdp: string) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<string>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Observe errors immediately while identity and history are resolved.
    void ready.catch(() => undefined);
    const call: Call = {
      id: params.call_id ?? randomUUID(),
      owner,
      paneId,
      threadId: "",
      path: "",
      key: "",
      reserved: false,
      client,
      cancelled: false,
      started: false,
      foreign: false,
      rejectReady,
    };
    current = call;
    const check = () => {
      if (call.cancelled || disposed || !isCurrent())
        throw new Error("Voice start was cancelled or connection changed");
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await args.herdrCall("agent.get", { target: paneId });
      check();
      const agent = response.agent;
      const session = agent?.agent_session;
      if (
        agent?.agent !== "codex" ||
        session?.kind !== "id" ||
        typeof session.value !== "string"
      )
        throw new Error("Select a Codex agent with a known session");
      call.threadId = session.value;
      call.key = `${args.socketPath}:${call.threadId}`;
      if (reservations.has(call.key))
        throw new Error(
          "Another Roamgate browser is using voice on this agent",
        );
      reservations.add(call.key);
      call.reserved = true;
      await client.connect();
      check();
      const loaded = await client.request("thread/loaded/list", {});
      check();
      if (!Array.isArray(loaded.data) || !loaded.data.includes(call.threadId))
        throw new Error(
          "This Codex session is not loaded in the shared daemon",
        );
      const info = await client.request("thread/read", {
        threadId: call.threadId,
        includeTurns: false,
      });
      check();
      if (typeof info.thread?.path !== "string" || info.thread.ephemeral)
        throw new Error(
          "A persisted Codex session is required to verify voice ownership",
        );
      call.path = info.thread.path;
      client.on("notification", (method, data) => {
        if (data.threadId !== call.threadId || call.cancelled) return;
        if (method === "thread/realtime/started") {
          if (data.realtimeSessionId !== call.id) {
            call.foreign = true;
            publish(call, "ended", {
              message: "Voice moved to another client",
            });
            void cleanup(call);
            return;
          }
          call.started = true;
        } else if (
          method === "thread/realtime/sdp" &&
          call.started &&
          typeof data.sdp === "string"
        )
          resolveReady(data.sdp);
        else if (method === "thread/realtime/error") {
          // Backend diagnostics can contain account/provider details. Expose a
          // stable error, without logging raw upstream payloads or SDP.
          const error = new Error(
            "Codex voice connection failed; check account voice availability",
          );
          rejectReady(error);
          publish(call, "error", { message: error.message });
          void cleanup(call);
        } else if (
          method === "thread/realtime/closed" ||
          method === "thread/closed"
        ) {
          publish(call, "ended");
          call.started = false;
          void cleanup(call);
        } else if (method === "thread/realtime/item/transcript/delta") {
          publish(call, "connected", {
            transcript: {
              item_id: data.itemId,
              delta: String(data.delta ?? "").slice(0, 8000),
            },
          });
        } else if (
          method === "thread/realtime/item/completed" &&
          data.item?.type === "transcriptSegment" &&
          data.item.realtimeSessionId === call.id
        ) {
          publish(call, "connected", {
            transcript: {
              item_id: data.item.id,
              role: data.item.role,
              text: String(data.item.text ?? "").slice(0, 16000),
            },
          });
        }
      });
      client.on("closed", () => {
        if (call.cancelled) return;
        publish(call, "error", { message: "Codex daemon disconnected" });
        call.cancelled = true;
        rejectReady(new Error("Codex daemon disconnected"));
        release(call);
      });
      // Subscribe without overriding permissions, model, instructions or cwd.
      await client.request("thread/resume", {
        threadId: call.threadId,
        excludeTurns: true,
      });
      check();
      if (await readActive(call.path))
        throw new Error(
          "This agent already has a voice call; end it in its original client first",
        );
      check();
      const latest = await args.herdrCall("agent.get", { target: paneId });
      check();
      if (latest.agent?.agent_session?.value !== call.threadId)
        throw new Error("The selected Codex agent changed");
      timer = setTimeout(
        () => rejectReady(new Error("Codex voice negotiation timed out")),
        30000,
      );
      call.startTask = client.request("thread/realtime/start", {
        threadId: call.threadId,
        realtimeSessionId: call.id,
        outputModality: "audio",
        version: "v3",
        transport: { type: "webrtc", sdp },
      });
      const [answer] = await Promise.all([ready, call.startTask]);
      check();
      args.report?.("Voice connection negotiated");
      return {
        call_id: call.id,
        pane_id: paneId,
        thread_id: call.threadId,
        name: String(agent.name || agent.title || "Codex"),
        sdp: answer,
      };
    } catch (error) {
      await cleanup(call);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function stop(owner: object, params: JsonObject) {
    const call = current;
    if (!call) return { ended: true };
    if (call.owner !== owner || params.call_id !== call.id)
      throw new Error("Voice call belongs to another browser");
    await cleanup(call);
    return { ended: true };
  }

  return {
    capabilities,
    start,
    stop,
    cleanupOwner: (owner: object) =>
      current?.owner === owner ? cleanup(current) : Promise.resolve(),
    paneExited: (paneId: string) => {
      if (current?.paneId !== paneId) return Promise.resolve();
      publish(current, "ended");
      return cleanup(current);
    },
    dispose: () => {
      disposed = true;
      if (!current) return Promise.resolve();
      publish(current, "ended");
      return cleanup(current);
    },
  };
}
