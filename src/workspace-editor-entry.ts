import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { foldService } from "@codemirror/language";

export interface WorkspaceEditor {
  getValue(): string;
  setValue(value: string): void;
  focus(): void;
  destroy(): void;
  run(command: string, value?: string): void;
}

const LIST_MARKER_RE = /^(\s*)([-*+]|\d+\.)\s+/;
const HEADING_RE = /^(#{1,6})\s+/;
const QUOTE_RE = /^(\s*>\s+)/;

function leadingSpaces(text: string): number {
  const match = text.match(/^\s*/);
  return match ? match[0].length : 0;
}

function parseHeading(text: string): { level: number; markerEnd: number } | null {
  const match = text.match(HEADING_RE);
  if (!match) return null;
  return { level: match[1].length, markerEnd: match[0].length };
}

function parseListItem(text: string): { indent: number; markerEnd: number } | null {
  const match = text.match(LIST_MARKER_RE);
  if (!match) return null;
  return { indent: match[1].length, markerEnd: match[0].length };
}

function clampSelection(state: EditorState, anchor: number, head = anchor): EditorSelection {
  return EditorSelection.single(
    Math.max(0, Math.min(anchor, state.doc.length)),
    Math.max(0, Math.min(head, state.doc.length)),
  );
}

function setSelection(view: EditorView, anchor: number, head = anchor) {
  view.dispatch({ selection: clampSelection(view.state, anchor, head), scrollIntoView: true });
}

function selectedLines(state: EditorState): Array<{ number: number; from: number; to: number; text: string }> {
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.to).number;
  const lines = [];
  for (let lineNumber = first; lineNumber <= last; lineNumber++) {
    const line = state.doc.line(lineNumber);
    lines.push({ number: line.number, from: line.from, to: line.to, text: line.text });
  }
  return lines;
}

function toggleWrap(view: EditorView, prefix: string, suffix = prefix) {
  const range = view.state.selection.main;
  const selected = view.state.sliceDoc(range.from, range.to);
  const hasWrap = selected.startsWith(prefix) && selected.endsWith(suffix) && selected.length >= prefix.length + suffix.length;
  const insert = hasWrap
    ? selected.slice(prefix.length, selected.length - suffix.length)
    : `${prefix}${selected || "text"}${suffix}`;
  const anchor = hasWrap
    ? range.from
    : range.empty
      ? range.from + prefix.length
      : range.from + prefix.length;
  const head = hasWrap
    ? range.from + insert.length
    : range.empty
      ? range.from + prefix.length + 4
      : range.to + prefix.length;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: clampSelection(view.state, anchor, head),
    scrollIntoView: true,
  });
}

function setHeading(view: EditorView, level: number) {
  const prefix = `${"#".repeat(level)} `;
  const lines = selectedLines(view.state);
  const changes = [];
  for (const line of lines) {
    if (!line.text.trim()) continue;
    const next = line.text.replace(HEADING_RE, "");
    changes.push({ from: line.from, to: line.to, insert: `${prefix}${next}` });
  }
  if (changes.length === 0) return;
  view.dispatch({ changes, scrollIntoView: true });
}

function toggleLinePrefix(view: EditorView, prefix: string) {
  const lines = selectedLines(view.state);
  const active = lines.every((line) => !line.text.trim() || line.text.startsWith(prefix));
  const changes = [];
  for (const line of lines) {
    if (!line.text.trim()) continue;
    if (active && line.text.startsWith(prefix)) {
      changes.push({ from: line.from, to: line.from + prefix.length, insert: "" });
    } else if (!active) {
      changes.push({ from: line.from, to: line.from, insert: prefix });
    }
  }
  if (changes.length === 0) return;
  view.dispatch({ changes, scrollIntoView: true });
}

function toggleBulletList(view: EditorView) {
  const lines = selectedLines(view.state);
  const active = lines.every((line) => !line.text.trim() || Boolean(parseListItem(line.text)));
  const changes = [];
  for (const line of lines) {
    if (!line.text.trim()) continue;
    if (active) {
      const match = line.text.match(LIST_MARKER_RE);
      if (match) {
        changes.push({ from: line.from + match[1].length, to: line.from + match[0].length, insert: "" });
      }
    } else {
      const indent = " ".repeat(leadingSpaces(line.text));
      const content = line.text.trimStart();
      changes.push({ from: line.from, to: line.to, insert: `${indent}- ${content}` });
    }
  }
  if (changes.length === 0) return;
  view.dispatch({ changes, scrollIntoView: true });
}

function insertLink(view: EditorView) {
  const range = view.state.selection.main;
  const selected = view.state.sliceDoc(range.from, range.to) || "link";
  const insert = `[${selected}](https://)`;
  const urlStart = range.from + insert.indexOf("https://");
  const urlEnd = urlStart + "https://".length;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: clampSelection(view.state, urlStart, urlEnd),
    scrollIntoView: true,
  });
}

