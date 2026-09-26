import type { ConnectionClient } from "./api";
import type { EditorDocument } from "../../shared/fileEditor";
type SavedFile = {
  connectionId: string;
  generation: number;
  path: string;
  canonicalPath: string;
};
const listeners = new Set<(file: SavedFile) => void>();
export function publishFileSaved(
  client: ConnectionClient,
  document: EditorDocument,
) {
  const file = {
    connectionId: client.connectionId,
    generation: client.generation,
    path: document.path,
    canonicalPath: document.canonical_path,
  };
  for (const listener of listeners) listener(file);
}
export function subscribeFileSaved(
  client: ConnectionClient,
  path: string,
  refresh: () => void,
) {
  const listener = (file: SavedFile) => {
    if (
      client.isCurrent() &&
      client.connectionId === file.connectionId &&
      client.generation === file.generation &&
      (path === file.path || path === file.canonicalPath)
    )
      refresh();
  };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
