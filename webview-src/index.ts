/**
 * index.ts — Webview entry point
 *
 * Wires together:
 *   - VS Code webview API (message passing)
 *   - Milkdown WYSIWYG editor
 *   - Comment anchor decorations (ProseMirror Plugin)
 *   - Comment panel (right pane)
 *   - New-comment floating form
 */

// ── Image path resolution ────────────────────────────────────────────────────
// Relative image paths are rewritten to their webview-resource URIs BEFORE
// the markdown reaches Milkdown, so the browser never tries a relative fetch.
// On save the webview URIs are stripped back out so the file stays clean.

declare const __resourceBase: string | undefined;
const resourceBase: string =
  typeof __resourceBase !== "undefined" ? __resourceBase : "";

function resolveImagePaths(markdown: string): string {
  if (!resourceBase) return markdown;
  const base = resourceBase.replace(/\/$/, "");
  return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
    if (/^(https?:|data:|vscode-webview-resource:|vscode-resource:)/i.test(src)) return match;
    return `![${alt}](${base}/${src.replace(/^\.\//,"")})` ;
  });
}

function unresolveImagePaths(markdown: string): string {
  if (!resourceBase) return markdown;
  const base = resourceBase.replace(/\/$/, "");
  return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
    if (src.startsWith(base + "/")) return `![${alt}](${src.slice(base.length + 1)})`;
    return match;
  });
}

// ── Debug info bar ───────────────────────────────────────────────────────────
// Shows the exact src/href the webview sees when hovering over images or links.
// Uses a fixed overlay bar so ProseMirror re-renders can't interfere.

const debugBar = document.createElement("div");
debugBar.style.cssText = [
  "position:fixed", "bottom:0", "left:0", "right:0",
  "background:#1e1e1e", "color:#d4d4d4", "font:12px/24px monospace",
  "padding:0 12px", "z-index:9999", "display:none",
  "white-space:nowrap", "overflow:hidden", "text-overflow:ellipsis",
  "border-top:1px solid #555",
].join(";");
document.body.appendChild(debugBar);

document.addEventListener("mouseover", (e: MouseEvent) => {
  const target = e.target as Element;
  const img = target.closest("img") as HTMLImageElement | null;
  const a = target.closest("a") as HTMLAnchorElement | null;
  if (img) {
    debugBar.textContent = `img src: ${img.getAttribute("src") ?? "(none)"}`;
    debugBar.style.display = "block";
  } else if (a) {
    debugBar.textContent = `link href: ${a.getAttribute("href") ?? "(none)"}`;
    debugBar.style.display = "block";
  } else {
    debugBar.style.display = "none";
  }
});

import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
} from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { getMarkdown, replaceAll, callCommand } from "@milkdown/utils";
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
  turnIntoTextCommand,
  insertHrCommand,
} from "@milkdown/preset-commonmark";
import {
  insertTableCommand,
  addRowBeforeCommand,
  addRowAfterCommand,
  addColBeforeCommand,
  addColAfterCommand,
  deleteSelectedCellsCommand,
  selectRowCommand,
  selectColCommand,
} from "@milkdown/preset-gfm";
import { cellAround, TableMap } from "prosemirror-tables";

import { EditorView } from "prosemirror-view";

import {
  createAnchorPlugin,
  setAnchors,
  AnchorInfo,
} from "./commentPlugin";
import { CommentPanel, CommentData } from "./commentPanel";
import mermaid from "mermaid";

// ── VS Code API ───────────────────────────────────────────────────────────────

