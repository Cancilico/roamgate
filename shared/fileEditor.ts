/** Complete editable documents are separate from potentially truncated previews. */
export const EDITOR_MAX_BYTES = 2 * 1024 * 1024;
export interface EditorDocument {
  path: string;
  canonical_path: string;
  text: string;
  revision: string;
  bom: boolean;
  newline: "lf" | "crlf";
}
export interface EditorWrite {
  path: string;
  text: string;
  /** null means create only. */
  expected_revision: string | null;
  canonical_path?: string;
  bom: boolean;
  newline: "lf" | "crlf";
}
