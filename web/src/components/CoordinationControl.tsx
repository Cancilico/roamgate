import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, RefreshCw, X } from "lucide-react";
import { createPortal } from "react-dom";
import {
  useConnectionClient,
  connectionClientScopeKey,
} from "../useConnectionClient";
import { store, useStoreSelector } from "../store";
import {
  canSendQueueItem,
  parseCoordinationSnapshot,
  queueItemOpen,
  type CoordinationSnapshot,
  type QueueItem,
} from "../coordination";
import { AgentIcon } from "./AgentIcon";
import "./CoordinationControl.css";

function RequestCard({
  item,
  snapshot,
  busy,
  change,
  openSession,
}: {
  item: QueueItem;
  snapshot: CoordinationSnapshot;
  busy: boolean;
  change: (
    item: QueueItem,
    action: string,
    extra?: Record<string, unknown>,
  ) => void;
  openSession: (sessionKey: string) => void;
}) {
  const [answer, setAnswer] = useState(item.answer || "");
  const sendable = canSendQueueItem(item, snapshot.fleet);
  const uncertain = ["sending", "unknown"].includes(
    item.delivery?.status || "",
  );
  return (
    <article className="coordination-card">
      <div className="coordination-row">
        <AgentIcon agent={item.provider} compact />
        <strong>{item.kind}</strong>
        <span>{item.status}</span>
      </div>
      <p>{item.ask}</p>
      {item.howTo && <p>{item.howTo}</p>}
      <small>
        {item.provider} · {item.sessionId.slice(0, 12)} · {item.cwd}
      </small>
      {item.answer && <p>Recorded answer: {item.answer}</p>}
      {item.delivery && <p role="status">Delivery: {item.delivery.status}</p>}
      {item.source !== "native" &&
        item.kind !== "secret" &&
        !["resolved", "dismissed"].includes(item.status) && (
          <label>
            Reply
            <textarea
              value={answer}
              maxLength={4000}
              onChange={(event) => setAnswer(event.target.value)}
              disabled={busy || uncertain}
            />
          </label>
        )}
      <div className="coordination-actions">
        <button type="button" onClick={() => openSession(item.sessionKey)}>
          Open session
        </button>
        {item.source !== "native" &&
          item.kind !== "secret" &&
          !["resolved", "dismissed"].includes(item.status) && (
            <button
              type="button"
              disabled={busy || !sendable || !answer.trim()}
              onClick={() => change(item, "send", { answer })}
            >
              Reply &amp; send
            </button>
          )}
        {item.source !== "native" && item.status === "resolved" && (
          <button
            type="button"
            disabled={busy || !sendable}
            onClick={() => change(item, "send")}
          >
            Resume
          </button>
        )}
        {!uncertain && !["resolved", "dismissed"].includes(item.status) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => change(item, "complete")}
          >
            Mark done
          </button>
        )}
        {!uncertain && item.status !== "dismissed" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => change(item, "dismiss")}
          >
            Dismiss
          </button>
        )}
        {item.delivery?.status === "unknown" && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                change(item, "delivery_result", {
                  attempt_id: item.delivery?.attemptId,
                  result: "sent",
                })
              }
            >
              I checked: sent
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                change(item, "delivery_result", {
                  attempt_id: item.delivery?.attemptId,
                  result: "failed",
                })
              }
            >
              I checked: not sent
            </button>
          </>
        )}
      </div>
      {item.source === "native" && (
        <small>
          Answer the native dialog in its session. Marking this item done does
          not approve the operation.
        </small>
      )}
      {!sendable && item.source !== "native" && !item.delivery && (
        <small>Replies can be sent when the originating agent is idle.</small>
      )}
    </article>
  );
}

