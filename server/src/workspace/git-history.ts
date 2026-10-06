import type {
  HistoryCommit,
  HistorySnapshot,
  HistoryRange,
} from "../../../shared/gitHistory";
import { imageMimeForPath } from "../../../shared/filePreview";
import { sshCommandArgv } from "../bridge/ssh-command";
import {
  GIT_DIFF_MAX_BYTES,
  GIT_DIFF_TIMEOUT_MS,
  PREVIEW_IMAGE_MAX_BYTES,
} from "./file-constants";
import type { RunProcessWithCodeTimeout, GitDiffEntry } from "./file-types";

const FORMAT = "%H%x00%P%x00%an%x00%aI%x00%s";
const MAX_TIPS = 4096;
const MAX_METADATA = 2 * 1024 * 1024;
function historyPath(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.startsWith("/") ||
    raw.includes("\0") ||
    raw.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Expected a repository-relative Git path");
  }
  // Git tree names are literal, including backslashes on Unix.
  return raw;
}
export function historyOid(raw: unknown): string {
  if (typeof raw !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(raw))
    throw new Error("Expected a full commit object ID");
  return raw;
}
export function parseHistoryLog(raw: string): HistoryCommit[] {
  const fields = raw.split("\0");
  const commits: HistoryCommit[] = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const oid = fields[i]!.trim();
    if (!oid) continue;
    commits.push({
      oid: historyOid(oid),
      parents: fields[i + 1]!.split(" ").filter(Boolean),
      author: fields[i + 2]!,
      date: fields[i + 3]!,
      subject: fields[i + 4]!,
    });
  }
  return commits;
}
function offsetValue(raw: unknown) {
  if (raw === undefined) return 0;
  if (!Number.isSafeInteger(raw) || Number(raw) < 0)
    throw new Error("Invalid history offset");
  return Number(raw);
}
function snapshotTips(raw: unknown): string[] {
  const tips = (raw as HistorySnapshot | undefined)?.tips;
  if (!Array.isArray(tips) || tips.length > MAX_TIPS)
    throw new Error("Invalid history snapshot; refresh Git Graph");
  return [...new Set(tips.map(historyOid))];
}
export function createGitHistory({
  root,
  workspaceId,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  root: string;
  workspaceId: string;
  host?: string;
  shQuote: (s: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  const git = (args: string[]) =>
    [
      "git",
      "--no-optional-locks",
      "-C",
      root,
      "-c",
      "core.quotepath=false",
      ...args,
    ]
      .map(shQuote)
      .join(" ");
  async function command(shell: string, cap = MAX_METADATA) {
    const result = await runProcessWithCodeTimeout(
      host ? sshCommandArgv(host, shell) : ["sh", "-lc", shell],
      GIT_DIFF_TIMEOUT_MS,
    );
    if (result.code !== 0 || /(?:fatal|error):/.test(result.stderr))
      throw new Error(result.stderr.trim() || "Git history command failed");
    if (Buffer.byteLength(result.stdout) > cap)
      throw new Error(
        "History response is too large; narrow the branch filter",
      );
    return result.stdout;
  }
  const run = (args: string[], cap = MAX_METADATA) =>
    command(`${git(args)} | head -c ${cap + 1}`, cap);
  async function snapshot(): Promise<HistorySnapshot> {
    const raw = await run([
      "for-each-ref",
      "--format=%(refname)%09%(objectname)%09%(*objectname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
    const refs = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, object, peeled] = line.split("\t");
        return { name: name!, oid: historyOid(peeled || object) };
      });
    // Exclude tags pointing to blobs or trees from commit traversal.
    const resolved: typeof refs = [];
    for (let start = 0; start < refs.length; start += 128) {
      const batch = refs.slice(start, start + 128);
      const input = batch.map((ref) => shQuote(ref.oid)).join(" ");
      const types = await command(
        `printf '%s\\n' ${input} | ${git(["cat-file", "--batch-check=%(objecttype)"])}`,
      );
      const lines = types.trim().split("\n");
      resolved.push(...batch.filter((_, index) => lines[index] === "commit"));
    }
    refs.splice(0, refs.length, ...resolved);
    const head = await command(
      `${git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])} || true`,
    );
    if (head.trim()) refs.push({ name: "HEAD", oid: historyOid(head.trim()) });
    const shallow =
      (await run(["rev-parse", "--is-shallow-repository"])).trim() === "true";
    const tips = [...new Set(refs.map((ref) => ref.oid))];
    if (tips.length > MAX_TIPS) throw new Error("Too many repository refs");
    return { tips, refs, shallow };
  }
  async function verify(raw: unknown) {
    const oid = historyOid(raw);
    return historyOid(
      (await run(["rev-parse", "--verify", `${oid}^{commit}`])).trim(),
    );
  }
  async function range(params: Record<string, unknown>): Promise<HistoryRange> {
    return {
      base: params.base == null ? null : await verify(params.base),
      target: await verify(params.target),
    };
  }
  async function emptyTree() {
    // hash-object without -w computes the repository's correct empty-tree ID.
    return (
      await command(
        `${git(["hash-object", "-t", "tree", "--stdin"])} < /dev/null`,
      )
    ).trim();
  }
  async function history(method: string, params: Record<string, unknown>) {
    if (method === "git.history.refs") return snapshot();
    if (method === "git.history.page") {
      const state = params.snapshot
        ? { tips: snapshotTips(params.snapshot), refs: [], shallow: false }
        : await snapshot();
      const offset = offsetValue(params.offset);
      const commits = state.tips.length
        ? parseHistoryLog(
            await run([
              "log",
              "--topo-order",
              "-z",
              `--format=${FORMAT}`,
              `--skip=${offset}`,
              "--max-count=201",
              ...state.tips,
              "--",
            ]),
          )
        : [];
      return {
        snapshot: state,
        commits: commits.slice(0, 200),
        offset,
        next: commits.length > 200 ? offset + 200 : null,
      };
    }
    if (method === "git.history.search" || method === "git.history.locate") {
      const tips = snapshotTips(params.snapshot);
      const offset = offsetValue(params.offset);
      if (!tips.length) return { matches: [], next: null, offset: null };
      const query = method.endsWith("locate")
        ? historyOid(params.oid)
        : String(params.query ?? "").trim();
      if (!query || query.length > 256)
        throw new Error("Search must contain 1 to 256 characters");
      const locate = method.endsWith("locate");
      const awk = locate
        ? '$0 == ENVIRON["HISTORY_QUERY"] { print NR-1 "\\t" $0; exit }'
        : 'NR > start && index(tolower($0), tolower(ENVIRON["HISTORY_QUERY"])) {print NR-1 "\\t" substr($0,1,hashlen); if (++found == 101) exit}';
      const format = locate ? "%H" : "%H%x09%an%x09%s";
      const hashes = await command(
        `HISTORY_QUERY=${shQuote(query)}; export HISTORY_QUERY; ${git(["log", "--topo-order", `--format=${format}`, ...tips, "--"])} | awk -v start=${offset} -v hashlen=${tips[0]!.length} ${shQuote(awk)}`,
      );
      const found = hashes
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [index, oid] = line.split("\t");
          return { offset: Number(index), oid: historyOid(oid) };
        });
      if (locate) return { offset: found[0]?.offset ?? null };
      const matches = found.slice(0, 100);
      const commits = matches.length
        ? parseHistoryLog(
            await run([
              "log",
              "--no-walk=unsorted",
              "-z",
              `--format=${FORMAT}`,
              ...matches.map((item) => item.oid),
              "--",
            ]),
          )
        : [];
      return {
        matches: matches.map((item) => ({
          offset: item.offset,
          commit: commits.find((commit) => commit.oid === item.oid)!,
        })),
        next: found.length > 100 ? found[100]!.offset : null,
      };
    }
    if (method === "git.history.details") {
      const oid = await verify(params.oid);
      const raw = await run([
        "show",
        "--no-patch",
        "-z",
        `--format=${FORMAT}%x00%cn%x00%B`,
        oid,
        "--",
      ]);
      const fields = raw.split("\0");
      const commit = parseHistoryLog(fields.slice(0, 5).join("\0"))[0]!;
      const object = await run(["cat-file", "-p", oid]);
      const parents = object
        .split("\n\n", 1)[0]!
        .split("\n")
        .filter((line) => line.startsWith("parent "))
        .map((line) => historyOid(line.slice(7)));
      return {
        ...commit,
        parents,
        committer: fields[5]!,
        body: fields[6]!.trimEnd(),
      };
    }
    if (
      method === "git.history.diff_summary" ||
      method === "git.history.diff_file"
    ) {
      const selected = await range(params);
      const base = selected.base ?? (await emptyTree());
      if (method.endsWith("diff_file")) {
        const path = historyPath(params.path);
        if (!path) throw new Error("Historic diff requires a path");
        const paths = [path];
        if (params.old_path) paths.push(historyPath(params.old_path));
        const raw = await command(
          `${git(["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", base, selected.target, "--", ...paths.map((p) => `:(literal)${p}`)])} | head -c ${GIT_DIFF_MAX_BYTES + 1}`,
          GIT_DIFF_MAX_BYTES + 1,
        );
        return {
          workspace_id: workspaceId,
          root,
          path,
          kind: "branch",
          diff: Buffer.from(raw)
            .subarray(0, GIT_DIFF_MAX_BYTES)
            .toString("utf8"),
          truncated: Buffer.byteLength(raw) > GIT_DIFF_MAX_BYTES,
          history: selected,
        };
      }
      const raw = await run([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--name-status",
        "-z",
        base,
        selected.target,
        "--",
      ]);
      const fields = raw.split("\0");
      const entries: GitDiffEntry[] = [];
      for (let i = 0; i < fields.length - 1; ) {
        const code = fields[i++]!;
        const old = fields[i++]!;
        const renamed = /^[RC]/.test(code);
        const path = renamed ? fields[i++]! : old;
        entries.push({
          path,
          ...(renamed ? { old_path: old } : {}),
          kind: "branch",
          status:
            (
              {
                A: "added",
                D: "deleted",
                R: "renamed",
                C: "copied",
                T: "type changed",
              } as Record<string, string>
            )[code[0]!] ?? "modified",
        });
      }
      return { workspace_id: workspaceId, root, ...selected, entries };
    }
    if (method === "git.history.image") {
      const oid = await verify(params.oid);
      const path = historyPath(params.path);
      const mime = imageMimeForPath(path);
      if (!mime)
        throw new Error("This historical file is not a supported image");
      const spec = `${oid}:${path}`;
      const size = Number((await run(["cat-file", "-s", spec])).trim());
      if (size > PREVIEW_IMAGE_MAX_BYTES)
        throw new Error("Historical image exceeds the preview size limit");
      const encoded = (
        await command(
          `${git(["show", spec])} | base64`,
          PREVIEW_IMAGE_MAX_BYTES * 2,
        )
      ).replace(/\s/g, "");
      return {
        workspace_id: workspaceId,
        root,
        checkout_path: root,
        path,
        size,
        mtime_ms: 0,
        text: null,
        binary: true,
        truncated: false,
        mime_type: mime,
        image_data_url: `data:${mime};base64,${encoded}`,
      };
    }
    throw new Error("Unknown Git history method");
  }
  return history;
}