declare function acquireVsCodeApi(): {
  postMessage(msg: object): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const post = (msg: object) => vscode.postMessage(msg);

// ── Mermaid diagram rendering ─────────────────────────────────────────────────
// SVGs are placed into #mermaid-layer, a sibling of #editor that ProseMirror
// never manages. We never touch ProseMirror's DOM, so no feedback loops.

mermaid.initialize({
  startOnLoad: false,
  theme: (document.body.getAttribute("data-vscode-theme-kind") ?? "").includes("light") ? "default" : "dark",
});

const mermaidSvgCache = new Map<string, string>(); // definition → rendered SVG
let mermaidDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let mermaidRendering = false;
let mermaidPendingAfterRender = false;

function positionMermaidOverlays(): void {
  const pane = document.getElementById("editor")!;
  const layer = document.getElementById("mermaid-layer")!;
  const paneRect = pane.getBoundingClientRect();
  layer.innerHTML = "";
  const blocks = document.querySelectorAll<HTMLElement>('pre[data-language="mermaid"]');
  for (const pre of Array.from(blocks)) {
    const def = (pre.textContent ?? "").trim();
    const svg = mermaidSvgCache.get(def);
    if (!svg) continue;
    const rect = pre.getBoundingClientRect();
    const container = document.createElement("div");
    container.className = "mermaid-output";
    container.style.top  = `${rect.top  - paneRect.top  + pane.scrollTop}px`;
    container.style.left = `${rect.left - paneRect.left}px`;
    container.style.width = `${rect.width}px`;
    container.style.minHeight = `${rect.height}px`;
    container.innerHTML = svg;
    layer.appendChild(container);
  }
}

async function renderMermaidDiagrams(): Promise<void> {
  if (mermaidRendering) { mermaidPendingAfterRender = true; return; }
  mermaidRendering = true;
  try {
    const blocks = document.querySelectorAll<HTMLElement>('pre[data-language="mermaid"]');
    for (const pre of Array.from(blocks)) {
      const def = (pre.textContent ?? "").trim();
      if (!def || mermaidSvgCache.has(def)) continue;
      const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
      try {
        const { svg } = await mermaid.render(id, def);
        mermaidSvgCache.set(def, svg);
      } catch (err) {
        console.warn("[mermaid] render failed:", err);
        // Don't cache failures so they can be retried once the diagram is valid
      }
    }
    positionMermaidOverlays();
  } finally {
    mermaidRendering = false;
    if (mermaidPendingAfterRender) {
      mermaidPendingAfterRender = false;
      scheduleMermaidRender();
    }
  }
}

function scheduleMermaidRender(): void {
  if (mermaidDebounceTimer) clearTimeout(mermaidDebounceTimer);
  mermaidDebounceTimer = setTimeout(() => { renderMermaidDiagrams(); }, 400);
}

// Watch ProseMirror's DOM for content changes. We only write to #mermaid-layer
// (outside #editor), so our own mutations never re-trigger this observer.
const mermaidObserver = new MutationObserver(scheduleMermaidRender);
mermaidObserver.observe(document.getElementById("editor")!, { childList: true, subtree: true });

// ── State ─────────────────────────────────────────────────────────────────────

let milkdownEditor: Editor | null = null;
let editorView: EditorView | null = null;
/** Guard: don't echo edits back to host while we're applying an update */
let suppressEdit = false;
/** Snapshot of the last known comment list and anchors (for scroll/resize repositioning) */
let latestComments: CommentData[] = [];
let latestAnchors: AnchorInfo[] = [];
let currentUser = { name: "Me", email: "" };

// ── Scroll editor to a comment anchor ────────────────────────────────────────

function scrollToComment(commentId: string): void {
  if (!editorView) return;
  const el = editorView.dom.querySelector<HTMLElement>(
    `[data-comment-id="${commentId}"]`
  );
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// ── Comment panel ─────────────────────────────────────────────────────────────

const panel = new CommentPanel("threads-container", post, scrollToComment);

// ── Toolbar ───────────────────────────────────────────────────────────────────

function runCommand<T>(cmd: { key: string }, payload?: T): void {
  if (!milkdownEditor) return;
  milkdownEditor.action(callCommand(cmd.key, payload as never));
  // Return focus to the editor after toolbar interaction
  milkdownEditor.action((ctx) => { ctx.get(editorViewCtx).focus(); });
}

function isInTable(): boolean {
  if (!editorView) return false;
  const { $from } = editorView.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "table") return true;
  }
  return false;
}

