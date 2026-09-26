import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";

async function language(path: string): Promise<Extension> {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
    case "ts":
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: ext === "ts" || ext === "tsx",
        jsx: ext === "jsx" || ext === "tsx",
      });
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "py":
      return (await import("@codemirror/lang-python")).python();
    case "rs":
      return (await import("@codemirror/lang-rust")).rust();
    case "go":
      return (await import("@codemirror/lang-go")).go();
    case "md":
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "yaml":
    case "yml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "html":
    case "htm":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "xml":
      return (await import("@codemirror/lang-xml")).xml();
    case "c":
    case "h":
    case "cpp":
    case "hpp":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "sh":
    case "bash":
      return (await import("@codemirror/language")).StreamLanguage.define(
        (await import("@codemirror/legacy-modes/mode/shell")).shell,
      );
    case "toml":
      return (await import("@codemirror/language")).StreamLanguage.define(
        (await import("@codemirror/legacy-modes/mode/toml")).toml,
      );
    default:
      return [];
  }
}
/** Parent changes the key only for a new buffer, never for keystrokes or saves. */
export function FileCodeEditor({
  initialText,
  path,
  readOnly,
  onChange,
  onSave,
}: {
  initialText: string;
  path: string;
  readOnly: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const editable = useRef(new Compartment());
  const syntax = useRef(new Compartment());
  const initial = useRef(initialText);
  useEffect(() => {
    const editor = new EditorView({
      parent: container.current!,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          basicSetup,
          syntaxHighlighting(
            HighlightStyle.define([
              { tag: tags.comment, color: "var(--syntax-comment)" },
              { tag: tags.keyword, color: "var(--syntax-keyword)" },
              { tag: tags.string, color: "var(--syntax-string)" },
              { tag: tags.number, color: "var(--syntax-number)" },
              {
                tag: tags.function(tags.variableName),
                color: "var(--syntax-function)",
              },
              { tag: tags.propertyName, color: "var(--syntax-property)" },
              { tag: tags.typeName, color: "var(--syntax-type)" },
              { tag: tags.operator, color: "var(--syntax-operator)" },
              { tag: tags.punctuation, color: "var(--syntax-punctuation)" },
            ]),
          ),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
            indentWithTab,
          ]),
          editable.current.of(EditorState.readOnly.of(false)),
          syntax.current.of([]),
          EditorView.contentAttributes.of({ "aria-label": "File contents" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              background: "var(--viewer-code-bg)",
              color: "var(--text-code)",
            },
            ".cm-scroller": { overflow: "auto", fontFamily: "monospace" },
            ".cm-gutters, .cm-panels": {
              background: "var(--viewer-header-bg)",
              color: "var(--text)",
            },
            ".cm-cursor": { borderLeftColor: "var(--text)" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
              background: "var(--accent-soft)",
            },
          }),
        ],
      }),
    });
    view.current = editor;
    editor.focus();
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);
  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);
  useEffect(() => {
    let cancelled = false;
    void language(path)
      .then((extension) => {
        if (!cancelled)
          view.current?.dispatch({
            effects: syntax.current.reconfigure(extension),
          });
      })
      .catch(() => {
        /* Plain-text editing remains available if a grammar fails to load. */
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return (
    <div
      className="host-file-code"
      ref={container}
      onKeyDown={(event) => event.stopPropagation()}
    />
  );
}
