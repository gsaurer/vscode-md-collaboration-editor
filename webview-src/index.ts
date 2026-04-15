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
let pendingAnchoredText: string | null = null;

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
      (commentId) => { panel.editComment(commentId); }
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

// ── New-comment floating form ─────────────────────────────────────────────────

const newCommentPanel = document.getElementById("new-comment-panel")!;
const newSelectionPreview = document.getElementById("new-selection-preview")!;
const newCommentBody = document.getElementById(
  "new-comment-body"
) as HTMLTextAreaElement;
const btnCancelComment = document.getElementById("btn-cancel-comment")!;
const btnSubmitComment = document.getElementById("btn-submit-comment")!;

function openNewCommentForm(capturedContext?: string): void {
  const context = capturedContext ?? getCursorContext();

  pendingAnchoredText = context;

  newSelectionPreview.textContent = context
    ? (context.length > 60 ? "…" + context.slice(-60) : context)
    : "(start of block)";
  newCommentBody.value = "";
  newCommentPanel.classList.add("visible");
  newCommentBody.focus();
}

function closeNewCommentForm(): void {
  newCommentPanel.classList.remove("visible");
  pendingAnchoredText = null;
}

function submitNewComment(): void {
  const body = newCommentBody.value.trim();
  if (!body) {
    return;
  }

  // Get current clean markdown from Milkdown
  let currentMarkdown = "";
  if (milkdownEditor) {
    currentMarkdown = milkdownEditor.action(getMarkdown()) ?? "";
  }

  // Notify extension host — it will inject the comment and save
  post({
    type: "addComment",
    anchoredText: pendingAnchoredText ?? "",
    body,
    markdown: currentMarkdown,
  });

  closeNewCommentForm();
}

btnCancelComment.addEventListener("click", closeNewCommentForm);
btnSubmitComment.addEventListener("click", submitNewComment);
newCommentBody.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    submitNewComment();
  }
  if (e.key === "Escape") {
    closeNewCommentForm();
  }
});

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
      panel.setComments(msg.comments);

      // Convert comments to AnchorInfo for the decoration plugin
      const anchors: AnchorInfo[] = msg.comments.map((c) => ({
        commentId: c.id,
        anchoredText: c.anchoredText,
        author: c.author,
        body: c.body,
      }));

      if (!milkdownEditor) {
        milkdownEditor = await createEditor(msg.markdown, anchors);
      } else {
        setEditorContent(msg.markdown, anchors);
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

// ── Ready signal ──────────────────────────────────────────────────────────────

post({ type: "ready" });