function getCurrentRowCol(): { row: number; col: number } | null {
  if (!editorView) return null;
  const { state } = editorView;
  const $cell = cellAround(state.selection.$from);
  if (!$cell) return null;
  const table = $cell.node(-1);
  const tableStart = $cell.start(-1);
  const map = TableMap.get(table);
  const cellPos = $cell.pos - tableStart;
  const cell = map.findCell(cellPos);
  return { row: cell.top, col: cell.left };
}

function updateToolbarState(): void {
  if (!editorView) return;
  const { state } = editorView;
  const { from, $from } = state.selection;
  const parent = $from.node(1) ?? $from.node();

  // Block type selector
  const sel = document.getElementById("tb-block-type") as HTMLSelectElement;
  if (sel) {
    const typeName = parent.type.name;
    const level = parent.attrs?.level;
    if (typeName === "heading" && level) sel.value = `h${level}`;
    else sel.value = "paragraph";
  }

  // Active mark buttons
  const marks = state.storedMarks ?? state.selection.$from.marks();
  const activeMarks = new Set(marks.map((m) => m.type.name));
  state.doc.nodesBetween(from, from, (n) => {
    n.marks.forEach((m) => activeMarks.add(m.type.name));
  });
  document.getElementById("tb-bold")?.classList.toggle("active", activeMarks.has("strong"));
  document.getElementById("tb-italic")?.classList.toggle("active", activeMarks.has("em"));
  document.getElementById("tb-code")?.classList.toggle("active", activeMarks.has("code_inline"));

  // Show/hide table toolbar section
  const tableTools = document.getElementById("tb-table-tools");
  if (tableTools) tableTools.style.display = isInTable() ? "flex" : "none";
}

// Block type dropdown
document.getElementById("tb-block-type")!.addEventListener("change", (e) => {
  const val = (e.target as HTMLSelectElement).value;
  if (val === "paragraph") runCommand(turnIntoTextCommand);
  else runCommand(wrapInHeadingCommand, parseInt(val.slice(1)));
});

// Format buttons
document.getElementById("tb-bold")!.addEventListener("mousedown",  (e) => { e.preventDefault(); runCommand(toggleStrongCommand); });
document.getElementById("tb-italic")!.addEventListener("mousedown", (e) => { e.preventDefault(); runCommand(toggleEmphasisCommand); });
document.getElementById("tb-code")!.addEventListener("mousedown",   (e) => { e.preventDefault(); runCommand(toggleInlineCodeCommand); });
document.getElementById("tb-ul")!.addEventListener("mousedown",     (e) => { e.preventDefault(); runCommand(wrapInBulletListCommand); });
document.getElementById("tb-ol")!.addEventListener("mousedown",     (e) => { e.preventDefault(); runCommand(wrapInOrderedListCommand); });
document.getElementById("tb-quote")!.addEventListener("mousedown",  (e) => { e.preventDefault(); runCommand(wrapInBlockquoteCommand); });
document.getElementById("tb-hr")!.addEventListener("mousedown",     (e) => { e.preventDefault(); runCommand(insertHrCommand); });
document.getElementById("tb-table")!.addEventListener("mousedown",  (e) => { e.preventDefault(); runCommand(insertTableCommand, { row: 3, col: 3 }); });

document.getElementById("tb-add-comment")!.addEventListener("mousedown", (e) => { e.preventDefault(); openNewCommentForm(); });

