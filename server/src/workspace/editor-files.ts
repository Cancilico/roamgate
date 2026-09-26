import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  open,
  realpath,
  rename,
  link,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  EDITOR_MAX_BYTES,
  type EditorDocument,
  type EditorWrite,
} from "../../../shared/fileEditor";
import { sshCommandArgv } from "../bridge/ssh-command";
import { runProcessWithInputTimeout } from "./process";
import remoteEditorSource from "./editor-remote.py" with { type: "text" };

export class FileEditorError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (code: string, message: string): never => {
  throw new FileEditorError(code, message);
};
export function editorPath(path: unknown, base?: string): string {
  if (typeof path !== "string" || !path || path.includes("\0"))
    return fail("INVALID_PATH", "A file path is required.");
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (!isAbsolute(path) && !base)
    return fail(
      "INVALID_PATH",
      "Use an absolute path or select a directory first.",
    );
  return resolve(base ?? homedir(), path);
}
function revision(
  bytes: Buffer,
  info: { dev: number; ino: number; mode: number; uid: number; gid: number },
) {
  return createHash("sha256")
    .update(`${info.dev}:${info.ino}:${info.mode}:${info.uid}:${info.gid}:`)
    .update(bytes)
    .digest("hex");
}
export function decodeEditorDocument(
  bytes: Buffer,
): Pick<EditorDocument, "text" | "bom" | "newline"> {
  if (bytes.length > EDITOR_MAX_BYTES)
    return fail("NOT_EDITABLE", "Editing is limited to 2 MiB.");
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bom ? bytes.subarray(3) : bytes,
    );
  } catch {
    return fail("NOT_EDITABLE", "Only UTF-8 text files can be edited.");
  }
  if (text.includes("\0"))
    return fail("NOT_EDITABLE", "Binary files cannot be edited.");
  const withoutCRLF = text.replace(/\r\n/g, "");
  if (
    withoutCRLF.includes("\r") ||
    (text.includes("\r\n") && withoutCRLF.includes("\n"))
  )
    return fail("NOT_EDITABLE", "Mixed or legacy line endings are read only.");
  return {
    text: text.replace(/\r\n/g, "\n"),
    bom,
    newline: text.includes("\r\n") ? "crlf" : "lf",
  };
}
export function encodeEditorDocument(params: EditorWrite): Buffer {
  if (
    typeof params.text !== "string" ||
    typeof params.bom !== "boolean" ||
    !["lf", "crlf"].includes(params.newline)
  )
    return fail("INVALID_CONTENT", "Invalid editor document.");
  if (
    params.text.includes("\0") ||
    params.text.includes("\r") ||
    !params.text.isWellFormed()
  )
    return fail("INVALID_CONTENT", "Invalid UTF-8 text or line endings.");
  const bytes = Buffer.from(
    (params.bom ? "\ufeff" : "") +
      (params.newline === "crlf"
        ? params.text.replace(/\n/g, "\r\n")
        : params.text),
  );
  if (bytes.length > EDITOR_MAX_BYTES)
    return fail("NOT_EDITABLE", "Editing is limited to 2 MiB.");
  return bytes;
}
async function readSnapshot(path: string) {
  const canonical = await realpath(path);
  const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile())
      return fail("NOT_EDITABLE", "Only regular files can be edited.");
    if (info.size > EDITOR_MAX_BYTES)
      return fail("NOT_EDITABLE", "Editing is limited to 2 MiB.");
    const buffer = Buffer.alloc(EDITOR_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const decoded = decodeEditorDocument(bytes);
    return {
      info,
      document: {
        path,
        canonical_path: canonical,
        revision: revision(bytes, info),
        ...decoded,
      },
    };
  } finally {
    await file.close();
  }
}
export async function readEditorFile(path: string): Promise<EditorDocument> {
  return (await readSnapshot(path)).document;
}
const writes = new Map<string, Promise<unknown>>();
async function serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = writes.get(key) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(action);
  writes.set(key, result);
  try {
    return await result;
  } finally {
    if (writes.get(key) === result) writes.delete(key);
  }
}
export async function writeEditorFile(
  params: EditorWrite,
): Promise<EditorDocument> {
  const bytes = encodeEditorDocument(params);
  if (
    params.expected_revision !== null &&
    (typeof params.expected_revision !== "string" ||
      typeof params.canonical_path !== "string")
  )
    return fail(
      "INVALID_REVISION",
      "A revision and canonical path are required to replace a file.",
    );
  const path = editorPath(params.path);
  const target =
    params.expected_revision === null
      ? join(await realpath(dirname(path)), basename(path))
      : params.canonical_path!;
  return serialize(target, async () => {
    const check = async () => {
      if (params.expected_revision === null) {
        if ((await realpath(dirname(path))) !== dirname(target))
          return fail("CONFLICT", "The destination directory changed.");
        try {
          await lstat(path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw e;
        }
        return fail("CONFLICT", "The destination already exists.");
      }
      let snapshot;
      try {
        snapshot = await readSnapshot(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          return fail(
            "CONFLICT",
            "The file was removed or its link target changed.",
          );
        throw e;
      }
      if (
        snapshot.document.canonical_path !== params.canonical_path ||
        snapshot.document.revision !== params.expected_revision
      )
        return fail(
          "CONFLICT",
          "The file changed on disk. Compare or reload it before saving.",
        );
      if (snapshot.info.nlink > 1)
        return fail(
          "NOT_EDITABLE",
          "Saving files with multiple hard links is not supported.",
        );
      await access(target, constants.W_OK);
      return snapshot.info;
    };
    const info = await check();
    const temporary = join(dirname(target), `.roamgate-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", info ? 0o600 : 0o666);
      try {
        await file.writeFile(bytes);
        if (info) {
          const tempInfo = await file.stat();
          if (info.uid !== tempInfo.uid || info.gid !== tempInfo.gid)
            await file.chown(info.uid, info.gid);
          await file.chmod(info.mode & 0o7777);
        }
        await file.sync();
      } finally {
        await file.close();
      }
      await check();
      if (params.expected_revision === null) {
        try {
          await link(temporary, target);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST")
            return fail("CONFLICT", "The destination already exists.");
          throw e;
        }
      } else await rename(temporary, target);
      return await readEditorFile(path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  });
}
export async function remoteEditor(
  host: string,
  operation: "path" | "read" | "write",
  params: Record<string, unknown>,
  shQuote: (s: string) => string,
): Promise<any> {
  // Only the bundled program is a shell argument. Paths/content travel as JSON stdin.
  let reply;
  try {
    const result = await runProcessWithInputTimeout(
      sshCommandArgv(host, `python3 -c ${shQuote(remoteEditorSource)}`),
      JSON.stringify({ ...params, operation }),
      30000,
    );
    if (result.code !== 0)
      throw new Error(
        result.stderr.trim() ||
          "SSH file editing requires Python 3 on the connected host.",
      );
    reply = JSON.parse(result.stdout);
  } catch (error) {
    throw new FileEditorError("REMOTE_ERROR", (error as Error).message);
  }
  if (reply.error)
    throw new FileEditorError(reply.error.code, reply.error.message);
  return reply.result;
}
