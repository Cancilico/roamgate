import { expect, test } from "bun:test";
import { publishFileSaved, subscribeFileSaved } from "./fileEditorSaved";
import type { ConnectionClient } from "./api";
test("save notifications refresh only the same connection, generation and file", () => {
  let current = true,
    refreshed = 0;
  const client = {
    connectionId: "a",
    generation: 2,
    isCurrent: () => current,
  } as ConnectionClient;
  const document = {
    path: "/link",
    canonical_path: "/file",
    text: "saved",
    revision: "r",
    bom: false,
    newline: "lf" as const,
  };
  const dispose = subscribeFileSaved(client, "/file", () => refreshed++);
  publishFileSaved({ ...client, connectionId: "b" }, document);
  publishFileSaved({ ...client, generation: 3 }, document);
  publishFileSaved(client, {
    ...document,
    path: "/other",
    canonical_path: "/other",
  });
  expect(refreshed).toBe(0);
  publishFileSaved(client, document);
  expect(refreshed).toBe(1);
  current = false;
  publishFileSaved(client, document);
  expect(refreshed).toBe(1);
  current = true;
  dispose();
  publishFileSaved(client, document);
  expect(refreshed).toBe(1);
});
