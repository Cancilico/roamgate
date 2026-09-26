import type { ConnectionClient } from "./api";
import { expect, test } from "bun:test";
import {
  confirmsEditorWrite,
  editorLeaseChanged,
  editorBufferDirty,
  type EditorBuffer,
} from "./fileEditorState";
import {
  guardFileEditorNavigation,
  registerFileEditorGuard,
  openHostFile,
  subscribeFileEditorRequests,
} from "./fileEditorNavigation";
const document = {
  path: "/tmp/link",
  canonical_path: "/tmp/file",
  text: "original",
  revision: "v1",
  newline: "lf" as const,
  bom: false,
};
const buffer: EditorBuffer = {
  key: 1,
  document,
  path: document.path,
  text: document.text,
  initialText: document.text,
};
test("new files, edits and undo have the correct unsaved status", () => {
  expect(editorBufferDirty(null)).toBe(false);
  expect(editorBufferDirty(buffer)).toBe(false);
  expect(editorBufferDirty({ ...buffer, document: null, text: "" })).toBe(true);
  expect(editorBufferDirty({ ...buffer, text: "edit" })).toBe(true);
  expect(
    editorBufferDirty({ ...buffer, initialText: "earlier revision" }),
  ).toBe(false);
});
test("connection navigation waits for the editor's save/discard choice", () => {
  let pending: (() => void) | undefined;
  let navigated = false;
  const dispose = registerFileEditorGuard((next) => {
    pending = next;
    return false;
  });
  try {
    expect(
      guardFileEditorNavigation(() => {
        navigated = true;
      }),
    ).toBe(false);
    expect(navigated).toBe(false);
    pending?.();
    expect(navigated).toBe(true);
  } finally {
    dispose();
  }
  expect(guardFileEditorNavigation(() => {})).toBe(true);
});
test("opening a file before the lazy panel loads queues the request", () => {
  openHostFile({ path: "/tmp/first" });
  let received = "";
  const dispose = subscribeFileEditorRequests((request) => {
    received = request.path ?? "";
  });
  try {
    expect(received).toBe("/tmp/first");
    openHostFile({ path: "/tmp/second" });
    expect(received).toBe("/tmp/second");
  } finally {
    dispose();
  }
});
test("a lost save reply requires matching content, encoding, and target", () => {
  const sent = { ...document, expected_revision: document.revision };
  expect(confirmsEditorWrite({ ...document, revision: "v2" }, sent)).toBe(true);
  expect(confirmsEditorWrite({ ...document, text: "agent edit" }, sent)).toBe(
    false,
  );
  expect(confirmsEditorWrite({ ...document, bom: true }, sent)).toBe(false);
  expect(
    confirmsEditorWrite({ ...document, canonical_path: "/tmp/other" }, sent),
  ).toBe(false);
  expect(confirmsEditorWrite(document, { ...sent, newline: "crlf" })).toBe(
    true,
  );
  expect(
    confirmsEditorWrite(
      { ...document, text: "a\nb" },
      { ...sent, text: "a\nb", newline: "crlf" },
    ),
  ).toBe(false);
});

test("editor reconnect state follows lease identity, even before the runtime catalog settles", () => {
  const before = {
    connectionId: "a",
    generation: 1,
    serverRuntimeGeneration: 2,
    isCurrent: () => false,
  } as ConnectionClient;
  const reconnected = { ...before, generation: 2 };
  expect(editorLeaseChanged(before, reconnected)).toBe(true);
  // Readiness can become true without a new catalog object or React render.
  // Explicit rebind removes the stale UI; RPCs still validate readiness.
  expect(editorLeaseChanged(reconnected, reconnected)).toBe(false);
  expect(
    editorLeaseChanged(reconnected, { ...reconnected, connectionId: "b" }),
  ).toBe(true);
  expect(
    editorLeaseChanged(reconnected, {
      ...reconnected,
      serverRuntimeGeneration: 3,
    }),
  ).toBe(true);
});
