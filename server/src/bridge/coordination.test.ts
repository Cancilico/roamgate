import { afterEach, expect, test } from "bun:test";
import { createCoordinationHandler } from "./coordination";

const previous = process.env.COORDINATION_TEST_TOKEN;
afterEach(() => {
  if (previous === undefined) delete process.env.COORDINATION_TEST_TOKEN;
  else process.env.COORDINATION_TEST_TOKEN = previous;
});

function fixture() {
  process.env.COORDINATION_TEST_TOKEN = "private-test-credential";
  const item = {
    id: "item-1",
    hostId: "host",
    sessionKey: "key",
    sessionId: "session",
    provider: "claude",
    source: "explicit",
    version: 1,
    status: "pending",
    answer: null,
    delivery: null,
  };
  const peer = { sessionKey: "key", paneId: "pane", terminalId: "terminal" };
  let current = true;
  let agentStatus = "idle";
  let providerId = "session";
  let failDispatch = false;
  let replaceAfterClaim = false;
  const calls: { method: string; params: unknown }[] = [];
  const writes: Record<string, unknown>[] = [];
  const handler = createCoordinationHandler({
    connectionId: "connection",
    isCurrent: () => current,
    backend: () => ({
      url: "http://127.0.0.1:8790",
      host_id: "host",
      token_env: "COORDINATION_TEST_TOKEN",
    }),
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer private-test-credential",
      );
      if (!init?.body)
        return Response.json({
          hostId: "host",
          version: 1,
          items: [item],
          fleet: { fresh: true, sessions: [peer] },
        });
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (body.action === "prepare_delivery") {
        item.version++;
        item.answer = body.answer;
        item.delivery = { attemptId: "attempt", status: "sending" } as never;
        if (replaceAfterClaim) providerId = "replacement";
      }
      return Response.json(item);
    }) as typeof fetch,
    herdrCall: async (method, params) => {
      calls.push({ method, params });
      if (method === "agent.list")
        return {
          agents: [
            {
              agent: "claude",
              agent_session: { value: providerId },
              pane_id: "pane",
              terminal_id: "terminal",
              agent_status: agentStatus,
            },
          ],
        };
      if (failDispatch) throw new Error("Disconnected after dispatch");
      return { prompted: true };
    },
  });
  return {
    handler,
    calls,
    writes,
    item,
    stale: () => {
      current = false;
    },
    block: () => {
      agentStatus = "blocked";
    },
    replace: () => {
      replaceAfterClaim = true;
    },
    fail: () => {
      failDispatch = true;
    },
  };
}

test("reply checks provider identity twice and records confirmed delivery", async () => {
  const f = fixture();
  expect(
    await f.handler("coordination.send", {
      id: "item-1",
      expected_version: 1,
      answer: "Option A",
    }),
  ).toEqual({ status: "sent" });
  expect(f.calls.map((c) => c.method)).toEqual([
    "agent.list",
    "agent.list",
    "agent.prompt",
  ]);
  expect(f.writes.at(-1)?.result).toBe("sent");
});

test("blocked or retired sessions receive no prompt or delivery claim", async () => {
  const blocked = fixture();
  blocked.block();
  await expect(
    blocked.handler("coordination.send", {
      id: "item-1",
      expected_version: 1,
      answer: "yes",
    }),
  ).rejects.toThrow("idle");
  expect(blocked.writes).toHaveLength(0);
  const stale = fixture();
  stale.stale();
  await expect(
    stale.handler("coordination.send", {
      id: "item-1",
      expected_version: 1,
      answer: "yes",
    }),
  ).rejects.toThrow("Connection changed");
  expect(stale.calls).toHaveLength(0);
});

test("pane reuse after claiming delivery cannot send to a replacement agent", async () => {
  const f = fixture();
  f.replace();
  await expect(
    f.handler("coordination.send", {
      id: "item-1",
      expected_version: 1,
      answer: "yes",
    }),
  ).rejects.toThrow("session changed");
  expect(f.calls.some((c) => c.method === "agent.prompt")).toBe(false);
  expect(f.writes.at(-1)?.result).toBe("failed");
});

test("transport errors after dispatch stay uncertain and are not retried", async () => {
  const f = fixture();
  f.fail();
  await expect(
    f.handler("coordination.send", {
      id: "item-1",
      expected_version: 1,
      answer: "yes",
    }),
  ).rejects.toThrow();
  expect(f.calls.filter((c) => c.method === "agent.prompt")).toHaveLength(1);
  expect(f.writes.at(-1)?.result).toBe("unknown");
});

test("unconfigured connections never fall back to a local backend", async () => {
  const handler = createCoordinationHandler({
    connectionId: "remote",
    backend: () => null,
    isCurrent: () => true,
    herdrCall: async () => {
      throw Error("unexpected");
    },
  });
  expect(await handler("coordination.snapshot")).toEqual({ enabled: false });
  await expect(handler("coordination.send", {})).rejects.toThrow(
    "not configured",
  );
});

test("wrong backend host and native dialogs are rejected", async () => {
  const f = fixture();
  f.item.source = "native";
  await expect(
    f.handler("coordination.send", { id: "item-1", expected_version: 1 }),
  ).rejects.toThrow("original session");
  const handler = createCoordinationHandler({
    connectionId: "remote",
    backend: () => ({
      url: "http://127.0.0.1:8790",
      host_id: "other",
      token_env: "COORDINATION_TEST_TOKEN",
    }),
    isCurrent: () => true,
    herdrCall: async () => null,
    fetchImpl: async () => Response.json({ hostId: "wrong" }),
  });
  await expect(handler("coordination.snapshot")).rejects.toThrow(
    "host does not match",
  );
});