function toggleCodeBlock(view: EditorView) {
  const range = view.state.selection.main;
  const selected = view.state.sliceDoc(range.from, range.to);
  const hasFence = selected.startsWith("```\n") && selected.endsWith("\n```");
  const insert = hasFence ? selected.slice(4, -4) : `\`\`\`\n${selected || "code"}\n\`\`\``;
  const anchor = hasFence ? range.from : range.from + 4;
  const head = hasFence ? range.from + insert.length : range.from + insert.length - 4;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: clampSelection(view.state, anchor, head),
    scrollIntoView: true,
  });
}

function indentList(view: EditorView, delta: number): boolean {
  const lines = selectedLines(view.state);
  const targets = lines.filter((line) => Boolean(parseListItem(line.text)));
  if (targets.length === 0) return false;
  const changes = [];
  for (const line of targets) {
    if (delta > 0) {
      changes.push({ from: line.from, to: line.from, insert: "  " });
    } else {
      const remove = Math.min(2, leadingSpaces(line.text));
      if (remove > 0) changes.push({ from: line.from, to: line.from + remove, insert: "" });
    }
  }
  if (changes.length === 0) return false;
  view.dispatch({ changes, scrollIntoView: true });
  return true;
}

function continueMarkdownList(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  const match = line.text.match(/^(\s*)([-*+]|\d+\.)\s*(.*)$/);
  if (!match) return false;
  const [, indent, marker, content] = match;
  if (!content.trim()) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: indent },
      selection: clampSelection(view.state, line.from + indent.length),
      scrollIntoView: true,
    });
    return true;
  }
  const nextMarker = /^\d+\.$/.test(marker) ? `${Number(marker.slice(0, -1)) + 1}.` : marker;
  const insert = `\n${indent}${nextMarker} `;
  view.dispatch({
    changes: { from: selection.head, to: selection.head, insert },
    selection: clampSelection(view.state, selection.head + insert.length),
    scrollIntoView: true,
  });
  return true;
}

function unwrapEmptyListItem(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  const match = line.text.match(/^(\s*)([-*+]|\d+\.)\s*$/);
  if (!match) return false;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: match[1] },
    selection: clampSelection(view.state, line.from + match[1].length),
    scrollIntoView: true,
  });
  return true;
}

function headingFoldRange(state: EditorState, lineNumber: number, level: number, from: number): { from: number; to: number } | null {
  let endLine = lineNumber;
  for (let next = lineNumber + 1; next <= state.doc.lines; next++) {
    const line = state.doc.line(next);
    const heading = parseHeading(line.text);
    if (heading && heading.level <= level) break;
    endLine = next;
  }
  while (endLine > lineNumber && !state.doc.line(endLine).text.trim()) {
    endLine -= 1;
  }
  if (endLine <= lineNumber) return null;
  const to = state.doc.line(endLine).to;
  return to > from ? { from, to } : null;
}

function listFoldRange(state: EditorState, lineNumber: number, indent: number, from: number): { from: number; to: number } | null {
  let endLine = lineNumber;
  for (let next = lineNumber + 1; next <= state.doc.lines; next++) {
    const line = state.doc.line(next);
    if (!line.text.trim()) {
      if (endLine > lineNumber) endLine = next;
      continue;
    }
    if (leadingSpaces(line.text) <= indent) break;
    endLine = next;
  }
  while (endLine > lineNumber && !state.doc.line(endLine).text.trim()) {
    endLine -= 1;
  }
  if (endLine <= lineNumber) return null;
  const to = state.doc.line(endLine).to;
  return to > from ? { from, to } : null;
}

