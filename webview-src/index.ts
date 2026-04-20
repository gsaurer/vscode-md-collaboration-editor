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

import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
} from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { getMarkdown, replaceAll } from "@milkdown/utils";

import { EditorView } from "prosemirror-view";

import {
  createAnchorPlugin,
  setAnchors,
  AnchorInfo,
} from "./commentPlugin";
import { CommentPanel, CommentData } from "./commentPanel";

// ── VS Code API ───────────────────────────────────────────────────────────────

declare function acquireVsCodeApi(): {
  postMessage(msg: object): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const post = (msg: object) => vscode.postMessage(msg);

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
    })
    .use(commonmark)
    .use(gfm)
    .use(listener)
    .create();

  // Access the underlying ProseMirror view and inject our anchor decoration plugin
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    editorView = view as unknown as EditorView;

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
    post({ type: "edit", markdown });
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

function hideCtxMenu(): void {
  ctxMenu.classList.remove("visible");
}

// Capture cursor context at right-click time (before the form opens)
let contextMenuCursorContext: string = "";

document.getElementById("editor-pane")!.addEventListener("contextmenu", (e: MouseEvent) => {
  e.preventDefault();
  contextMenuCursorContext = getCursorContext();
  ctxMenu.style.left = e.clientX + "px";
  ctxMenu.style.top = e.clientY + "px";
  ctxMenu.classList.add("visible");
});

ctxAddComment.addEventListener("click", () => {
  hideCtxMenu();
  openNewCommentForm(contextMenuCursorContext || undefined);
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
        milkdownEditor = await createEditor(msg.markdown, latestAnchors);
        requestAnimationFrame(() => {
          panel.positionCards();
          if (pendingId && msg.comments.find((c) => c.id === pendingId)) {
            panel.editComment(pendingId, true);
          }
        });
      } else {
        setEditorContent(msg.markdown, latestAnchors);
        // Wait for setEditorContent's rAF (anchor injection) to complete,
        // then open edit mode — double rAF ensures anchors are in the DOM
        if (pendingId && msg.comments.find((c) => c.id === pendingId)) {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            panel.positionCards();
            panel.editComment(pendingId, true);
          }));
        }
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

document.getElementById("editor-pane")!.addEventListener("scroll", () => panel.positionCards(), { passive: true });
window.addEventListener("resize", () => panel.positionCards());
// ── Ready signal ──────────────────────────────────────────────────────────────

post({ type: "ready" });

