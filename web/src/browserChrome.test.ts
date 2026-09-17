import { expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForChromePort } from "./browserChrome";

test("Chrome readiness tolerates slow startup and an incomplete port file", async () => {
  const profile = mkdtempSync(join(tmpdir(), "chrome-startup-test-"));
  const portFile = join(profile, "DevToolsActivePort");
  jest.useFakeTimers();
  try {
    const ready = waitForChromePort(
      { exitCode: null },
      profile,
      join(profile, "stderr"),
    );
    jest.advanceTimersByTime(6000);
    await Promise.resolve();
    writeFileSync(portFile, "9222\n");
    jest.advanceTimersByTime(25);
    await Promise.resolve();
    writeFileSync(portFile, "9222\n/devtools/browser/test");
    jest.advanceTimersByTime(25);
    expect(await ready).toBe("9222");
  } finally {
    jest.useRealTimers();
    rmSync(profile, { recursive: true, force: true });
  }
});

test.each(["exit", "timeout"])(
  "Chrome startup %s includes stderr instead of a missing-file error",
  async (failure) => {
    const profile = mkdtempSync(join(tmpdir(), "chrome-startup-test-"));
    const errorOutput = join(profile, "stderr");
    writeFileSync(errorOutput, "browser startup diagnostic");
    jest.useFakeTimers();
    try {
      const child = { exitCode: null as number | null };
      const ready = waitForChromePort(child, profile, errorOutput);
      if (failure === "exit") child.exitCode = 1;
      jest.advanceTimersByTime(failure === "exit" ? 25 : 20000);
      await expect(ready).rejects.toThrow(
        failure === "exit"
          ? "Chrome exited during startup (1)\nbrowser startup diagnostic"
          : "Chrome did not expose its debugging endpoint within 20 seconds\nbrowser startup diagnostic",
      );
    } finally {
      jest.useRealTimers();
      rmSync(profile, { recursive: true, force: true });
    }
  },
);
