import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const MAX_NATIVE_CODEX_COPY_BYTES = 100_000;
const X11_CLIPBOARD_READER = [
  "import sys, tkinter as tk",
  "root = tk.Tk()",
  "root.withdraw()",
  "try:",
  "    value = root.clipboard_get()",
  "finally:",
  "    root.destroy()",
  'sys.stdout.buffer.write(value.encode("utf-8"))',
].join("\n");

/** Read only after an attached local terminal confirms an explicit Codex copy. */
export async function readNativeCodexClipboard(): Promise<string> {
  if (!process.env.DISPLAY) throw new Error("X11 display is unavailable");
  const { stdout } = await execFileAsync(
    "python3",
    ["-c", X11_CLIPBOARD_READER],
    {
      env: process.env,
      encoding: "buffer",
      timeout: 2_000,
      maxBuffer: MAX_NATIVE_CODEX_COPY_BYTES + 1,
    },
  );
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (bytes.length === 0) throw new Error("X11 clipboard is empty");
  if (bytes.length > MAX_NATIVE_CODEX_COPY_BYTES) {
    throw new Error("X11 clipboard exceeds the 100,000-byte limit");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
