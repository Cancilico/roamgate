import type { ConnectionClient } from "./api";
import type { EditorDocument, EditorWrite } from "../../shared/fileEditor";
export type EditorBuffer = {
  key: number;
  document: EditorDocument | null;
  path: string;
  text: string;
  initialText: string;
};
export function editorBufferDirty(buffer: EditorBuffer | null) {
  return !!buffer && (!buffer.document || buffer.text !== buffer.document.text);
}
/** A failed transport reply can only be reconciled against the original target. */
export function confirmsEditorWrite(
  current: EditorDocument,
  sent: EditorWrite,
) {
  return (
    current.text === sent.text &&
    current.bom === sent.bom &&
    (current.newline === sent.newline || !sent.text.includes("\n")) &&
    (!sent.canonical_path || current.canonical_path === sent.canonical_path)
  );
}

/** Render from observable lease identity, not the bridge's mutable readiness map. */
export function editorLeaseChanged(
  owner: ConnectionClient,
  current: ConnectionClient,
) {
  return (
    owner.connectionId !== current.connectionId ||
    owner.generation !== current.generation ||
    owner.serverRuntimeGeneration !== current.serverRuntimeGeneration
  );
}
