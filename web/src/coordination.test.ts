import { expect, test } from "bun:test";
import {
  canSendQueueItem,
  parseCoordinationSnapshot,
  queueItemOpen,
  type QueueItem,
} from "./coordination";

const item: QueueItem = {
  id: "id",
  sessionKey: "key",
  sessionId: "session",
  provider: "codex",
  kind: "question",
  ask: "Choose",
  howTo: "",
  cwd: "/repo",
  repository: "/repo/.git",
  source: "explicit",
  status: "pending",
  answer: null,
  version: 1,
  createdAt: "2026-10-04",
  delivery: null,
};
const fleet = {
  fresh: true,
  generatedAt: null,
  sessions: [
    {
      sessionKey: "key",
      sessionId: "session",
      provider: "codex",
      paneId: "pane",
      name: "test",
      task: null,
      cwd: "/repo",
      checkout: "/repo",
      repository: "/repo/.git",
      branch: "feature",
      status: "idle",
      sharedCheckout: false,
      observedAt: null,
    },
  ],
};

test("send controls require a fresh idle matching session and an unsent explicit request", () => {
  expect(canSendQueueItem(item, fleet)).toBe(true);
  expect(canSendQueueItem({ ...item, source: "native" }, fleet)).toBe(false);
  expect(canSendQueueItem(item, { ...fleet, fresh: false })).toBe(false);
  expect(
    canSendQueueItem(
      { ...item, delivery: { attemptId: "a", status: "unknown" } },
      fleet,
    ),
  ).toBe(false);
  expect(canSendQueueItem(item, { ...fleet, sessions: [] })).toBe(false);
});
test("completed handoffs remain visible for explicit resume", () => {
  expect(queueItemOpen({ ...item, status: "resolved" })).toBe(true);
  expect(
    queueItemOpen({
      ...item,
      status: "resolved",
      delivery: { status: "sent", attemptId: "a" },
    }),
  ).toBe(false);
  expect(queueItemOpen({ ...item, status: "dismissed" })).toBe(false);
});
test("snapshot parsing rejects malformed data and handles disabled connections", () => {
  expect(parseCoordinationSnapshot({ enabled: false }).items).toEqual([]);
  expect(
    parseCoordinationSnapshot({
      enabled: true,
      version: 1,
      items: [item],
      fleet,
    }).items,
  ).toHaveLength(1);
  expect(() =>
    parseCoordinationSnapshot({
      enabled: true,
      version: 1,
      items: [{ ...item, ask: {} }],
      fleet,
    }),
  ).toThrow();
});
