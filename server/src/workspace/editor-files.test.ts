import { expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  EDITOR_MAX_BYTES,
  type EditorDocument,
  type EditorWrite,
} from "../../../shared/fileEditor";
import {
  decodeEditorDocument,
  editorPath,
  readEditorFile,
  writeEditorFile,
} from "./editor-files";
import { runProcessWithInputTimeout } from "./process";
import remoteSource from "./editor-remote.py" with { type: "text" };
import { createFileHandlers } from "./files";
import type { HerdrClient } from "../bridge/herdr-client";
import { shQuote } from "../utils/process-utils";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "roamgate-editor-")),
  );
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function remote(operation: string, params: object) {
  const result = await runProcessWithInputTimeout(
    ["python3", "-c", remoteSource],
    JSON.stringify({ ...params, operation }),
    5000,
  );
  expect(result.code).toBe(0);
  const reply = JSON.parse(result.stdout);
  if (reply.error)
    throw Object.assign(new Error(reply.error.message), {
      code: reply.error.code,
    });
  return reply.result;
}
const backends = [
  { name: "local", read: readEditorFile, write: writeEditorFile },
  {
    name: "SSH helper",
    read: (path: string): Promise<EditorDocument> => remote("read", { path }),
    write: (params: EditorWrite): Promise<EditorDocument> =>
      remote("write", params),
  },
];
const replacement = (doc: EditorDocument, text: string): EditorWrite => ({
  ...doc,
  text,
  expected_revision: doc.revision,
});
for (const backend of backends) {
  test(`${backend.name}: preserves BOM, CRLF, permissions and final-newline absence`, () =>
    fixture(async (root) => {
      const path = join(root, "space ' $() `name` 日本.md");
      await writeFile(path, "\ufefffirst\r\nsecond");
      await chmod(path, 0o640);
      const document = await backend.read(path);
      expect(document).toMatchObject({
        text: "first\nsecond",
        bom: true,
        newline: "crlf",
      });
      const saved = await backend.write(
        replacement(document, "first\nchanged"),
      );
      expect(await readFile(path, "utf8")).toBe("\ufefffirst\r\nchanged");
      expect((await stat(path)).mode & 0o777).toBe(0o640);
      expect(saved.revision).not.toBe(document.revision);
      expect(await readdir(root)).toEqual([path.slice(root.length + 1)]);
    }));
  test(`${backend.name}: two saves of one revision cannot both succeed`, () =>
    fixture(async (root) => {
      const path = join(root, "file.txt");
      await writeFile(path, "original");
      const document = await backend.read(path);
      const results = await Promise.allSettled([
        backend.write(replacement(document, "one")),
        backend.write(replacement(document, "two")),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    }));
  test(`${backend.name}: changed and deleted files do not lose data`, () =>
    fixture(async (root) => {
      const path = join(root, "file.txt");
      await writeFile(path, "original");
      const document = await backend.read(path);
      await writeFile(path, "agent edit");
      await expect(
        backend.write(replacement(document, "my edit")),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await readFile(path, "utf8")).toBe("agent edit");
      await unlink(path);
      await expect(
        backend.write(replacement(document, "my edit")),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }));
  test(`${backend.name}: create-only saves reject existing destinations and missing parents`, () =>
    fixture(async (root) => {
      const params: EditorWrite = {
        path: join(root, "new.txt"),
        text: "new",
        expected_revision: null,
        bom: false,
        newline: "lf",
      };
      await backend.write(params);
      await expect(
        backend.write({ ...params, text: "overwrite" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await readFile(params.path, "utf8")).toBe("new");
      await expect(
        backend.write({ ...params, path: join(root, "absent", "new.txt") }),
      ).rejects.toThrow();
    }));
  test(`${backend.name}: save follows symlinks without replacing them; retargeting conflicts`, () =>
    fixture(async (root) => {
      const target = join(root, "target"),
        path = join(root, "link"),
        other = join(root, "other");
      await writeFile(target, "original");
      await writeFile(other, "other");
      await symlink(target, path);
      let document = await backend.read(path);
      await backend.write(replacement(document, "saved"));
      expect((await lstat(path)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, "utf8")).toBe("saved");
      document = await backend.read(path);
      await unlink(path);
      await symlink(other, path);
      await expect(
        backend.write(replacement(document, "bad")),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await readFile(other, "utf8")).toBe("other");
    }));
  test(`${backend.name}: rejects binary, oversized, mixed endings, and hard-linked saves`, () =>
    fixture(async (root) => {
      const path = join(root, "file");
      for (const content of [
        Buffer.from([0xff]),
        Buffer.from([0]),
        Buffer.from("a\r\nb\nc"),
        Buffer.alloc(EDITOR_MAX_BYTES + 1, 65),
      ]) {
        await writeFile(path, content);
        await expect(backend.read(path)).rejects.toMatchObject({
          code: "NOT_EDITABLE",
        });
      }
      await writeFile(path, "text");
      await link(path, join(root, "hardlink"));
      const document = await backend.read(path);
      await expect(
        backend.write(replacement(document, "change")),
      ).rejects.toMatchObject({ code: "NOT_EDITABLE" });
      expect(await readFile(path, "utf8")).toBe("text");
    }));
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    `${backend.name}: read-only destinations and special files stay unchanged`,
    () =>
      fixture(async (root) => {
        const path = join(root, "readonly");
        await writeFile(path, "original");
        await chmod(path, 0o400);
        const document = await backend.read(path);
        await expect(
          backend.write(replacement(document, "overwrite")),
        ).rejects.toMatchObject({ code: "EACCES" });
        expect(await readFile(path, "utf8")).toBe("original");
        expect(await readdir(root)).toEqual(["readonly"]);
        const pipe = join(root, "fifo");
        expect(await Bun.spawn(["mkfifo", pipe]).exited).toBe(0);
        await expect(backend.read(pipe)).rejects.toMatchObject({
          code: "NOT_EDITABLE",
        });
      }),
  );
  test(`${backend.name}: invalid writes never change the destination`, () =>
    fixture(async (root) => {
      const path = join(root, "file");
      await writeFile(path, "original");
      const document = await backend.read(path);
      for (const text of [
        "bad\0text",
        "bad\rtext",
        "x".repeat(EDITOR_MAX_BYTES + 1),
      ]) {
        await expect(
          backend.write(replacement(document, text)),
        ).rejects.toThrow();
      }
      expect(await readFile(path, "utf8")).toBe("original");
      expect(await readdir(root)).toEqual(["file"]);
    }));
}
test("paths resolve home and explicit directory; relative paths need context", () => {
  expect(editorPath("~/a")).toBe(join(homedir(), "a"));
  expect(editorPath("../b", "/tmp/a")).toBe("/tmp/b");
  expect(() => editorPath("relative")).toThrow("absolute path");
  expect(() => editorPath("/tmp/\0")).toThrow();
  expect(decodeEditorDocument(Buffer.from("last\n")).text).toBe("last\n");
});
test("host list, read, download, and editor calls work without querying a workspace", () =>
  fixture(async (root) => {
    const path = join(root, "outside.txt");
    await writeFile(path, "outside");
    const handlers = createFileHandlers({
      herdr: {
        call: async () => {
          throw new Error("Workspace lookup is forbidden");
        },
      } as unknown as HerdrClient,
      sshHost: () => undefined,
      shQuote,
      runProcessWithCodeTimeout: async () => {
        throw new Error("Unexpected SSH");
      },
    });
    expect(
      (await handlers.listWorkspaceFiles({ scope: "filesystem", path: root }))
        .entries[0].path,
    ).toBe(path);
    expect(
      (await handlers.readWorkspaceFile({ scope: "filesystem", path })).text,
    ).toBe("outside");
    const download = await handlers.downloadWorkspaceFile({
      scope: "filesystem",
      path,
    });
    expect(download).toBeDefined();
    expect(await handlers.editorOperation("read", { path })).toMatchObject({
      ok: true,
      result: { text: "outside" },
    });
    expect(
      await handlers.editorOperation("read", { path: join(root, "missing") }),
    ).toMatchObject({ ok: false, error: { code: "ENOENT" } });
  }));
