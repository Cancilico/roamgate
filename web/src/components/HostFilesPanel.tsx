import { publishFileSaved } from "../fileEditorSaved";
import {
  editorBufferDirty,
  editorLeaseChanged,
  confirmsEditorWrite,
  type EditorBuffer,
} from "../fileEditorState";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { type ConnectionClient } from "../api";
import { store, useStoreSelector } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import {
  subscribeFileEditorRequests,
  registerFileEditorGuard,
  type FileEditorRequest,
} from "../fileEditorNavigation";
import type { EditorDocument, EditorWrite } from "../../../shared/fileEditor";
import type { FileExplorerEntry, FilePreview } from "../types";
import { FilePreviewContent } from "./FilePreviewContent";
import { FilesystemBrowser } from "./FilesystemBrowser";
import { ConfirmDialog, TextInputDialog } from "./ModalDialogs";
import { bumpFileExplorerRefresh } from "../fileExplorerRefresh";
import { invalidateFilePreviewCache } from "./fileExplorerResources";
import { refreshGitDiffSummary } from "../gitDiffSummaryStore";
import { relativePathWithinCheckout } from "../workspaceResource";
import { workspaceFileUrl } from "../workspaceFileUrl";
import { downloadFileFromUrl } from "../downloadFile";
import { parentFilesystemPath } from "../filesystemPaths";
import { focusDialogElement } from "./dialogFocus";
import "./HostFilesPanel.css";
const FileCodeEditor = lazy(() =>
  import("./FileCodeEditor").then((m) => ({ default: m.FileCodeEditor })),
);

async function editorCall(
  client: ConnectionClient,
  method: string,
  params: object,
) {
  if (!client.isCurrent())
    throw new Error(
      "The host connection is not ready. Your edits are retained; try again after reconnecting.",
    );
  const response = await client.call(
    method,
    params as Record<string, unknown>,
    35000,
  );
  if (!client.isCurrent())
    throw new Error("The connection changed. Your edits are still in memory.");
  if (!response.ok)
    throw Object.assign(new Error(response.error.message), {
      code: response.error.code,
    });
  return response.result;
}