export function CoordinationControl({ tabIndex }: { tabIndex?: number }) {
  const client = useConnectionClient();
  const scope = connectionClientScopeKey(
    client,
    client.serverRuntimeGeneration,
  );
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("queue");
  const [snapshot, setSnapshot] = useState<CoordinationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repository, setRepository] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const mountedScope = useRef(scope);
  const loadSequence = useRef(0);
  const currentWorkspace = useStoreSelector((s) =>
    s.workspaces.find((w) => w.focused),
  );
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const data = parseCoordinationSnapshot(
        await client.call("coordination.snapshot"),
      );
      if (
        mountedScope.current === scope &&
        client.isCurrent() &&
        sequence === loadSequence.current
      ) {
        setSnapshot(data);
        setError(null);
      }
    } catch (e) {
      if (
        mountedScope.current === scope &&
        client.isCurrent() &&
        sequence === loadSequence.current
      ) {
        setError((e as Error).message);
        setSnapshot(null);
      }
    }
  }, [client, scope]);
  useEffect(() => {
    mountedScope.current = scope;
    setSnapshot(null);
    setError(null);
    setActionError(null);
    setOpen(false);
    setBusy(false);
    setRepository("");
    setSessionFilter("");
    void load();
    return () => {
      mountedScope.current = "";
    };
  }, [load, scope]);
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        if (!document.hidden && !busy) void load();
      },
      open ? 5000 : 30000,
    );
    return () => window.clearInterval(timer);
  }, [load, open, busy]);
  useEffect(() => {
    if (!open) return;
    const target = dialog.current;
    const previous = document.activeElement;
    target?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      } else if (event.key === "Tab" && target) {
        const controls = Array.from(
          target.querySelectorAll<HTMLElement>(
            "button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled)",
          ),
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (
          !first ||
          (event.shiftKey &&
            (document.activeElement === first ||
              !target.contains(document.activeElement)))
        ) {
          event.preventDefault();
          (last || target).focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !target.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", keyboard, true);
    return () => {
      window.removeEventListener("keydown", keyboard, true);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [open]);
  const openSession = (key: string) => {
    if (!client.isCurrent()) return;
    const session = snapshot?.fleet.sessions.find((s) => s.sessionKey === key);
    if (
      !session?.paneId ||
      !store.get().panes.some((pane) => pane.pane_id === session.paneId)
    ) {
      setActionError(
        "The originating session is not available in this connection. Refresh and try again.",
      );
      return;
    }
    setOpen(false);
    void store.focusPane(session.paneId);
  };
  const change = async (
    item: QueueItem,
    action: string,
    extra: Record<string, unknown> = {},
  ) => {
    if (busy || !client.isCurrent()) return;
    setBusy(true);
    setActionError(null);
    let failure: string | null = null;
    try {
      await client.call(
        action === "send" ? "coordination.send" : "coordination.update",
        { id: item.id, expected_version: item.version, action, ...extra },
      );
    } catch (e) {
      failure = (e as Error).message;
    } finally {
      if (mountedScope.current === scope && client.isCurrent()) {
        setBusy(false);
        await load();
        if (failure) setActionError(failure);
      }
    }
  };
  const unresolved =
    snapshot?.items.filter((i) => ["pending", "answered"].includes(i.status))
      .length || 0;
  const repositories = [
    ...new Set(
      snapshot?.fleet.sessions
        .map((s) => s.repository)
        .filter((r): r is string => !!r) || [],
    ),
  ];
  const items =
    snapshot?.items.filter(
      (i) =>
        (!repository || i.repository === repository) &&
        (!sessionFilter || i.sessionKey === sessionFilter) &&
        (showCompleted || queueItemOpen(i)),
    ) || [];
  const sessions =
    snapshot?.fleet.sessions.filter(
      (s) => !repository || s.repository === repository,
    ) || [];
  return (
    <>
      <button
        type="button"
        className="ghost coordination-trigger"
        tabIndex={tabIndex}
        title="Needs you and fleet radar"
        aria-label={`Needs you and fleet radar${unresolved ? `, ${unresolved} requests` : ""}`}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        <Bell size={16} />
        <span className="coordination-trigger-label">
          Needs you{unresolved ? ` ${unresolved}` : ""}
        </span>
        {unresolved > 0 && (
          <span className="coordination-badge">{unresolved}</span>
        )}
      </button>
      {open &&
        createPortal(
          <div className="coordination-backdrop">
            <div
              ref={dialog}
              className="coordination-dialog"
              role="dialog"
              aria-modal="true"
              tabIndex={-1}
              aria-label="Agent coordination"
            >
              <header>
                <h2>Agent coordination</h2>
                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={busy}
                  aria-label="Refresh coordination"
                >
                  <RefreshCw size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close coordination"
                >
                  <X size={18} />
                </button>
              </header>
              <div className="coordination-actions">
                <button
                  type="button"
                  aria-pressed={tab === "queue"}
                  onClick={() => setTab("queue")}
                >
                  Needs you ({unresolved})
                </button>
                <button
                  type="button"
                  aria-pressed={tab === "fleet"}
                  onClick={() => {
                    setTab("fleet");
                    const current = snapshot?.fleet.sessions.find(
                      (s) => s.cwd === currentWorkspace?.cwd,
                    );
                    setRepository(current?.repository || "");
                  }}
                >
                  Fleet
                </button>
              </div>
              {(error || actionError) && (
                <p role="alert">{error || actionError}</p>
              )}
              {snapshot?.enabled === false && (
                <p>Coordination is not enabled for this connection.</p>
              )}
              {!snapshot && !error && <p>Loading coordination…</p>}
              {snapshot?.enabled && (
                <>
                  <label>
                    Repository
                    <select
                      value={repository}
                      onChange={(e) => setRepository(e.target.value)}
                    >
                      <option value="">All repositories</option>
                      {repositories.map((r) => (
                        <option key={r} value={r}>
                          {r.replace(/\/.git$/, "")}
                        </option>
                      ))}
                    </select>
                  </label>
                  {tab === "queue" ? (
                    <>
                      <label>
                        Session
                        <select
                          value={sessionFilter}
                          onChange={(e) => setSessionFilter(e.target.value)}
                        >
                          <option value="">All sessions</option>
                          {snapshot.fleet.sessions
                            .filter((s) => s.sessionKey)
                            .map((s) => (
                              <option
                                key={s.sessionKey}
                                value={s.sessionKey || ""}
                              >
                                {s.provider} · {s.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label className="coordination-row">
                        <input
                          type="checkbox"
                          checked={showCompleted}
                          onChange={(e) => setShowCompleted(e.target.checked)}
                        />
                        Show completed and dismissed
                      </label>
                      {!items.length && <p>No requests in this view.</p>}
                      {items.map((item) => (
                        <RequestCard
                          key={item.id}
                          item={item}
                          snapshot={snapshot}
                          busy={busy}
                          change={(i, action, extra) =>
                            void change(i, action, extra)
                          }
                          openSession={openSession}
                        />
                      ))}
                    </>
                  ) : (
                    <>
                      {!snapshot.fleet.fresh && (
                        <p role="status">
                          Fleet information is stale. Refresh before relying on
                          checkout availability.
                        </p>
                      )}
                      {!sessions.length && (
                        <p>No agent sessions in this view.</p>
                      )}
                      {sessions.map((s, index) => (
                        <article
                          className="coordination-card"
                          key={s.sessionKey || `${s.paneId}-${index}`}
                        >
                          <div className="coordination-row">
                            <AgentIcon agent={s.provider} compact />
                            <strong>{s.name}</strong>
                            <span>{s.status}</span>
                          </div>
                          <p>{s.cwd}</p>
                          <small>
                            {s.branch || "No Git branch"}
                            {s.observedAt
                              ? ` · Last observed ${new Date(s.observedAt).toLocaleString()}`
                              : ""}
                          </small>
                          {s.task && <p>{s.task}</p>}
                          {s.sharedCheckout && (
                            <p role="status">
                              Shared checkout: another live session is using
                              this directory. Use a separate worktree for
                              independent edits.
                            </p>
                          )}
                          <button
                            type="button"
                            disabled={!s.sessionKey}
                            onClick={() =>
                              s.sessionKey && openSession(s.sessionKey)
                            }
                          >
                            Open session
                          </button>
                        </article>
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
