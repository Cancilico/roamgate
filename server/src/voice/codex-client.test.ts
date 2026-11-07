import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexClient } from "./codex-client";

test("Unix WebSocket client initializes, separates notifications from replies, and never answers approval requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "roamgate-codex-ws-"));
  const path = join(dir, "daemon.sock");
  const received: any[] = [];
  const server = Bun.serve({
    unix: path,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const request = JSON.parse(raw.toString());
        received.push(request);
        if (request.method === "initialize") {
          ws.send(JSON.stringify({ id: request.id, result: {} }));
          return;
        }
        if (request.method === "initialized") return;
        if (request.method === "test/error") {
          ws.send(
            JSON.stringify({
              id: request.id,
              error: { message: "private provider diagnostic" },
            }),
          );
          return;
        }
        if (request.method === "test/hold") {
          ws.close();
          return;
        }
        ws.send(
          JSON.stringify({
            method: "thread/realtime/started",
            params: { threadId: "test" },
          }),
        );
        ws.send(
          JSON.stringify({
            id: request.id,
            method: "item/commandExecution/requestApproval",
            params: {},
          }),
        );
        ws.send(JSON.stringify({ id: request.id, result: { ok: true } }));
      },
    },
  });
  const client = new CodexClient(path);
  const notifications: string[] = [];
  client.on("notification", (method) => notifications.push(method));
  try {
    await client.connect();
    expect(await client.request("test/read", {})).toEqual({ ok: true });
    expect(received[0]).toMatchObject({
      method: "initialize",
      params: { capabilities: { experimentalApi: true } },
    });
    expect(notifications).toEqual(["thread/realtime/started"]);
    expect(received.some((m) => m.method === undefined)).toBe(false);
    await expect(client.request("test/error", {})).rejects.toThrow(
      "Codex voice API request failed: test/error",
    );
    await expect(client.request("test/hold", {})).rejects.toThrow(
      "disconnected",
    );
  } finally {
    client.close();
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
