import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHistory, historyOid } from "./git-history";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import type {
  HistoryPage,
  HistorySnapshot,
  HistoryDetails,
  HistorySearch,
} from "../../../shared/gitHistory";
import type { GitDiffFile, FilePreview } from "../../../web/src/types";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function git(root: string, ...args: string[]) {
  const result = await runProcessWithCodeTimeout(
    ["git", "-C", root, ...args],
    10000,
  );
  if (result.code) throw new Error(result.stderr);
  return result.stdout.trim();
}
async function repo(count = 0) {
  const root = await mkdtemp(join(tmpdir(), "roamgate-history-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "History Tester");
  await git(root, "config", "user.email", "history@example.com");
  if (count) {
    const records = Array.from({ length: count }, (_, i) => {
      const message = `History commit ${i}`;
      const content = `line ${i}\n`;
      return `commit refs/heads/main\ncommitter History Tester <history@example.com> ${1700000000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}\nM 100644 inline history.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;
    }).join("");
    const process = Bun.spawn(["git", "-C", root, "fast-import", "--quiet"], {
      stdin: Buffer.from(records),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(process.stderr).text();
    if (await process.exited) throw new Error(stderr);
    await git(root, "reset", "--hard", "HEAD");
  }
  const history = createGitHistory({
    root,
    workspaceId: "w1",
    shQuote,
    runProcessWithCodeTimeout,
  });
  const call = <T>(method: string, params: Record<string, unknown> = {}) =>
    history(`git.history.${method}`, params) as Promise<T>;
  return { root, call };
}
async function commit(root: string, message: string) {
  await git(root, "add", "--all");
  await git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}
describe("read-only Git history", () => {
  test("scrolls past 1000 commits without duplicate rows and pins refs until refresh", async () => {
    const { root, call } = await repo(1050);
    const initial = await call<HistoryPage>("page");
    expect(initial.commits.length).toBe(200);
    expect(initial.next).toBe(200);
    await writeFile(join(root, "new.txt"), "new");
    await commit(root, "A concurrent commit");
    const all = [...initial.commits];
    let offset = initial.next;
    while (offset !== null) {
      const page = await call<HistoryPage>("page", {
        snapshot: initial.snapshot,
        offset,
      });
      all.push(...page.commits);
      offset = page.next;
    }
    expect(all.length).toBe(1050);
    expect(new Set(all.map((item) => item.oid)).size).toBe(1050);
    expect(all.at(-1)?.subject).toBe("History commit 0");
    const refreshed = await call<HistoryPage>("page");
    expect(refreshed.commits[0]?.subject).toBe("A concurrent commit");
    const details = await call<HistoryDetails>("details", { oid: all[0]!.oid });
    expect(details.author).toBe("History Tester");
    expect(details.body).toBe("History commit 1049");
  });
  test("searches all history literally by author/message/hash and reveals exact position", async () => {
    const { call } = await repo(450);
    const { snapshot } = await call<HistoryPage>("page");
    const found = await call<HistorySearch>("search", {
      snapshot,
      query: "History commit 42",
    });
    expect(found.matches.length).toBeGreaterThan(0);
    expect(
      found.matches.some((item) => item.commit.subject === "History commit 42"),
    ).toBe(true);
    const target = found.matches.find(
      (item) => item.commit.subject === "History commit 42",
    )!;
    expect(target.offset).toBe(407);
    expect(
      await call<{ offset: number | null }>("locate", {
        snapshot,
        oid: target.commit.oid,
      }),
    ).toEqual({
      offset: 407,
    });
    const author = await call<HistorySearch>("search", {
      snapshot,
      query: "history tester",
    });
    expect(author.matches.length).toBe(100);
    expect(author.next).toBe(100);
    const more = await call<HistorySearch>("search", {
      snapshot,
      query: "history tester",
      offset: author.next,
    });
    expect(more.matches[0]!.offset).toBe(100);
    expect(
      (
        await call<HistorySearch>("search", {
          snapshot,
          query: "$(touch /tmp/should-not-exist) [.*]",
        })
      ).matches,
    ).toEqual([]);
    expect(
      (
        await call<HistorySearch>("search", {
          snapshot,
          query: target.commit.oid.slice(0, 12),
        })
      ).matches[0]?.commit.oid,
    ).toBe(target.commit.oid);
  });
  test("handles root, rename, deletion, binary images and direct tree comparison without changing checkout", async () => {
    const { root, call } = await repo();
    const old = "a space\tquote'\\backslash\n.txt";
    const renamed = "renamed space\n.txt";
    const image = Buffer.from("89504e470d0a1a0a0000010200", "hex");
    await writeFile(join(root, old), "old text\n");
    await writeFile(join(root, "image.png"), image);
    const first = await commit(root, "Root commit");
    const firstSummary = await call<{ entries: { path: string }[] }>(
      "diff_summary",
      { base: null, target: first },
    );
    expect(firstSummary.entries.map((e) => e.path)).toContain(old);
    const rootPatch = await call<GitDiffFile>("diff_file", {
      base: null,
      target: first,
      path: old,
    });
    expect(rootPatch.diff).toContain("+old text");
    await git(root, "mv", old, renamed);
    const second = await commit(root, "Rename");
    const rename = await call<{
      entries: { path: string; old_path: string; status: string }[];
    }>("diff_summary", { base: first, target: second });
    expect(rename.entries[0]).toMatchObject({
      path: renamed,
      old_path: old,
      status: "renamed",
    });
    expect(
      (
        await call<GitDiffFile>("diff_file", {
          base: first,
          target: second,
          path: renamed,
          old_path: old,
        })
      ).diff,
    ).toContain("rename from");
    await rm(join(root, renamed));
    const third = await commit(root, "Delete");
    expect(
      (
        await call<GitDiffFile>("diff_file", {
          base: second,
          target: third,
          path: renamed,
        })
      ).diff,
    ).toContain("-old text");
    await writeFile(join(root, "image.png"), "working tree content");
    const before = await git(root, "status", "--porcelain");
    const preview = await call<FilePreview>("image", {
      oid: first,
      path: "image.png",
    });
    expect(preview.image_data_url).toBe(
      `data:image/png;base64,${image.toString("base64")}`,
    );
    const patch = await call<GitDiffFile>("diff_file", {
      base: first,
      target: third,
      path: old,
    });
    expect(patch.history).toEqual({ base: first, target: third });
    expect(await git(root, "status", "--porcelain")).toBe(before);
    expect(await readFile(join(root, "image.png"), "utf8")).toBe(
      "working tree content",
    );
  });
  test("returns branch, remote, annotated tag and detached HEAD refs and merge parents", async () => {
    const { root, call } = await repo(1);
    const first = await git(root, "rev-parse", "HEAD");
    await git(root, "checkout", "-b", "feature");
    await writeFile(join(root, "feature.txt"), "feature");
    const feature = await commit(root, "Feature");
    await git(root, "checkout", "main");
    await writeFile(join(root, "main.txt"), "main");
    const main = await commit(root, "Main");
    await git(root, "merge", "--no-ff", "feature", "-m", "Merge feature");
    const merge = await git(root, "rev-parse", "HEAD");
    await git(root, "tag", "-a", "v1", "-m", "Release");
    await git(root, "update-ref", "refs/remotes/origin/main", main);
    await git(
      root,
      "tag",
      "blob-tag",
      await git(root, "rev-parse", `${first}:history.txt`),
    );
    await git(root, "checkout", "--detach", first);
    const snapshot = await call<HistorySnapshot>("refs");
    expect(snapshot.refs).toContainEqual({ name: "HEAD", oid: first });
    expect(snapshot.refs).toContainEqual({ name: "refs/tags/v1", oid: merge });
    expect(snapshot.refs.some((ref) => ref.name === "refs/tags/blob-tag")).toBe(
      false,
    );
    const details = await call<HistoryDetails>("details", { oid: merge });
    expect(details.parents).toEqual([main, feature]);
    const page = await call<HistoryPage>("page", {
      snapshot: { ...snapshot, tips: [feature] },
    });
    expect(page.commits.map((item) => item.oid)).toEqual([feature, first]);
  });
  test("empty and shallow repositories and invalid requests", async () => {
    const empty = await repo();
    expect((await empty.call<HistoryPage>("page")).commits).toEqual([]);
    const original = await repo(3);
    const shallow = await mkdtemp(join(tmpdir(), "roamgate-shallow-"));
    roots.push(shallow);
    await git(shallow, "clone", "--depth=1", `file://${original.root}`, ".");
    const history = createGitHistory({
      root: shallow,
      workspaceId: "w1",
      shQuote,
      runProcessWithCodeTimeout,
    });
    expect(
      ((await history("git.history.page", {})) as HistoryPage).snapshot.shallow,
    ).toBe(true);
    expect(() => historyOid("--all")).toThrow();
    await expect(original.call("details", { oid: "HEAD" })).rejects.toThrow();
    await expect(
      original.call("page", { snapshot: { tips: ["HEAD"] } }),
    ).rejects.toThrow();
    await expect(original.call("page", { offset: -1 })).rejects.toThrow();
    const target = await git(original.root, "rev-parse", "HEAD");
    await expect(
      original.call("diff_file", { base: null, target, path: "../outside" }),
    ).rejects.toThrow();
  });
  test("bounds oversized patches and images and preserves shallow parents", async () => {
    const { root, call } = await repo();
    await writeFile(join(root, "large.txt"), "long line\n".repeat(70000));
    await writeFile(join(root, "large.png"), Buffer.alloc(6 * 1024 * 1024));
    const target = await commit(root, "Large assets");
    const patch = await call<GitDiffFile>("diff_file", {
      base: null,
      target,
      path: "large.txt",
    });
    expect(patch.truncated).toBe(true);
    expect(Buffer.byteLength(patch.diff)).toBeLessThanOrEqual(512 * 1024);
    await expect(
      call("image", { oid: target, path: "large.png" }),
    ).rejects.toThrow("preview size limit");
    const original = await repo(3);
    const shallow = await mkdtemp(join(tmpdir(), "roamgate-shallow-parents-"));
    roots.push(shallow);
    await git(shallow, "clone", "--depth=1", `file://${original.root}`, ".");
    const history = createGitHistory({
      root: shallow,
      workspaceId: "w1",
      shQuote,
      runProcessWithCodeTimeout,
    });
    const oid = await git(shallow, "rev-parse", "HEAD");
    const details = (await history("git.history.details", {
      oid,
    })) as HistoryDetails;
    expect(details.parents.length).toBe(1);
    await expect(
      history("git.history.diff_summary", {
        base: details.parents[0],
        target: oid,
      }),
    ).rejects.toThrow();
  });
  test("historic reads use the SSH runner on remote connections", async () => {
    const { root } = await repo(1);
    const commands: string[][] = [];
    const history = createGitHistory({
      root,
      workspaceId: "remote",
      host: "example",
      shQuote,
      runProcessWithCodeTimeout: async (argv, timeout) => {
        commands.push(argv);
        return runProcessWithCodeTimeout(
          ["sh", "-lc", argv[argv.length - 1]!],
          timeout,
        );
      },
    });
    const page = (await history("git.history.page", {})) as HistoryPage;
    expect(page.commits.length).toBe(1);
    expect(commands.every((argv) => argv[0] === "ssh")).toBe(true);
  });
});
