import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createVoiceBridge } from "./voice-bridge";

function fixture(
  options: {
    enabled?: boolean;
    local?: boolean;
    active?: string;
    socket?: string;
    holdStart?: boolean;
  } = {},
) {
  let active = options.active ?? null;
  const requests: { method: string; params: Record<string, any> }[] = [];
  const events: any[] = [];
  const started = Promise.withResolvers<void>();
  const completeStart = Promise.withResolvers<void>();
  class Client extends EventEmitter {
    closed = false;
    async connect() {}
    async request(method: string, params: Record<string, any>) {
      requests.push({ method, params });
      if (method === "thread/loaded/list") return { data: ["thread-1"] };
      if (method === "thread/read")
        return { thread: { path: "/test/rollout", ephemeral: false } };
      if (method === "thread/realtime/start") {
        active = params.realtimeSessionId;
        // Deliberately arrive before the RPC response.
        this.emit("notification", "thread/realtime/started", {
          threadId: "thread-1",
          realtimeSessionId: active,
        });
        this.emit("notification", "thread/realtime/sdp", {
          threadId: "thread-1",
          sdp: "answer",
        });
        started.resolve();
        if (options.holdStart) await completeStart.promise;
      }
      if (method === "thread/realtime/stop") active = null;
      return {};
    }
    close() {
      this.closed = true;
      this.emit("closed");
    }
  }
  const clients: Client[] = [];
  const agent = {
    agent: "codex",
    name: "Existing agent",
    agent_session: { kind: "id", value: "thread-1" },
  };
  const herdrRequests: string[] = [];
  const bridge = createVoiceBridge({
    enabled: options.enabled ?? true,
    local: options.local ?? true,
    socketPath: options.socket ?? crypto.randomUUID(),
    herdrCall: async (method) => {
      herdrRequests.push(method);
      return { agent };
    },
    client: () => {
      const client = new Client();
      clients.push(client);
      return client;
    },
    readActive: async () => active,
    publish: (owner, data) => events.push({ owner, ...data }),
  });
  return {
    bridge,
    agent,
    clients,
    requests,
    events,
    herdrRequests,
    started: started.promise,
    completeStart: () => completeStart.resolve(),
    setActive: (value: string | null) => {
      active = value;
    },
  };
}
const params = () => ({
  pane_id: "w1:p1",
  sdp: "v=0\r\n",
  call_id: crypto.randomUUID(),
});