// Table editing buttons (shown only when cursor is in a table)
document.getElementById("tb-row-before")!.addEventListener("mousedown",  (e) => { e.preventDefault(); runCommand(addRowBeforeCommand); });
document.getElementById("tb-row-after")!.addEventListener("mousedown",   (e) => { e.preventDefault(); runCommand(addRowAfterCommand); });
document.getElementById("tb-del-row")!.addEventListener("mousedown",     (e) => {
  e.preventDefault();
  const pos = getCurrentRowCol();
  if (pos === null) return;
  milkdownEditor?.action(callCommand(selectRowCommand.key, { index: pos.row }));
  milkdownEditor?.action(callCommand(deleteSelectedCellsCommand.key));
  milkdownEditor?.action((ctx) => { ctx.get(editorViewCtx).focus(); });
});
document.getElementById("tb-col-before")!.addEventListener("mousedown",  (e) => { e.preventDefault(); runCommand(addColBeforeCommand); });
document.getElementById("tb-col-after")!.addEventListener("mousedown",   (e) => { e.preventDefault(); runCommand(addColAfterCommand); });
document.getElementById("tb-del-col")!.addEventListener("mousedown",     (e) => {
  e.preventDefault();
  const pos = getCurrentRowCol();
  if (pos === null) return;
  milkdownEditor?.action(callCommand(selectColCommand.key, { index: pos.col }));
  milkdownEditor?.action(callCommand(deleteSelectedCellsCommand.key));
  milkdownEditor?.action((ctx) => { ctx.get(editorViewCtx).focus(); });
});

// ── Milkdown setup ────────────────────────────────────────────────────────────

async function createEditor(
  initialMarkdown: string,
  anchors: AnchorInfo[]
): Promise<Editor> {
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, document.getElementById("editor")!);
      ctx.set(defaultValueCtx, initialMarkdown);

      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        if (suppressEdit) {
          return;
        }
        debouncedEdit(markdown);
      });

      ctx.get(listenerCtx).updated((_ctx, _doc, _prevDoc) => {
        requestAnimationFrame(updateToolbarState);
      });
    })
    .use(commonmark)
    .use(gfm)
    .use(listener)
    .create();

  // Access the underlying ProseMirror view and inject our anchor decoration plugin
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    editorView = view as unknown as EditorView;

    // Update toolbar on every selection change
    const originalDispatch = view.dispatch.bind(view);
    (view as { dispatch: typeof view.dispatch }).dispatch = (tr) => {
      originalDispatch(tr);
      if (tr.selectionSet || tr.docChanged) requestAnimationFrame(updateToolbarState);
    };

    const anchorPlugin = createAnchorPlugin(
      anchors,
      (commentId) => { panel.focusComment(commentId); }
    );
    const newState = view.state.reconfigure({
      plugins: [...view.state.plugins, anchorPlugin],
    });
    view.updateState(newState);
  });

  return editor;
}

function setEditorContent(markdown: string, anchors: AnchorInfo[]): void {
  if (!milkdownEditor) {
    return;
  }
  suppressEdit = true;
  milkdownEditor.action(replaceAll(markdown));
  // Update anchors after the doc settles
  requestAnimationFrame(() => {
    if (editorView) {
      setAnchors(
        editorView as Parameters<typeof setAnchors>[0],
        anchors
      );
    }
    suppressEdit = false;
    panel.positionCards();
  });
}

// ── Debounced edit sender ─────────────────────────────────────────────────────

let editTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedEdit(markdown: string): void {
  if (editTimer) {
    clearTimeout(editTimer);
  }
  editTimer = setTimeout(() => {
    post({ type: "edit", markdown: unresolveImagePaths(markdown) });
  }, 400);
}

// ── Selection helpers ───────────────────────────────────────────────────────────

/**
 * Returns a short plain-text snippet of the text immediately before the cursor
 * in the current ProseMirror block. Used as a positional context to locate
 * where to insert the comment tag in the markdown (and where to show the icon).
 */
function getCursorContext(): string {
  if (!editorView) return "";
  const { from } = editorView.state.selection;
  const $from = editorView.state.doc.resolve(from);
  const nodeText = $from.node().textContent;
  const offset = $from.parentOffset;
  const before = nodeText.slice(0, offset);
  return before.length <= 30 ? before : before.slice(-30);
}

