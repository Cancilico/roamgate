import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Read only the durable voice lifecycle, never materialize the transcript. */
export async function activeVoiceSession(path: string): Promise<string | null> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let active: string | null = null;
  let bytes = 0;
  const started = Date.now();
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line);
      if (bytes > 128 * 1024 * 1024 || Date.now() - started > 10_000)
        throw new Error(
          "Cannot verify voice ownership in this session's history",
        );
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        throw new Error(
          "Session history is being updated; retry voice shortly",
        );
      }
      if (item.type !== "realtime_item") continue;
      const payload = item.payload;
      if (!payload || typeof payload.realtime_session_id !== "string")
        throw new Error("Unrecognized Codex voice history format");
      active =
        payload.type === "realtime_session_closed"
          ? null
          : payload.realtime_session_id;
    }
    return active;
  } finally {
    lines.close();
    stream.destroy();
  }
}
