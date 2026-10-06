import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  Suspense,
  type CSSProperties,
} from "react";
import {
  GitFork,
  RefreshCw,
  Search,
  X,
  ChevronLeft,
  Maximize2,
  Minimize2,
  ArrowLeftRight,
} from "lucide-react";
import type {
  HistoryCommit,
  HistoryDetails,
  HistorySnapshot,
  HistoryPage,
  HistorySearch,
  HistoryRange,
} from "../../../shared/gitHistory";
import type { ConnectionClient } from "../api";
import type { FilePreview, GitDiffEntry, GitDiffFile } from "../types";
import { roamgateLocalStorage } from "../browserStorage";
import { lazyWithReload } from "../lazyWithReload";
import {
  graphRows,
  graphWindow,
  GRAPH_ROW_HEIGHT,
  type GraphRow,
} from "./gitGraphLayout";
import "./GitGraphPanel.css";

const DiffContentView = lazyWithReload("git-graph-diff", () =>
  import("./DiffContentView").then((m) => ({ default: m.DiffContentView })),
);
import { imageMimeForPath } from "../../../shared/filePreview";

const COLORS = [
  "#60a5fa",
  "#c084fc",
  "#34d399",
  "#fb923c",
  "#f472b6",
  "#facc15",
  "#22d3ee",
];
interface Preferences {
  filter: string;
  selected: string | null;
  scroll: number;
  offset: number;
  ratio: number;
  filesRatio: number;
}
interface Model {
  snapshot: HistorySnapshot | null;
  commits: HistoryCommit[];
  offset: number;
  next: number | null;
  preferences: Preferences;
}
const models = new Map<string, Model>();
function modelFor(key: string): Model {
  let model = models.get(key);
  if (!model) {
    let saved: Partial<Preferences> = {};
    try {
      saved = JSON.parse(
        roamgateLocalStorage.getItem(`gitGraph:${key}`) ?? "{}",
      );
    } catch {
      /* Use defaults after damaged storage. */
    }
    model = {
      snapshot: null,
      commits: [],
      offset: 0,
      next: null,
      preferences: {
        filter: typeof saved.filter === "string" ? saved.filter : "",
        selected: typeof saved.selected === "string" ? saved.selected : null,
        scroll: Number.isFinite(saved.scroll) ? Math.max(0, saved.scroll!) : 0,
        offset: Number.isSafeInteger(saved.offset)
          ? Math.max(0, saved.offset!)
          : 0,
        ratio: clamp(saved.ratio ?? 0.46, 0.2, 0.75),
        filesRatio: clamp(saved.filesRatio ?? 0.24, 0.15, 0.5),
      },
    };
    models.set(key, model);
    if (models.size > 8) models.delete(models.keys().next().value!);
  }
  return model;
}
function clamp(value: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}
function GraphLanes({ row, width }: { row: GraphRow; width: number }) {
  const x = (lane: number) => 14 + lane * 18;
  return (
    <svg
      width={width}
      height={GRAPH_ROW_HEIGHT}
      aria-hidden="true"
      className="git-graph-lanes"
    >
      {row.above.map((edge, index) => (
        <path
          key={`a${index}`}
          d={`M ${x(edge.from)} 0 L ${x(edge.to)} 20`}
          stroke={COLORS[edge.color % COLORS.length]}
        />
      ))}
      {row.below.map((edge, index) => (
        <path
          key={`b${index}`}
          d={`M ${x(edge.from)} 20 C ${x(edge.from)} 32 ${x(edge.to)} 28 ${x(edge.to)} 40`}
          stroke={COLORS[edge.color % COLORS.length]}
        />
      ))}
      <circle
        cx={x(row.lane)}
        cy="20"
        r="4.5"
        fill={COLORS[row.color % COLORS.length]}
      />
    </svg>
  );
}
function Resizer({
  vertical,
  value,
  onChange,
}: {
  vertical?: boolean;
  value: number;
  onChange: (value: number) => void;
}) {
  const drag = useRef(false);
  return (
    <div
      className={`git-graph-resizer ${vertical ? "is-vertical" : ""}`}
      role="separator"
      tabIndex={0}
      aria-label={vertical ? "Resize changed files" : "Resize history"}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemin={vertical ? 15 : 20}
      aria-valuemax={vertical ? 50 : 75}
      aria-valuenow={Math.round(value * 100)}
      onKeyDown={(event) => {
        if (
          ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
            event.key,
          )
        ) {
          event.preventDefault();
          onChange(
            value +
              (["ArrowUp", "ArrowLeft"].includes(event.key) ? -0.03 : 0.03),
          );
        }
      }}
      onPointerDown={(event) => {
        drag.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={(event) => {
        drag.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = false;
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const rect = event.currentTarget.parentElement!.getBoundingClientRect();
        const historyTop =
          event.currentTarget
            .parentElement!.querySelector(".git-graph-history")
            ?.getBoundingClientRect().top ?? rect.top;
        onChange(
          vertical
            ? (event.clientX - rect.left) / rect.width
            : (event.clientY - historyTop) / rect.height,
        );
      }}
    />
  );
}
export function GitGraphPanel({
  workspaceId,
  resourceKey,
  client,
  compact,
  visible,
}: {
  workspaceId: string;
  resourceKey: string;
  client: ConnectionClient;
  compact: boolean;
  visible: boolean;
}) {
  const cacheKey = `${client.connectionId}:${resourceKey}`;
  const model = useMemo(() => modelFor(cacheKey), [cacheKey]);
  const [preferences, setPreferences] = useState(model.preferences);
  const [snapshot, setSnapshot] = useState(model.snapshot);
  const [commits, setCommits] = useState(model.commits);
  const [offset, setOffset] = useState(model.offset);
  const [next, setNext] = useState(model.next);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<HistorySearch | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(preferences.selected);
  const [details, setDetails] = useState<HistoryDetails | null>(null);
  const [detailVersion, setDetailVersion] = useState(0);
  const [diffVersion, setDiffVersion] = useState(0);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [parent, setParent] = useState<string | null>(null);
  const [compareFrom, setCompareFrom] = useState<string | null>(null);
  const [compareTo, setCompareTo] = useState<string | null>(null);
  const [entries, setEntries] = useState<GitDiffEntry[]>([]);
  const [entry, setEntry] = useState<GitDiffEntry | null>(null);
  const [file, setFile] = useState<GitDiffFile | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [stage, setStage] = useState<"graph" | "commit" | "diff">("graph");
  const [maxDiff, setMaxDiff] = useState(false);
  const [imageSide, setImageSide] = useState<"before" | "after">("after");
  const [viewport, setViewport] = useState({
    top: preferences.scroll,
    height: 400,
  });
  const scroller = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  const pageRequest = useRef(0);
  const busy = useRef(false);
  const searchRequest = useRef(0);
  const summaryRequest = useRef(0);
  const restored = useRef(false);
  const restoreTarget = useRef(model.preferences.scroll);
  const scrollSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const patchCache = useRef(new Map<string, GitDiffFile>());
  const range: HistoryRange | null =
    compareFrom && compareTo
      ? { base: compareFrom, target: compareTo }
      : details
        ? { base: parent, target: details.oid }
        : null;
  const rangeKey = range ? `${range.base ?? "empty"}:${range.target}` : "";
  const rpc = useCallback(
    <T,>(method: string, params: Record<string, unknown> = {}) =>
      client.call(method, {
        workspace_id: workspaceId,
        ...params,
      }) as Promise<T>,
    [client, workspaceId],
  );
  const current = useCallback(
    () => alive.current && client.isCurrent(),
    [client],
  );
  const save = useCallback(
    (patch: Partial<Preferences>) => {
      const updated = { ...model.preferences, ...patch };
      model.preferences = updated;
      roamgateLocalStorage.setItem(
        `gitGraph:${cacheKey}`,
        JSON.stringify(updated),
      );
      setPreferences(updated);
    },
    [model, cacheKey],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (scrollSave.current) clearTimeout(scrollSave.current);
      roamgateLocalStorage.setItem(
        `gitGraph:${cacheKey}`,
        JSON.stringify(model.preferences),
      );
    };
  }, [cacheKey, model]);
  const filteredSnapshot = useCallback(
    (state: HistorySnapshot): HistorySnapshot => ({
      ...state,
      tips: preferences.filter
        ? state.refs
            .filter((ref) => ref.name === preferences.filter)
            .map((ref) => ref.oid)
        : state.tips,
    }),
    [preferences.filter],
  );
  const loadPage = useCallback(
    async (start: number, replace = false, state = snapshotRef.current) => {
      if (busy.current && !replace) return;
      busy.current = true;
      const token = ++pageRequest.current;
      setLoading(true);
      setError(null);
      try {
        const source =
          state ?? (await rpc<HistorySnapshot>("git.history.refs"));
        if (!current() || token !== pageRequest.current) return;
        const result = await rpc<HistoryPage>("git.history.page", {
          offset: start,
          snapshot: filteredSnapshot(source),
        });
        if (!current() || token !== pageRequest.current) return;
        if (!state) {
          model.snapshot = source;
          setSnapshot(source);
          snapshotRef.current = source;
        }
        model.commits = replace
          ? result.commits
          : [...model.commits, ...result.commits];
        model.offset = replace ? start : model.offset;
        model.next = result.next;
        setCommits(model.commits);
        setOffset(model.offset);
        setNext(result.next);
        save({
          offset: model.offset,
          ...(replace && restored.current ? { scroll: 0 } : {}),
        });
        if (replace && restored.current) {
          if (scroller.current) scroller.current.scrollTop = 0;
          setViewport((previous) => ({ ...previous, top: 0 }));
        }
        return true;
      } catch (cause) {
        if (current() && token === pageRequest.current)
          setError((cause as Error).message);
      } finally {
        if (current() && token === pageRequest.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [rpc, filteredSnapshot, current, model, save],
  );
  useEffect(() => {
    if (visible && !model.snapshot && !busy.current)
      void loadPage(model.preferences.offset, true);
  }, [visible, loadPage, model]);
  const lastFilter = useRef(preferences.filter);
  useEffect(() => {
    if (lastFilter.current === preferences.filter) return;
    restored.current = true;
    lastFilter.current = preferences.filter;
    setSearch(null);
    setQuery("");
    setSelected(null);
    save({ selected: null, scroll: 0 });
    setStage("graph");
    if (snapshotRef.current) void loadPage(0, true);
  }, [preferences.filter, loadPage, save]);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || !visible) return;
    if (!restored.current && commits.length) {
      if (
        restoreTarget.current >
          commits.length * GRAPH_ROW_HEIGHT - node.clientHeight &&
        model.next !== null
      ) {
        void loadPage(model.next);
        return;
      }
      node.scrollTop = restoreTarget.current;
      restored.current = true;
    }
    const measure = () =>
      setViewport({ top: node.scrollTop, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible, commits.length, stage, maxDiff, model, loadPage]);
  useEffect(() => {
    if (
      visible &&
      next !== null &&
      !loading &&
      !error &&
      viewport.top + viewport.height >= (commits.length - 20) * GRAPH_ROW_HEIGHT
    )
      void loadPage(next);
  }, [visible, next, loading, error, viewport, commits.length, loadPage]);
  const refresh = async () => {
    restored.current = true;
    ++searchRequest.current;
    setQuery("");
    setSearch(null);
    setSelected(null);
    setStage("graph");
    setCompareFrom(null);
    setCompareTo(null);
    save({ selected: null, scroll: 0 });
    try {
      const state = await rpc<HistorySnapshot>("git.history.refs");
      if (!current()) return;
      model.snapshot = state;
      setSnapshot(state);
      snapshotRef.current = state;
      void loadPage(0, true, state);
    } catch (cause) {
      if (current()) setError((cause as Error).message);
    }
  };
  const runSearch = useCallback(
    async (start = 0, append = false) => {
      const state = snapshotRef.current;
      if (!state || !query.trim()) return;
      const token = ++searchRequest.current;
      setSearchLoading(true);
      setSearchError(null);
      try {
        const result = await rpc<HistorySearch>("git.history.search", {
          snapshot: filteredSnapshot(state),
          query,
          offset: start,
        });
        if (current() && token === searchRequest.current)
          setSearch((previous) =>
            append && previous
              ? { ...result, matches: [...previous.matches, ...result.matches] }
              : result,
          );
      } catch (cause) {
        if (current() && token === searchRequest.current)
          setSearchError((cause as Error).message);
      } finally {
        if (current() && token === searchRequest.current)
          setSearchLoading(false);
      }
    },
    [rpc, query, filteredSnapshot, current],
  );
  useEffect(() => {
    ++searchRequest.current;
    setSearch(null);
    setSearchError(null);
    setSearchLoading(false);
    if (!query.trim()) return;
    const timer = setTimeout(() => void runSearch(), 350);
    return () => clearTimeout(timer);
  }, [query, runSearch]);
  const select = useCallback(
    (oid: string) => {
      setSelected(oid);
      save({ selected: oid });
      setStage("commit");
      setMaxDiff(false);
    },
    [save],
  );
  const reveal = async (oid: string, index?: number) => {
    try {
      let local = commits.findIndex((commit) => commit.oid === oid);
      if (local < 0) {
        let target = index;
        if (target === undefined && snapshot) {
          const located = await rpc<{ offset: number | null }>(
            "git.history.locate",
            { snapshot: filteredSnapshot(snapshot), oid },
          );
          target = located.offset ?? undefined;
        }
        if (!current()) return;
        if (target === undefined) {
          setDetailError(
            "Commit is outside the current branch filter or unavailable in this clone",
          );
          return;
        }
        const start = Math.max(0, target - 50);
        if (!(await loadPage(start, true))) return;
        local = target - start;
      }
      if (!current()) return;
      setQuery("");
      select(oid);
      const top = local * GRAPH_ROW_HEIGHT;
      save({ scroll: top });
      setViewport((previous) => ({ ...previous, top }));
      requestAnimationFrame(() => {
        if (scroller.current) scroller.current.scrollTop = top;
      });
    } catch (cause) {
      if (current()) setDetailError((cause as Error).message);
    }
  };
  useEffect(() => {
    let active = true;
    setDetails(null);
    setDetailError(null);
    setDetailLoading(!!selected);
    setParent(null);
    if (selected)
      void rpc<HistoryDetails>("git.history.details", { oid: selected })
        .then((result) => {
          if (active && current()) {
            setDetails(result);
            setParent(result.parents[0] ?? null);
          }
        })
        .catch((cause) => {
          if (active && current()) setDetailError((cause as Error).message);
        })
        .finally(() => {
          if (active && current()) setDetailLoading(false);
        });
    return () => {
      active = false;
    };
  }, [selected, rpc, current, detailVersion]);
  useEffect(() => {
    const token = ++summaryRequest.current;
    setEntries([]);
    setEntry(null);
    setFile(null);
    setDiffError(null);
    setSummaryLoading(!!rangeKey);
    if (range)
      void rpc<{ entries: GitDiffEntry[] }>("git.history.diff_summary", {
        ...range,
      })
        .then((result) => {
          if (current() && token === summaryRequest.current) {
            setEntries(result.entries);
            setEntry(result.entries[0] ?? null);
          }
        })
        .catch((cause) => {
          if (current() && token === summaryRequest.current)
            setDiffError((cause as Error).message);
        })
        .finally(() => {
          if (current() && token === summaryRequest.current)
            setSummaryLoading(false);
        });
    // The immutable range key intentionally controls the request lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey, rpc, current, diffVersion]);
  useEffect(() => {
    let active = true;
    setFile(null);
    setFileLoading(!!entry);
    setDiffError(null);
    if (range && entry) {
      const key = `${rangeKey}:${entry.old_path ?? ""}:${entry.path}`;
      const cached = patchCache.current.get(key);
      const request = cached
        ? Promise.resolve(cached)
        : rpc<GitDiffFile>("git.history.diff_file", {
            ...range,
            path: entry.path,
            old_path: entry.old_path,
          });
      void request
        .then((result) => {
          if (!active || !current()) return;
          if (!cached) {
            patchCache.current.set(key, result);
            while (
              patchCache.current.size > 24 ||
              [...patchCache.current.values()].reduce(
                (sum, item) => sum + item.diff.length * 2,
                0,
              ) >
                8 * 1024 * 1024
            ) {
              patchCache.current.delete(
                patchCache.current.keys().next().value!,
              );
            }
          }
          setFile(result);
        })
        .catch((cause) => {
          if (active && current()) setDiffError((cause as Error).message);
        })
        .finally(() => {
          if (active && current()) setFileLoading(false);
        });
    }
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, rangeKey, rpc, current, diffVersion]);
  useEffect(() => {
    setImageSide(entry?.status === "deleted" ? "before" : "after");
  }, [entry]);
  const imagePreview = useCallback(
    (diff: GitDiffFile): Promise<FilePreview> => {
      const historical = diff.history;
      if (!historical)
        return Promise.reject(
          new Error("Historical revisions are unavailable"),
        );
      const before = imageSide === "before";
      const oid = before ? historical.base : historical.target;
      if (!oid || (imageSide === "before" && entry?.status === "added"))
        return Promise.reject(
          new Error("Image does not exist in this revision"),
        );
      return rpc<FilePreview>("git.history.image", {
        oid,
        path: before ? (entry?.old_path ?? diff.path) : diff.path,
      });
    },
    [rpc, imageSide, entry],
  );
  const layout = useMemo(() => graphRows(commits), [commits]);
  const graphWidth = layout.reduce(
    (width, row) => Math.max(width, row.width * 18 + 14),
    40,
  );
  const windowed = graphWindow(viewport.top, viewport.height, commits.length);
  const refLabels = useMemo(() => {
    const labels = new Map<string, string[]>();
    for (const ref of snapshot?.refs ?? [])
      labels.set(ref.oid, [
        ...(labels.get(ref.oid) ?? []),
        ref.name.replace(/^refs\/(heads|remotes|tags)\//, ""),
      ]);
    return labels;
  }, [snapshot]);
  const hasDetails = !!selected || !!(compareFrom && compareTo);
  const style = {
    "--git-graph-history-ratio": `${preferences.ratio * 100}%`,
    "--git-graph-files-ratio": `${preferences.filesRatio * 100}%`,
  } as CSSProperties;
  return (
    <section
      className={`git-graph ${compact ? "is-compact" : ""} ${hasDetails ? "has-details" : ""} ${maxDiff ? "max-diff" : ""} stage-${stage}`}
      style={style}
      aria-label="Git Graph"
    >
      <header className="git-graph-toolbar">
        {compact && stage !== "graph" ? (
          <button
            onClick={() => {
              setMaxDiff(false);
              setStage(stage === "diff" ? "commit" : "graph");
            }}
          >
            <ChevronLeft size={16} /> {stage === "diff" ? "Commit" : "Graph"}
          </button>
        ) : null}
        <GitFork size={16} />
        <strong>Git Graph</strong>
        <select
          aria-label="Filter Git history by branch"
          value={preferences.filter}
          onChange={(event) => save({ filter: event.target.value, scroll: 0 })}
        >
          <option value="">All branches and tags</option>
          {snapshot?.refs
            .filter((ref) => ref.name !== "HEAD")
            .map((ref) => (
              <option key={ref.name} value={ref.name}>
                {ref.name.replace(/^refs\/(heads|remotes|tags)\//, "")}
              </option>
            ))}
        </select>
        <label className="git-graph-search">
          <Search size={14} />
          <input
            placeholder="Search history"
            aria-label="Search all history by message, author or hash"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setQuery("");
              }
              if (event.key === "Enter" && search?.matches[0]) {
                event.preventDefault();
                void reveal(
                  search.matches[0].commit.oid,
                  search.matches[0].offset,
                );
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                document
                  .querySelector<HTMLButtonElement>(
                    ".git-graph-search-results button",
                  )
                  ?.focus();
              }
            }}
          />
        </label>
        <button
          title="Refresh refs and history"
          aria-label="Refresh Git Graph"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} />
        </button>
      </header>
      {compareFrom ? (
        <div className="git-graph-comparison">
          From <code>{compareFrom.slice(0, 8)}</code>{" "}
          {compareTo ? (
            <>
              <span>to</span>
              <code>{compareTo.slice(0, 8)}</code>
              <button
                aria-label="Swap comparison"
                onClick={() => {
                  setCompareFrom(compareTo);
                  setCompareTo(compareFrom);
                }}
              >
                <ArrowLeftRight size={14} />
              </button>
            </>
          ) : (
            <span>Select another commit and choose Compare to</span>
          )}
          <button
            onClick={() => {
              setCompareFrom(null);
              setCompareTo(null);
            }}
          >
            Clear
          </button>
        </div>
      ) : null}
      {query.trim() ? (
        <div className="git-graph-search-results" aria-live="polite">
          {searchLoading ? <p>Searching repository history...</p> : null}
          {searchError ? (
            <p role="alert">
              {searchError}
              <button onClick={() => void runSearch()}>Retry</button>
            </p>
          ) : null}
          {search?.matches.map((match) => (
            <button
              key={match.commit.oid}
              onClick={() => void reveal(match.commit.oid, match.offset)}
            >
              <code>{match.commit.oid.slice(0, 8)}</code>
              <span>{match.commit.subject}</span>
              <small>{match.commit.author}</small>
            </button>
          ))}
          {search && !search.matches.length ? <p>No matching commits</p> : null}
          {search?.next !== null && search?.next !== undefined ? (
            <button
              disabled={searchLoading}
              onClick={() => void runSearch(search.next!, true)}
            >
              More matches
            </button>
          ) : null}
          <button onClick={() => setQuery("")}>Close search</button>
        </div>
      ) : null}
      <div className="git-graph-history">
        {offset > 0 ? (
          <div className="git-graph-boundary">
            Showing history from commit {offset + 1}
            <button onClick={() => void loadPage(0, true)}>
              Back to latest
            </button>
          </div>
        ) : null}
        {error ? (
          <div role="alert" className="git-graph-state">
            {error}
            <button
              onClick={() =>
                void loadPage(
                  commits.length && next !== null ? next : offset,
                  !commits.length,
                )
              }
            >
              Retry
            </button>
          </div>
        ) : null}
        {!commits.length ? (
          <div className="git-graph-state">
            {loading
              ? "Loading history..."
              : error
                ? ""
                : "No commits in this repository"}
          </div>
        ) : null}
        <div
          className="git-graph-scroll"
          ref={scroller}
          tabIndex={0}
          role="listbox"
          aria-label="Repository commits"
          aria-activedescendant={
            selected ? `git-commit-${selected}` : undefined
          }
          onScroll={(event) => {
            const node = event.currentTarget;
            setViewport({ top: node.scrollTop, height: node.clientHeight });
            model.preferences.scroll = node.scrollTop;
            if (scrollSave.current) clearTimeout(scrollSave.current);
            scrollSave.current = setTimeout(
              () =>
                roamgateLocalStorage.setItem(
                  `gitGraph:${cacheKey}`,
                  JSON.stringify(model.preferences),
                ),
              200,
            );
          }}
          onBlur={() => save({ scroll: scroller.current?.scrollTop ?? 0 })}
          onKeyDown={(event) => {
            if (
              ![
                "ArrowDown",
                "ArrowUp",
                "PageDown",
                "PageUp",
                "Home",
                "End",
                "Enter",
              ].includes(event.key)
            )
              return;
            event.preventDefault();
            if (event.key === "Enter") {
              if (selected) {
                setStage("commit");
              }
              return;
            }
            const index = Math.max(
              0,
              commits.findIndex((commit) => commit.oid === selected),
            );
            const step = event.key.startsWith("Page")
              ? Math.max(1, Math.floor(viewport.height / 40))
              : 1;
            const target =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? commits.length - 1
                  : clamp(
                      index +
                        (["ArrowUp", "PageUp"].includes(event.key)
                          ? -step
                          : step),
                      0,
                      commits.length - 1,
                    );
            const commit = commits[target];
            if (commit) {
              select(commit.oid);
              const node = scroller.current;
              if (node) {
                const top = target * 40;
                if (top < node.scrollTop) node.scrollTop = top;
                else if (top + 40 > node.scrollTop + node.clientHeight)
                  node.scrollTop = top + 40 - node.clientHeight;
              }
            }
          }}
        >
          <div
            className="git-graph-rows"
            style={{
              height: commits.length * GRAPH_ROW_HEIGHT,
              minWidth: graphWidth + (compact ? 190 : 440),
            }}
          >
            {commits
              .slice(windowed.start, windowed.end)
              .map((commit, index) => {
                const rowIndex = windowed.start + index;
                return (
                  <div
                    key={commit.oid}
                    id={`git-commit-${commit.oid}`}
                    className={`git-graph-row ${selected === commit.oid ? "is-selected" : ""}`}
                    role="option"
                    aria-selected={selected === commit.oid}
                    style={{
                      top: rowIndex * GRAPH_ROW_HEIGHT,
                      gridTemplateColumns: compact
                        ? `${graphWidth}px minmax(190px,1fr)`
                        : `${graphWidth}px minmax(200px,1fr) 130px 100px 76px`,
                    }}
                    onClick={() => select(commit.oid)}
                  >
                    <GraphLanes row={layout[rowIndex]!} width={graphWidth} />
                    <span className="git-graph-subject" title={commit.subject}>
                      {(refLabels.get(commit.oid) ?? []).map((ref) => (
                        <span
                          className={`git-graph-ref ${ref === "HEAD" ? "is-head" : ""}`}
                          key={ref}
                        >
                          {ref}
                        </span>
                      ))}
                      {commit.subject}
                    </span>
                    <span title={commit.author}>{commit.author}</span>
                    <time title={commit.date}>{commit.date.slice(0, 10)}</time>
                    <code>{commit.oid.slice(0, 8)}</code>
                  </div>
                );
              })}
          </div>
          {loading ? (
            <div className="git-graph-state">Loading older commits...</div>
          ) : next !== null ? (
            <button
              className="git-graph-load"
              onClick={() => void loadPage(next)}
            >
              Load older commits
            </button>
          ) : commits.length ? (
            <div className="git-graph-state">
              {snapshot?.shallow
                ? "Shallow clone: earlier history is unavailable on this host"
                : "Beginning of history"}
            </div>
          ) : null}
        </div>
      </div>
      {hasDetails ? (
        <>
          <Resizer
            value={preferences.ratio}
            onChange={(ratio) => save({ ratio: clamp(ratio, 0.2, 0.75) })}
          />
          <div className="git-graph-details">
            <header className="git-graph-commit-header">
              <div>
                <strong>
                  {compareFrom && compareTo
                    ? "Commit comparison"
                    : (details?.subject ?? "Commit details")}
                </strong>
                <code>{selected?.slice(0, 12)}</code>
              </div>
              {selected ? (
                <>
                  <button
                    onClick={() => {
                      setCompareFrom(selected);
                      setCompareTo(null);
                    }}
                  >
                    Compare from
                  </button>
                  <button
                    disabled={!compareFrom}
                    onClick={() => {
                      setCompareTo(selected);
                      setStage("commit");
                    }}
                  >
                    Compare to
                  </button>
                </>
              ) : null}
              <button
                aria-label={maxDiff ? "Restore graph" : "Maximize diff"}
                title={maxDiff ? "Restore graph" : "Maximize diff"}
                onClick={() => setMaxDiff(!maxDiff)}
              >
                {maxDiff ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
              <button
                aria-label="Close commit details"
                onClick={() => {
                  setSelected(null);
                  save({ selected: null });
                  setStage("graph");
                  setMaxDiff(false);
                  setCompareTo(null);
                }}
              >
                <X size={16} />
              </button>
            </header>
            {detailLoading ? (
              <p className="git-graph-state">Loading commit...</p>
            ) : null}
            {detailError ? (
              <p role="alert" className="git-graph-state">
                {detailError}
                <button
                  onClick={() => {
                    setDetailVersion((version) => version + 1);
                  }}
                >
                  Retry
                </button>
              </p>
            ) : null}
            {details && !(compareFrom && compareTo) ? (
              <div className="git-graph-metadata">
                <span>
                  {details.author} · {new Date(details.date).toLocaleString()}
                </span>
                <details>
                  <summary>Message and parents</summary>
                  <pre>{details.body}</pre>
                  <span>Committer: {details.committer}</span>
                  {details.parents.map((oid) => (
                    <button key={oid} onClick={() => void reveal(oid)}>
                      {oid.slice(0, 12)}
                    </button>
                  ))}
                </details>
                {details.parents.length > 1 ? (
                  <label>
                    Compare against parent{" "}
                    <select
                      value={parent ?? ""}
                      onChange={(event) => setParent(event.target.value)}
                    >
                      {details.parents.map((oid, index) => (
                        <option key={oid} value={oid}>
                          Parent {index + 1}: {oid.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            ) : null}
            <div className="git-graph-diff-area">
              <nav
                className="git-graph-files"
                aria-label="Historic changed files"
              >
                {summaryLoading ? (
                  <p>Loading changed files...</p>
                ) : !entries.length ? (
                  <p>No changed files</p>
                ) : null}
                {entries.map((item) => (
                  <button
                    key={item.path}
                    className={entry?.path === item.path ? "is-selected" : ""}
                    title={
                      item.old_path
                        ? `${item.old_path} → ${item.path}`
                        : item.path
                    }
                    onClick={() => {
                      setEntry(item);
                      setStage("diff");
                    }}
                  >
                    <span className={`git-graph-status status-${item.status}`}>
                      {item.status[0]?.toUpperCase()}
                    </span>
                    <span>{item.path}</span>
                  </button>
                ))}
              </nav>
              <Resizer
                vertical
                value={preferences.filesRatio}
                onChange={(ratio) =>
                  save({ filesRatio: clamp(ratio, 0.15, 0.5) })
                }
              />
              <div className="git-graph-patch">
                {diffError ? (
                  <button
                    onClick={() => setDiffVersion((version) => version + 1)}
                  >
                    Retry historical diff
                  </button>
                ) : null}
                {file && imageMimeForPath(file.path) ? (
                  <label className="git-graph-image-side">
                    Image revision{" "}
                    <select
                      value={imageSide}
                      onChange={(event) =>
                        setImageSide(event.target.value as "before" | "after")
                      }
                    >
                      <option value="before">Before</option>
                      <option value="after">After</option>
                    </select>
                  </label>
                ) : null}
                <Suspense
                  fallback={
                    <p className="git-graph-state">Loading diff viewer...</p>
                  }
                >
                  <DiffContentView
                    key={`${rangeKey}:${imageSide}`}
                    entry={entry}
                    file={file}
                    loading={fileLoading}
                    error={diffError}
                    summaryLoading={summaryLoading}
                    mobile={compact}
                    resourceKey={`${resourceKey}:history:${rangeKey}`}
                    connectionClient={client}
                    requestImagePreview={imagePreview}
                  />
                </Suspense>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