describe("Codex browser voice coexistence", () => {
  test("disconnect during pending start waits for acknowledgement and cleans up the owned call", async () => {
    const f = fixture({ holdStart: true });
    const owner = {};
    const starting = f.bridge.start(owner, params(), () => true);
    // Observe cancellation before it can reject while the upstream is pending.
    const rejected = starting.then(
      () => null,
      (error: Error) => error,
    );
    await f.started;
    const cleanup = f.bridge.cleanupOwner(owner);
    expect(f.requests.some((r) => r.method === "thread/realtime/stop")).toBe(
      false,
    );
    f.completeStart();
    await cleanup;
    expect((await rejected)?.message).toContain("cancelled");
    expect(
      f.requests.filter((r) => r.method === "thread/realtime/stop"),
    ).toHaveLength(1);
  });

  test("ownership read failure refuses a start without attempting to stop an unknown call", async () => {
    const requests: string[] = [];
    class Client extends EventEmitter {
      async connect() {}
      async request(method: string) {
        requests.push(method);
        if (method === "thread/loaded/list") return { data: ["thread"] };
        if (method === "thread/read")
          return { thread: { path: "/unreadable" } };
        return {};
      }
      close() {}
    }
    const bridge = createVoiceBridge({
      enabled: true,
      local: true,
      socketPath: crypto.randomUUID(),
      client: () => new Client(),
      publish: () => {},
      herdrCall: async () => ({
        agent: {
          agent: "codex",
          agent_session: { kind: "id", value: "thread" },
        },
      }),
      readActive: async () => {
        throw new Error("unreadable history");
      },
    });
    await expect(bridge.start({}, params(), () => true)).rejects.toThrow(
      "unreadable history",
    );
    expect(
      requests.some(
        (m) => m === "thread/realtime/start" || m === "thread/realtime/stop",
      ),
    ).toBe(false);
  });
  test("negotiates early SDP on the existing thread without changing permissions or sending terminal input", async () => {
    const f = fixture();
    const owner = {};
    const result = await f.bridge.start(owner, params(), () => true);
    expect(result.sdp).toBe("answer");
    expect(result.name).toBe("Existing agent");
    expect(
      f.requests.find((r) => r.method === "thread/resume")?.params,
    ).toEqual({ threadId: "thread-1", excludeTurns: true });
    expect(
      f.requests.find((r) => r.method === "thread/realtime/start")?.params,
    ).toMatchObject({
      version: "v3",
      outputModality: "audio",
      threadId: "thread-1",
    });
    expect(f.herdrRequests).toEqual(["agent.get", "agent.get"]);
    await f.bridge.stop(owner, { call_id: result.call_id });
    expect(f.requests.map((r) => r.method)).not.toContain("turn/interrupt");
    expect(
      f.requests.filter((r) => r.method === "thread/realtime/stop"),
    ).toHaveLength(1);
  });

  test("refuses another active native call and never stops it", async () => {
    const f = fixture({ active: "external-call" });
    await expect(f.bridge.start({}, params(), () => true)).rejects.toThrow(
      "already has a voice call",
    );
    expect(
      f.requests.some(
        (r) =>
          r.method === "thread/realtime/start" ||
          r.method === "thread/realtime/stop",
      ),
    ).toBe(false);
  });

  test("releasing a failed competing runtime does not remove the first browser's reservation", async () => {
    const socket = crypto.randomUUID();
    const f = fixture({ socket });
    const other = fixture({ socket });
    const owner = {};
    const first = await f.bridge.start(owner, params(), () => true);
    await expect(other.bridge.start({}, params(), () => true)).rejects.toThrow(
      "Another Roamgate browser",
    );
    await expect(other.bridge.start({}, params(), () => true)).rejects.toThrow(
      "Another Roamgate browser",
    );
    await f.bridge.stop(owner, { call_id: first.call_id });
    const secondOwner = {};
    const second = await other.bridge.start(secondOwner, params(), () => true);
    await other.bridge.stop(secondOwner, { call_id: second.call_id });
  });

  test("a browser cannot end another browser's call", async () => {
    const f = fixture();
    const owner = {};
    const result = await f.bridge.start(owner, params(), () => true);
    await expect(
      f.bridge.stop({}, { call_id: result.call_id }),
    ).rejects.toThrow("another browser");
    await f.bridge.cleanupOwner({});
    expect(f.requests.some((r) => r.method === "thread/realtime/stop")).toBe(
      false,
    );
    await f.bridge.cleanupOwner(owner);
  });

  test("ending Roamgate leaves a replacement call and terminal controller untouched", async () => {
    const f = fixture();
    const owner = {};
    const result = await f.bridge.start(owner, params(), () => true);
    f.setActive("another-native-client");
    await f.bridge.stop(owner, { call_id: result.call_id });
    expect(f.requests.some((r) => r.method === "thread/realtime/stop")).toBe(
      false,
    );
    expect(f.herdrRequests.every((m) => m === "agent.get")).toBe(true);
  });

  test("a foreign started notification detaches Roamgate without stopping the new call", async () => {
    const f = fixture();
    await f.bridge.start({}, params(), () => true);
    f.setActive("foreign");
    f.clients[0].emit("notification", "thread/realtime/started", {
      threadId: "thread-1",
      realtimeSessionId: "foreign",
    });
    await f.bridge.dispose();
    expect(f.requests.some((r) => r.method === "thread/realtime/stop")).toBe(
      false,
    );
    expect(f.events.at(-1).message).toBe("Voice moved to another client");
  });

  test("connection replacement and agent identity changes cancel before starting voice", async () => {
    const stale = fixture();
    await expect(stale.bridge.start({}, params(), () => false)).rejects.toThrow(
      "connection changed",
    );
    expect(stale.requests).toHaveLength(0);
    const f = fixture();
    f.agent.agent = "claude";
    await expect(f.bridge.start({}, params(), () => true)).rejects.toThrow(
      "Select a Codex",
    );
    expect(f.requests).toHaveLength(0);
  });

  test("disabled and SSH connections do not contact the daemon", async () => {
    for (const f of [fixture({ enabled: false }), fixture({ local: false })]) {
      expect(await f.bridge.capabilities()).toEqual({ available: false });
      await expect(f.bridge.start({}, params(), () => true)).rejects.toThrow();
      expect(f.clients).toHaveLength(0);
    }
  });

  test("pane exit publishes an end and only stops the owned voice session", async () => {
    const f = fixture();
    await f.bridge.start({}, params(), () => true);
    await f.bridge.paneExited("unrelated");
    expect(f.requests.some((r) => r.method === "thread/realtime/stop")).toBe(
      false,
    );
    await f.bridge.paneExited("w1:p1");
    expect(f.events.at(-1).status).toBe("ended");
    expect(
      f.requests.filter((r) => r.method === "thread/realtime/stop"),
    ).toHaveLength(1);
  });
});
