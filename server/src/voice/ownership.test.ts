import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeVoiceSession } from "./ownership";

test("durable ownership survives transcript updates, closed calls, and replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "roamgate-voice-history-"));
  const path = join(dir, "rollout.jsonl");
  const item = (type: string, id: string) =>
    JSON.stringify({
      type: "realtime_item",
      payload: { type, realtime_session_id: id },
    }) + "\n";
  try {
    await writeFile(
      path,
      JSON.stringify({ type: "session_meta", payload: {} }) + "\n",
    );
    expect(await activeVoiceSession(path)).toBeNull();
    await writeFile(
      path,
      item("realtime_session_started", "mobile") +
        item("transcript_segment", "mobile"),
    );
    expect(await activeVoiceSession(path)).toBe("mobile");
    await writeFile(
      path,
      item("realtime_session_started", "mobile") +
        item("realtime_session_closed", "mobile"),
    );
    expect(await activeVoiceSession(path)).toBeNull();
    await writeFile(
      path,
      item("realtime_session_closed", "mobile") +
        item("realtime_session_started", "browser"),
    );
    expect(await activeVoiceSession(path)).toBe("browser");
    await writeFile(path, '{"type":"realtime_item"');
    await expect(activeVoiceSession(path)).rejects.toThrow("being updated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
