/**
 * commentPanel.ts
 *
 * Renders and manages the right-hand TODO comments panel.
 * Talks to the extension host via the VS Code webview API (vscode.postMessage).
 */

export interface CommentData {
  id: string;
  author: string;
  body: string;
  anchoredText: string;
}

type PostMessage = (msg: object) => void;

export class CommentPanel {
  private container: HTMLElement;
  private post: PostMessage;
  private onFocusInEditor: (commentId: string) => void;
  private comments: CommentData[] = [];
  private activeCommentId: string | null = null;
  private editingCommentId: string | null = null;

  constructor(containerId: string, post: PostMessage, onFocusInEditor: (commentId: string) => void) {
    const el = document.getElementById(containerId);
    if (!el) {
      throw new Error(`CommentPanel: element #${containerId} not found`);
    }
    this.container = el;
    this.post = post;
    this.onFocusInEditor = onFocusInEditor;
  }

  /** Replace the full comment list and re-render */
  setComments(comments: CommentData[]): void {
    this.comments = comments;
    this.render();
  }

  /** Highlight and scroll to a comment (e.g. when user clicks anchor text in the editor) */
  focusComment(commentId: string): void {
    this.activeCommentId = commentId;
    this.render();
    const el = this.container.querySelector<HTMLElement>(
      `[data-comment-id="${commentId}"]`
    );
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /** Scroll to a comment and open it in edit mode (triggered by clicking the icon) */
  editComment(commentId: string): void {
    this.activeCommentId = commentId;
    this.editingCommentId = commentId;
    this.render();
    const card = this.container.querySelector<HTMLElement>(
      `[data-comment-id="${commentId}"]`
    );
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    // Set textarea value programmatically to handle all special characters
    const textarea = card?.querySelector<HTMLTextAreaElement>(".edit-textarea");
    const comment = this.comments.find((c) => c.id === commentId);
    if (textarea && comment) {
      textarea.value = comment.body;
      textarea.focus();
      textarea.select();
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private render(): void {
    if (this.comments.length === 0) {
      this.container.innerHTML = `<div class="empty-state">No comments yet.<br/>Select text and right-click or press <kbd>Ctrl+Shift+;</kbd> to add one.</div>`;
      return;
    }

    this.container.innerHTML = this.comments.map((c) => this.renderComment(c)).join("");
    this.bindEvents();
  }

  private renderComment(comment: CommentData): string {
    const isActive = comment.id === this.activeCommentId;
    const isEditing = comment.id === this.editingCommentId;
    const classes = ["thread", isActive ? "active" : ""].filter(Boolean).join(" ");

    const preview = comment.anchoredText
      ? `<div class="thread-anchor-preview" title="${esc(comment.anchoredText)}">${esc(truncate(comment.anchoredText, 60))}</div>`
      : "";

    if (isEditing) {
      return `
    <div class="${classes}" data-comment-id="${comment.id}">
      ${preview}
      <div class="thread-meta">
        <span class="thread-author">${esc(comment.author)}</span>
      </div>
      <textarea class="edit-textarea" rows="3"></textarea>
      <div class="thread-actions">
        <button class="btn primary" data-action="save-edit" data-id="${esc(comment.id)}">Save</button>
        <button class="btn" data-action="cancel-edit">Cancel</button>
        <button class="btn danger" data-action="delete" data-id="${esc(comment.id)}">Delete</button>
      </div>
    </div>`;
    }

    return `
    <div class="${classes}" data-comment-id="${comment.id}">
      ${preview}
      <div class="thread-meta">
        <span class="thread-author">${esc(comment.author)}</span>
      </div>
      <div class="thread-body">${esc(comment.body)}</div>
      <div class="thread-actions">
        <button class="btn" data-action="start-edit">Edit</button>
        <button class="btn danger" data-action="delete" data-id="${esc(comment.id)}">Delete</button>
      </div>
    </div>`;
  }

  private bindEvents(): void {
    this.container.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = btn.dataset["action"];

        if (action === "delete") {
          const id = btn.dataset["id"] ?? "";
          this.post({ type: "deleteComment", id });
        }

        if (action === "start-edit") {
          const card = btn.closest<HTMLElement>("[data-comment-id]");
          const id = card?.dataset["commentId"];
          if (id) {
            this.editComment(id);
          }
        }

        if (action === "save-edit") {
          const card = btn.closest<HTMLElement>("[data-comment-id]");
          const textarea = card?.querySelector<HTMLTextAreaElement>(".edit-textarea");
          const newBody = textarea?.value.trim() ?? "";
          const id = btn.dataset["id"] ?? "";
          if (newBody && id) {
            this.post({ type: "editComment", id, newBody });
          }
          this.editingCommentId = null;
          this.render();
        }

        if (action === "cancel-edit") {
          this.editingCommentId = null;
          this.render();
        }
      });
    });

    // Click on comment card → scroll editor to its anchor
    this.container.querySelectorAll<HTMLElement>(".thread").forEach((card) => {
      card.addEventListener("click", () => {
        const id = card.dataset["commentId"];
        if (id) {
          this.activeCommentId = id;
          this.container
            .querySelectorAll(".thread.active")
            .forEach((el) => el.classList.remove("active"));
          card.classList.add("active");
          this.onFocusInEditor(id);
        }
      });
    });
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len) + "…" : str;
}