export function HostFilesPanel() {
  const client = useConnectionClient();
  const connections = useStoreSelector((s) => s.connections);
  const status = useStoreSelector((s) => s.status);
  const [owner, setOwner] = useState<ConnectionClient | null>(null);
  const [visible, setVisible] = useState(false);
  const [directory, setDirectory] = useState("");
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [buffer, setBuffer] = useState<EditorBuffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [missing, setMissing] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [pathDialog, setPathDialog] = useState<"open" | "save" | null>(null);
  const [pathDefault, setPathDefault] = useState("");
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [overwrite, setOverwrite] = useState<EditorWrite | null>(null);
  const [disk, setDisk] = useState<EditorDocument | null>(null);
  const [refresh, setRefresh] = useState(0);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const sequence = useRef(0);
  const continuation = useRef<(() => void) | null>(null);
  const state = useRef({ buffer, busy, owner, directory, client });
  state.current = { buffer, busy, owner, directory, client };
  const dirty = editorBufferDirty(buffer);
  const stale =
    owner && (status !== "connected" || editorLeaseChanged(owner, client));
  const hostLabel =
    connections.find((c) => c.id === owner?.connectionId)?.label ??
    owner?.connectionId ??
    client.connectionId;

  useEffect(() => {
    if (pending) return focusDialogElement(cancelButton.current);
  }, [pending]);
  function guard(action: () => void) {
    if (state.current.busy) {
      setVisible(true);
      return false;
    }
    if (editorBufferDirty(state.current.buffer)) {
      setVisible(true);
      setPending(() => action);
      return false;
    }
    return true;
  }
  function replace(action: () => void) {
    if (guard(action)) action();
  }
  useEffect(
    () =>
      registerFileEditorGuard((next) => {
        if (
          !guard(() => {
            closeNow();
            next();
          })
        )
          return false;
        closeNow();
        return true;
      }),
    [],
  );
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!editorBufferDirty(state.current.buffer) && !state.current.busy)
        return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  useEffect(() => {
    const handler = (request: FileEditorRequest) => {
      if (
        request.connectionId &&
        request.connectionId !== state.current.client.connectionId
      )
        return;
      const action = () => {
        const current = state.current.client;
        setOwner(current);
        setVisible(true);
        setError("");
        setNotice("");
        if (state.current.owner?.connectionId !== current.connectionId) {
          setBuffer(null);
          setPreview(null);
          setDirectory("");
        }
        if (request.newFile) {
          newBuffer("", request.base);
          return;
        }
        if (request.path)
          void openPath(current, request.path, request.base, request.edit);
        else {
          setPathDefault(
            request.base ? `${request.base.replace(/\/$/, "")}/` : "~/",
          );
          setPathDialog("open");
        }
      };
      if (guard(action)) action();
    };
    return subscribeFileEditorRequests(handler);
  }, []);
  function closeNow() {
    continuation.current = null;
    sequence.current++;
    setVisible(false);
    setBuffer(null);
    setPreview(null);
    setDisk(null);
    setMissing("");
    setPending(null);
    setPathDialog(null);
  }
  function newBuffer(path = "", base?: string) {
    sequence.current++;
    setPreview(null);
    setDisk(null);
    setMissing("");
    setError("");
    setNotice("");
    if (base) setDirectory(base);
    const next = {
      key: sequence.current,
      document: null,
      path,
      text: "",
      initialText: "",
    };
    state.current.buffer = next;
    setBuffer(next);
  }
  async function openPath(
    target: ConnectionClient,
    path: string,
    base?: string,
    edit = false,
  ) {
    const request = ++sequence.current;
    state.current.busy = true;
    setBusy(true);
    setError("");
    setNotice("");
    setMissing("");
    setDisk(null);
    let resolved = "";
    try {
      const result = await editorCall(target, "file.editor_path", {
        path,
        base,
      });
      resolved = result.path;
      const file: FilePreview = await target.call("file.read", {
        scope: "filesystem",
        path: resolved,
      });
      if (request !== sequence.current || !target.isCurrent()) return;
      setOwner(target);
      setBuffer(null);
      if (file.type === "directory") {
        setDirectory(resolved);
        setPreview(null);
        return;
      }
      setDirectory(parentFilesystemPath(resolved));
      setPreview(file);
      if (edit) {
        const document = await editorCall(target, "file.editor_read", {
          path: resolved,
        });
        if (request !== sequence.current) return;
        setBuffer({
          key: request,
          document,
          path: resolved,
          text: document.text,
          initialText: document.text,
        });
      }
    } catch (e) {
      if (request !== sequence.current) return;
      setError((e as Error).message);
      // file.read is a legacy RPC without structured errno; confirm absence using editor-read.
      if (resolved && target.isCurrent()) {
        try {
          await editorCall(target, "file.editor_read", { path: resolved });
        } catch (reason) {
          if (
            (reason as { code?: string }).code === "ENOENT" &&
            request === sequence.current
          )
            setMissing(resolved);
        }
      }
    } finally {
      if (request === sequence.current) {
        state.current.busy = false;
        setBusy(false);
      }
    }
  }
  function refreshSaved(target: ConnectionClient, document: EditorDocument) {
    for (const workspace of store.get().workspaces) {
      const root = workspace.worktree?.checkout_path ?? workspace.cwd ?? "";
      const relative = relativePathWithinCheckout(
        root,
        document.canonical_path,
      );
      if (relative === undefined) continue;
      invalidateFilePreviewCache(target, workspace.workspace_id, relative);
      invalidateFilePreviewCache(target, workspace.workspace_id, document.path);
      bumpFileExplorerRefresh(target, workspace.workspace_id);
      void refreshGitDiffSummary(
        target,
        workspace.workspace_id,
        "working",
      ).catch(() => {});
    }
    publishFileSaved(target, document);
    setRefresh((value) => value + 1);
  }
  async function write(params: EditorWrite): Promise<boolean> {
    const target = state.current.owner;
    if (!target || state.current.busy) return false;
    state.current.busy = true;
    setBusy(true);
    setError("");
    setNotice("");
    let saved = false;
    try {
      let document: EditorDocument;
      try {
        document = await editorCall(target, "file.write", params);
      } catch (reason) {
        const code = (reason as { code?: string }).code;
        if (code && code !== "REMOTE_ERROR") throw reason;
        // A lost reply does not imply a failed write. Never retry it blindly.
        const current = await editorCall(target, "file.editor_read", {
          path: params.path,
        });
        if (!confirmsEditorWrite(current, params)) throw reason;
        document = current;
      }
      if (!target.isCurrent())
        throw new Error("Connection changed; your buffer has been retained.");
      setBuffer((current) =>
        current ? { ...current, document, path: document.path } : current,
      );
      setDirectory(parentFilesystemPath(document.path));
      setDisk(null);
      setMissing("");
      setNotice("Saved");
      refreshSaved(target, document);
      saved = true;
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      state.current.busy = false;
      setBusy(false);
      if (!saved) continuation.current = null;
      if (saved && continuation.current) {
        const next = continuation.current;
        continuation.current = null;
        next();
      }
    }
  }
  async function save(): Promise<boolean> {
    const current = state.current.buffer;
    if (!current) return true;
    if (current.document && current.text === current.document.text) return true;
    if (!current.path) {
      setPathDefault(`${state.current.directory || "~"}/`);
      setPathDialog("save");
      return false;
    }
    return write({
      path: current.path,
      text: current.text,
      expected_revision: current.document?.revision ?? null,
      canonical_path: current.document?.canonical_path,
      bom: current.document?.bom ?? false,
      newline: current.document?.newline ?? "lf",
    });
  }
  async function saveAs(path: string) {
    const current = state.current.buffer,
      target = state.current.owner;
    if (!current || !target || state.current.busy) return;
    setBusy(true);
    setError("");
    let params: EditorWrite | null = null;
    try {
      const resolved = await editorCall(target, "file.editor_path", {
        path,
        base: state.current.directory || undefined,
      });
      params = {
        path: resolved.path,
        text: current.text,
        expected_revision: null,
        bom: current.document?.bom ?? false,
        newline: current.document?.newline ?? "lf",
      };
      try {
        const existing = await editorCall(target, "file.editor_read", {
          path: resolved.path,
        });
        setOverwrite({
          ...params,
          expected_revision: existing.revision,
          canonical_path: existing.canonical_path,
        });
        params = null;
      } catch (reason) {
        if ((reason as { code?: string }).code !== "ENOENT") throw reason;
      }
      setPathDialog(null);
    } catch (e) {
      setError((e as Error).message);
      params = null;
    } finally {
      setBusy(false);
      state.current.busy = false;
    }
    if (params) await write(params);
  }
  async function compare() {
    if (!owner || !buffer?.path) return;
    setBusy(true);
    setError("");
    try {
      setDisk(
        await editorCall(owner, "file.editor_read", { path: buffer.path }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const entry: FileExplorerEntry | null = preview
    ? {
        name: preview.path.split(/[\\/]/).pop()!,
        path: preview.path,
        type: preview.type ?? "file",
        size: preview.size,
        mtime_ms: preview.mtime_ms,
        hidden: false,
      }
    : null;
  if (!visible) return null;
  return (
    <aside
      className="host-files-panel"
      aria-label="Host files"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="host-files-header">
        <strong>Files</strong>
        <span className="host-files-host">{hostLabel}</span>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() =>
            replace(() => {
              if (owner?.connectionId !== client.connectionId) {
                setBuffer(null);
                setPreview(null);
                setDirectory("");
              }
              setOwner(client);
              setPathDefault(
                `${owner?.connectionId === client.connectionId ? directory || "~" : "~"}/`,
              );
              setPathDialog("open");
            })
          }
        >
          Open path...
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy || !!stale}
          onClick={() => replace(() => newBuffer())}
        >
          New file
        </button>
        <button
          type="button"
          className="ghost"
          aria-label="Close file editor"
          onClick={() => replace(closeNow)}
        >
          Close
        </button>
      </header>
      {stale ? (
        <p role="alert">
          Connection changed. Edits remain in memory. Return to the original
          host to continue.
          {owner?.connectionId === client.connectionId ? (
            <button
              disabled={status !== "connected"}
              onClick={() => {
                setOwner(client);
                setError("");
                setNotice(
                  "Reconnected. Compare with disk before saving; revision checks still apply.",
                );
              }}
            >
              Reconnect editor
            </button>
          ) : null}
        </p>
      ) : null}
      {error ? (
        <p className="modal-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {missing ? (
        <p>
          File does not exist: {missing}{" "}
          <button
            onClick={() =>
              replace(() => newBuffer(missing, parentFilesystemPath(missing)))
            }
          >
            Create file
          </button>
        </p>
      ) : null}
      {buffer ? (
        <>
          <div className="host-files-toolbar">
            <span className="host-files-path" title={buffer.path}>
              {buffer.path || "Untitled"}
              {dirty ? " *" : ""}
            </span>
            <button disabled={busy || !!stale} onClick={() => void save()}>
              Save
            </button>
            <button
              className="ghost"
              disabled={busy || !!stale}
              onClick={() => {
                setPathDefault(buffer.path || `${directory || "~"}/`);
                setPathDialog("save");
              }}
            >
              Save As...
            </button>
            <button
              className="ghost"
              disabled={busy || !buffer.document || !!stale}
              onClick={() => void compare()}
            >
              Compare with disk
            </button>
            <button
              className="ghost"
              disabled={busy || !!stale}
              onClick={() =>
                replace(() =>
                  buffer.path && owner
                    ? void openPath(owner, buffer.path)
                    : newBuffer(),
                )
              }
            >
              {dirty ? "Discard changes" : "Preview"}
            </button>
          </div>
          <div className={`host-files-editors ${disk ? "is-comparing" : ""}`}>
            <div className="host-files-buffer">
              <span>Your edits</span>
              <Suspense fallback={<p>Loading editor...</p>}>
                <FileCodeEditor
                  key={buffer.key}
                  initialText={buffer.initialText}
                  path={buffer.path}
                  readOnly={busy || !!stale}
                  onChange={(text) => {
                    setNotice("");
                    setBuffer((current) =>
                      current ? { ...current, text } : current,
                    );
                  }}
                  onSave={() => {
                    if (!state.current.busy) void save();
                  }}
                />
              </Suspense>
            </div>
            {disk ? (
              <div className="host-files-buffer">
                <span>Current disk contents</span>
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() =>
                    replace(() => {
                      setBuffer({
                        key: ++sequence.current,
                        document: disk,
                        path: disk.path,
                        text: disk.text,
                        initialText: disk.text,
                      });
                      setDisk(null);
                    })
                  }
                >
                  Discard edits and reload disk
                </button>
                <pre>{disk.text}</pre>
                <button className="ghost" onClick={() => setDisk(null)}>
                  Close comparison
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : stale ? null : (
        <div className="host-files-browse">
          {owner && directory ? (
            <FilesystemBrowser
              key={`${owner.connectionId}:${owner.generation}:${directory}:${refresh}`}
              client={owner}
              initialPath={directory}
              showHidden={showHidden}
              onShowHiddenChange={setShowHidden}
              onDirectoryChange={setDirectory}
              onSelect={(file) =>
                replace(() => void openPath(owner, file.path))
              }
              onMenu={(file) => {
                if (file.type !== "directory")
                  replace(() => void openPath(owner, file.path));
              }}
              onExit={() => replace(closeNow)}
            />
          ) : null}
          <div className="host-files-detail">
            {preview && owner ? (
              <div className="host-files-toolbar">
                <span className="host-files-path">{preview.path}</span>
                <button
                  disabled={
                    busy ||
                    (preview.binary && preview.mime_type !== "image/svg+xml") ||
                    !!stale
                  }
                  onClick={() =>
                    void openPath(owner, preview.path, undefined, true)
                  }
                >
                  Edit
                </button>
                <button
                  className="ghost"
                  onClick={() =>
                    void downloadFileFromUrl({
                      url: workspaceFileUrl(owner, "", preview.path),
                      filename: entry?.name ?? "file",
                    })
                  }
                >
                  Download
                </button>
              </div>
            ) : null}
            <FilePreviewContent
              showEdit={false}
              entry={entry}
              preview={preview}
              loading={busy}
              error={null}
              onRefresh={() => {
                if (owner && preview) void openPath(owner, preview.path);
              }}
              onOpenFile={(path) => {
                if (owner) void openPath(owner, path, directory);
              }}
            />
          </div>
        </div>
      )}
      <TextInputDialog
        open={pathDialog !== null}
        title={pathDialog === "save" ? "Save file as" : "Open host path"}
        label={`Path on ${hostLabel}`}
        initialValue={pathDefault}
        placeholder="/absolute/path or ~/file"
        submitLabel={pathDialog === "save" ? "Save" : "Open"}
        onClose={() => {
          if (!busy) {
            setPathDialog(null);
            continuation.current = null;
          }
        }}
        onSubmit={(path) => {
          if (busy) return;
          if (pathDialog === "save") void saveAs(path);
          else {
            setPathDialog(null);
            replace(
              () =>
                void openPath(owner ?? client, path, directory || undefined),
            );
          }
        }}
      />
      <ConfirmDialog
        open={!!overwrite}
        title="Replace existing file?"
        message={`Replace ${overwrite?.path}? Its revision will be checked again before saving.`}
        confirmLabel="Replace"
        onClose={() => {
          setOverwrite(null);
          continuation.current = null;
        }}
        onConfirm={() => {
          const params = overwrite;
          setOverwrite(null);
          const next = continuation.current;
          if (params)
            void write(params).then((saved) => {
              if (saved && next) next();
            });
          continuation.current = null;
        }}
      />
      {pending ? (
        <div className="modal-backdrop">
          <div
            className="modal compact-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Unsaved file changes"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !busy) {
                event.preventDefault();
                setPending(null);
              }
              if (event.key === "Tab") {
                const buttons = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                ];
                const index = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const next = event.shiftKey
                  ? (index - 1 + buttons.length) % buttons.length
                  : (index + 1) % buttons.length;
                event.preventDefault();
                buttons[next]?.focus();
              }
              event.stopPropagation();
            }}
          >
            <h2>Unsaved file changes</h2>
            <p>Save your edits before continuing?</p>
            <div className="modal-actions">
              <button
                className="ghost"
                disabled={busy}
                ref={cancelButton}
                onClick={() => setPending(null)}
              >
                Cancel
              </button>
              <button
                className="ghost"
                disabled={busy}
                onClick={() => {
                  const next = pending;
                  setPending(null);
                  setBuffer(null);
                  next();
                }}
              >
                Discard
              </button>
              <button
                disabled={busy || !!stale}
                onClick={() => {
                  continuation.current = pending;
                  setPending(null);
                  void save();
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