// ── New-comment form (posts immediately, opens edit mode on round-trip) ───────

/** ID of the comment we just created and are waiting to open in edit mode */
let pendingNewCommentId: string | null = null;

function generateClientId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

function openNewCommentForm(capturedContext?: string): void {
  const context = capturedContext ?? getCursorContext();
  const id = generateClientId();
  pendingNewCommentId = id;

  let currentMarkdown = "";
  if (milkdownEditor) currentMarkdown = milkdownEditor.action(getMarkdown()) ?? "";

  post({ type: "addComment", id, anchoredText: context, body: "\u200b", markdown: currentMarkdown });
}

// ── Keyboard shortcut: Ctrl+Shift+; ──────────────────────────────────────────

document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.ctrlKey && e.shiftKey && e.key === ";") {
    e.preventDefault();
    e.stopPropagation();
    openNewCommentForm();
  }
});

// ── Context menu ──────────────────────────────────────────────────────────────

const ctxMenu = document.getElementById("ctx-menu")!;
const ctxAddComment = document.getElementById("ctx-add-comment")!;
const ctxTableDividers = ctxMenu.querySelectorAll<HTMLElement>(".ctx-divider");
const ctxTableItems = ["ctx-table-div", "ctx-row-before", "ctx-row-after", "ctx-del-row", "ctx-col-before", "ctx-col-after", "ctx-del-col"].map((id) => document.getElementById(id)!);

function hideCtxMenu(): void {
  ctxMenu.classList.remove("visible");
}

// ── Local link interception ────────────────────────────────────────────────────
// Intercept clicks on links inside the editor. Relative .md links are handled
// by posting an openFile message to the extension host; everything else is
// allowed to bubble (external URLs are blocked by the webview CSP anyway).

document.getElementById("editor")!.addEventListener("click", (e: MouseEvent) => {
  const target = (e.target as Element).closest("a");
  if (!target) return;
  const href = target.getAttribute("href");
  if (!href) return;
  // Let anchor-fragment links (#heading) pass through unmodified
  if (href.startsWith("#")) return;
  // Only handle relative paths that point to .md files
  if (/^https?:/i.test(href) || href.startsWith("vscode-webview-resource:")) return;
  if (!/\.md$/i.test(href)) return;
  e.preventDefault();
  e.stopPropagation();
  post({ type: "openFile", relativePath: href });
});

// Capture cursor context at right-click time (before the form opens)
let contextMenuCursorContext: string = "";

document.getElementById("editor")!.addEventListener("contextmenu", (e: MouseEvent) => {
  e.preventDefault();
  contextMenuCursorContext = getCursorContext();
  // Show/hide table items based on cursor position
  const inTable = isInTable();
  ctxTableItems.forEach((el) => { if (el) el.style.display = inTable ? "" : "none"; });
  ctxMenu.style.left = e.clientX + "px";
  ctxMenu.style.top = e.clientY + "px";
  ctxMenu.classList.add("visible");
});

ctxAddComment.addEventListener("click", () => {
  hideCtxMenu();
  openNewCommentForm(contextMenuCursorContext || undefined);
});

document.getElementById("ctx-row-before")!.addEventListener("click", () => { hideCtxMenu(); runCommand(addRowBeforeCommand); });
document.getElementById("ctx-row-after")!.addEventListener("click",  () => { hideCtxMenu(); runCommand(addRowAfterCommand); });
document.getElementById("ctx-del-row")!.addEventListener("click",    () => {
  hideCtxMenu();
  const pos = getCurrentRowCol(); if (!pos) return;
  milkdownEditor?.action(callCommand(selectRowCommand.key, { index: pos.row }));
  milkdownEditor?.action(callCommand(deleteSelectedCellsCommand.key));
  milkdownEditor?.action((ctx) => { ctx.get(editorViewCtx).focus(); });
});
document.getElementById("ctx-col-before")!.addEventListener("click", () => { hideCtxMenu(); runCommand(addColBeforeCommand); });
document.getElementById("ctx-col-after")!.addEventListener("click",  () => { hideCtxMenu(); runCommand(addColAfterCommand); });
document.getElementById("ctx-del-col")!.addEventListener("click",    () => {
  hideCtxMenu();
  const pos = getCurrentRowCol(); if (!pos) return;
  milkdownEditor?.action(callCommand(selectColCommand.key, { index: pos.col }));
  milkdownEditor?.action(callCommand(deleteSelectedCellsCommand.key));
  milkdownEditor?.action((ctx) => { ctx.get(editorViewCtx).focus(); });
});