const markdownOutline = ViewPlugin.fromClass(class {
  decorations;

  constructor(view: EditorView) {
    this.decorations = this.build(view);
  }

  update(update: { docChanged: boolean; viewportChanged: boolean; view: EditorView }) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.build(update.view);
    }
  }

  build(view: EditorView) {
    const builder = new RangeSetBuilder<Decoration>();
    for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber++) {
      const line = view.state.doc.line(lineNumber);
      const classes = ["cm-md-line"];
      const heading = parseHeading(line.text);
      const list = parseListItem(line.text);
      const quote = line.text.match(QUOTE_RE);
      const indentDepth = Math.min(6, Math.floor(leadingSpaces(line.text) / 2));

      if (heading) {
        classes.push("cm-md-heading", `cm-md-heading-${heading.level}`);
        builder.add(line.from, line.from, Decoration.line({ attributes: { class: classes.join(" ") } }));
        builder.add(
          line.from,
          line.from + heading.markerEnd,
          Decoration.mark({ class: "cm-md-marker cm-md-heading-marker" }),
        );
      } else if (list) {
        classes.push("cm-md-list", `cm-md-depth-${Math.min(indentDepth, 5)}`);
        builder.add(line.from, line.from, Decoration.line({ attributes: { class: classes.join(" ") } }));
        builder.add(
          line.from + list.indent,
          line.from + list.markerEnd,
          Decoration.mark({ class: "cm-md-marker cm-md-list-marker" }),
        );
      } else if (quote) {
        classes.push("cm-md-quote");
        builder.add(line.from, line.from, Decoration.line({ attributes: { class: classes.join(" ") } }));
        builder.add(
          line.from,
          line.from + quote[1].length,
          Decoration.mark({ class: "cm-md-marker cm-md-quote-marker" }),
        );
      } else if (/^\s*```/.test(line.text)) {
        classes.push("cm-md-code-fence");
        builder.add(line.from, line.from, Decoration.line({ attributes: { class: classes.join(" ") } }));
      }
    }
    return builder.finish();
  }
}, {
  decorations: (plugin) => plugin.decorations,
});

const workspaceTheme = EditorView.theme({
  "&": {
    fontSize: "15px",
    backgroundColor: "var(--editor-bg)",
    color: "var(--editor-ink)",
    border: "1px solid var(--editor-border)",
    borderRadius: "16px",
    minHeight: "220px",
  },
  ".cm-scroller": {
    fontFamily: "\"Avenir Next\", \"Segoe UI\", sans-serif",
  },
  ".cm-content": {
    padding: "14px 16px 18px",
    minHeight: "220px",
    lineHeight: "1.65",
    caretColor: "var(--editor-cursor)",
  },
  ".cm-focused": {
    outline: "2px solid var(--editor-focus)",
    outlineOffset: "0",
  },
  ".cm-gutters": {
    backgroundColor: "var(--editor-gutter)",
    borderRight: "1px solid var(--editor-border)",
    borderTopLeftRadius: "16px",
    borderBottomLeftRadius: "16px",
    color: "var(--editor-line)",
  },
  ".cm-lineNumbers, .cm-gutter.cm-lineNumbers": {
    display: "none",
  },
  ".cm-foldGutter .cm-gutterElement": {
    color: "var(--workspace-muted)",
    cursor: "pointer",
    padding: "0 6px 0 10px",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--editor-cursor)",
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "var(--workspace-accent-soft)",
  },
  ".cm-md-marker": {
    opacity: "0.35",
    fontWeight: "600",
  },
  ".cm-md-heading": {
    fontWeight: "650",
    letterSpacing: "-0.01em",
  },
  ".cm-md-heading-1": {
    fontSize: "1.45em",
    lineHeight: "1.3",
  },
  ".cm-md-heading-2": {
    fontSize: "1.28em",
    lineHeight: "1.35",
  },
  ".cm-md-heading-3": {
    fontSize: "1.16em",
  },
  ".cm-md-list": {
    paddingLeft: "0.15rem",
  },
  ".cm-md-depth-1": {
    paddingLeft: "0.75rem",
  },
  ".cm-md-depth-2": {
    paddingLeft: "1.35rem",
  },
  ".cm-md-depth-3, .cm-md-depth-4, .cm-md-depth-5": {
    paddingLeft: "2rem",
  },
  ".cm-md-quote": {
    color: "var(--workspace-muted)",
    borderLeft: "2px solid var(--workspace-accent)",
    paddingLeft: "0.85rem",
    marginLeft: "0.15rem",
  },
  ".cm-md-code-fence": {
    fontFamily: "\"SFMono-Regular\", \"Menlo\", monospace",
    color: "var(--workspace-muted)",
  },
});

const markdownFold = foldService.of((state, lineStart, _lineEnd) => {
  const line = state.doc.lineAt(lineStart);
  const heading = parseHeading(line.text);
  if (heading) return headingFoldRange(state, line.number, heading.level, line.to);
  const list = parseListItem(line.text);
  if (list) return listFoldRange(state, line.number, list.indent, line.to);
  return null;
});

function applyCommand(view: EditorView, command: string, value?: string) {
  switch (command) {
    case "bold":
      toggleWrap(view, "**");
      break;
    case "italic":
      toggleWrap(view, "*");
      break;
    case "code":
      toggleWrap(view, "`");
      break;
    case "link":
      insertLink(view);
      break;
    case "quote":
      toggleLinePrefix(view, "> ");
      break;
    case "bullet":
      toggleBulletList(view);
      break;
    case "codeblock":
      toggleCodeBlock(view);
      break;
    case "heading":
      setHeading(view, Math.max(1, Math.min(6, Number(value ?? "2") || 2)));
      break;
  }
}

export function initEditor(
  element: HTMLElement,
  content: string,
  onChange: (nextValue: string) => void,
): WorkspaceEditor {
  let currentValue = content;

  const view = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        markdown(),
        markdownFold,
        markdownOutline,
        workspaceTheme,
        EditorView.lineWrapping,
        keymap.of([
          {
            key: "Tab",
            run: (view) => indentList(view, 1),
          },
          {
            key: "Shift-Tab",
            run: (view) => indentList(view, -1),
          },
          {
            key: "Enter",
            run: continueMarkdownList,
          },
          {
            key: "Backspace",
            run: unwrapEmptyListItem,
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          currentValue = update.state.doc.toString();
          onChange(currentValue);
        }),
      ],
    }),
    parent: element,
  });

  return {
    getValue() {
      return currentValue;
    },
    setValue(value: string) {
      currentValue = value;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: clampSelection(view.state, Math.min(view.state.selection.main.head, value.length)),
      });
    },
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
    },
    run(command: string, value?: string) {
      applyCommand(view, command, value);
      view.focus();
    },
  };
}