document.addEventListener("click", hideCtxMenu);
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    hideCtxMenu();
  }
});

// ── Header "..." menu ─────────────────────────────────────────────────────────

const headerMoreBtn = document.getElementById("header-more-btn")!;
const headerMenu = document.getElementById("header-menu")!;

headerMoreBtn.addEventListener("click", (e: MouseEvent) => {
  e.stopPropagation();
  headerMenu.classList.toggle("open");
});

document.addEventListener("click", () => {
  headerMenu.classList.remove("open");
});

document.getElementById("menu-resolve-all")!.addEventListener("click", () => {
  headerMenu.classList.remove("open");
  post({ type: "resolveAll" });
});

document.getElementById("menu-delete-all")!.addEventListener("click", () => {
  headerMenu.classList.remove("open");
  post({ type: "deleteAll" });
});

// ── Message handling ──────────────────────────────────────────────────────────

interface UpdateMessage {
  type: "update";
  markdown: string;
  comments: CommentData[];
  currentUser: { name: string; email: string };
}

window.addEventListener("message", async (event: MessageEvent) => {
  const msg = event.data as
    | UpdateMessage
    | { type: "focusComment"; commentId: string }
    | { type: "triggerAddComment" };

  switch (msg.type) {
    case "update": {
      latestComments = msg.comments;
      latestAnchors = msg.comments.map((c) => ({
        commentId: c.id,
        anchoredText: c.anchoredText,
        author: c.author,
        body: c.body,
        date: c.date,
      }));
      if (msg.currentUser) currentUser = msg.currentUser;
      panel.setComments(msg.comments);

      // Capture pending ID before async work clears it
      const pendingId = pendingNewCommentId;
      if (pendingId) pendingNewCommentId = null;

      if (!milkdownEditor) {
        milkdownEditor = await createEditor(resolveImagePaths(msg.markdown), latestAnchors);
        requestAnimationFrame(() => {
          panel.positionCards();
          scheduleMermaidRender();
          if (pendingId && msg.comments.find((c) => c.id === pendingId)) {
            panel.editComment(pendingId, true);
          }
        });
      } else {
        setEditorContent(resolveImagePaths(msg.markdown), latestAnchors);
        // Wait for setEditorContent's rAF (anchor injection) to complete,
        // then open edit mode — double rAF ensures anchors are in the DOM
        requestAnimationFrame(() => requestAnimationFrame(() => {
          scheduleMermaidRender();
          if (pendingId && msg.comments.find((c) => c.id === pendingId)) {
            panel.positionCards();
            panel.editComment(pendingId, true);
          }
        }));
      }
      break;
    }

    case "focusComment": {
      panel.focusComment(msg.commentId);
      break;
    }

    case "triggerAddComment": {
      openNewCommentForm();
      break;
    }
  }
});
// ── Scroll / resize → reposition comment cards ──────────────────────────────

document.getElementById("editor")!.addEventListener("scroll", () => { panel.positionCards(); positionMermaidOverlays(); }, { passive: true });
window.addEventListener("resize", () => { panel.positionCards(); positionMermaidOverlays(); });
// ── Ready signal ──────────────────────────────────────────────────────────────

post({ type: "ready" });

