/**
 * commentPanel.ts
 *
 * Renders and manages the right-hand TODO comments panel.
 * Talks to the extension host via the VS Code webview API (vscode.postMessage).
 */

export interface Reply {
  id: string;
  author: string;
  body: string;
  date?: string;
}

export interface CommentData {
  id: string;
  author: string;
  body: string;
  date?: string;
  resolved?: boolean;
  replies?: Reply[];
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
  private replyingToId: string | null = null;
  private editingReply: { commentId: string; replyId: string } | null = null;

  constructor(containerId: string, post: PostMessage, onFocusInEditor: (commentId: string) => void) {
    const el = document.getElementById(containerId);
    if (!el) {
      throw new Error(`CommentPanel: element #${containerId} not found`);
    }
    this.container = el;
    this.post = post;
    this.onFocusInEditor = onFocusInEditor;
    // Close any open per-card menus when clicking outside
    document.addEventListener("click", () => {
      this.container.querySelectorAll<HTMLElement>(".thread-menu.open")
        .forEach((m) => m.classList.remove("open"));
    });
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
    this.replyingToId = null;
    this.editingReply = null;
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
    const isResolved = !!comment.resolved;
    const isReplying = comment.id === this.replyingToId;
    const classes = ["thread", isActive ? "active" : "", isResolved ? "resolved" : ""].filter(Boolean).join(" ");

    const dateStr = comment.date ? formatDate(comment.date) : "";
    const datePart = dateStr ? `<span class="thread-date">${esc(dateStr)}</span>` : "";
    const resolveIcon = isResolved ? "↩" : "✓";
    const resolveTitle = isResolved ? "Unresolve" : "Resolve";
    const repliesHtml = this.renderReplies(comment);
    const replyFormHtml = isReplying ? this.renderReplyForm(comment.id) : "";

    const menuHtml = `
      <div class="thread-menu" id="thread-menu-${esc(comment.id)}">
        <div class="thread-menu-item" data-action="resolve" data-id="${esc(comment.id)}" data-resolved="${isResolved ? "true" : "false"}">${resolveIcon}&nbsp;${resolveTitle}</div>
        <div class="thread-menu-item danger" data-action="delete" data-id="${esc(comment.id)}">&#128465;&nbsp;Delete</div>
      </div>`;

    if (isEditing) {
      return `
    <div class="${classes}" data-comment-id="${comment.id}">
      <div class="thread-meta">
        <div class="thread-meta-left"><span class="thread-author">${esc(comment.author)}</span>${datePart}</div>
        <div class="thread-icon-actions">
          <button class="icon-btn" data-action="start-reply" data-id="${esc(comment.id)}" title="Reply">↪</button>
          <button class="icon-btn" data-action="toggle-menu" data-id="${esc(comment.id)}" title="More">⋯</button>
        </div>
      </div>
      ${menuHtml}
      <textarea class="edit-textarea" rows="3"></textarea>
      <div class="thread-actions">
        <button class="btn primary" data-action="save-edit" data-id="${esc(comment.id)}" title="Save">✓</button>
        <button class="btn" data-action="cancel-edit" title="Cancel">✕</button>
      </div>
      ${repliesHtml}
      ${replyFormHtml}
    </div>`;
    }

    return `
    <div class="${classes}" data-comment-id="${comment.id}">
      <div class="thread-meta">
        <div class="thread-meta-left"><span class="thread-author">${esc(comment.author)}</span>${datePart}</div>
        <div class="thread-icon-actions">
          <button class="icon-btn" data-action="start-edit" title="Edit">✎</button>
          <button class="icon-btn" data-action="start-reply" data-id="${esc(comment.id)}" title="Reply">↪</button>
          <button class="icon-btn" data-action="toggle-menu" data-id="${esc(comment.id)}" title="More">⋯</button>
        </div>
      </div>
      ${menuHtml}
      <div class="thread-body">${esc(comment.body)}</div>
      ${repliesHtml}
      ${replyFormHtml}
    </div>`;
  }

  private renderReplies(comment: CommentData): string {
    if (!comment.replies || comment.replies.length === 0) return "";
    const html = comment.replies.map((r) => this.renderReply(comment.id, r)).join("");
    return `<div class="replies">${html}</div>`;
  }

  private renderReply(commentId: string, reply: Reply): string {
    const isEditing =
      this.editingReply?.commentId === commentId &&
      this.editingReply?.replyId === reply.id;
    const dateStr = reply.date ? formatDate(reply.date) : "";
    const datePart = dateStr ? `<span class="thread-date">${esc(dateStr)}</span>` : "";

    if (isEditing) {
      return `
      <div class="reply" data-reply-id="${esc(reply.id)}">
        <div class="thread-meta">
          <div class="thread-meta-left"><span class="thread-author">${esc(reply.author)}</span>${datePart}</div>
          <div class="thread-icon-actions">
            <button class="icon-btn danger" data-action="delete-reply" data-comment-id="${esc(commentId)}" data-reply-id="${esc(reply.id)}" title="Delete">🗑</button>
          </div>
        </div>
        <textarea class="reply-edit-textarea" rows="2"></textarea>
        <div class="thread-actions">
          <button class="btn primary" data-action="save-reply-edit" data-comment-id="${esc(commentId)}" data-reply-id="${esc(reply.id)}" title="Save">✓</button>
          <button class="btn" data-action="cancel-reply-edit" title="Cancel">✕</button>
        </div>
      </div>`;
    }

    return `
      <div class="reply" data-reply-id="${esc(reply.id)}">
        <div class="thread-meta">
          <div class="thread-meta-left"><span class="thread-author">${esc(reply.author)}</span>${datePart}</div>
          <div class="thread-icon-actions">
            <button class="icon-btn" data-action="start-reply-edit" data-comment-id="${esc(commentId)}" data-reply-id="${esc(reply.id)}" title="Edit">✎</button>
            <button class="icon-btn danger" data-action="delete-reply" data-comment-id="${esc(commentId)}" data-reply-id="${esc(reply.id)}" title="Delete">🗑</button>
          </div>
        </div>
        <div class="thread-body">${esc(reply.body)}</div>
      </div>`;
  }

  private renderReplyForm(commentId: string): string {
    return `
    <div class="reply-form">
      <textarea class="reply-input-textarea" rows="2" placeholder="Write a reply…"></textarea>
      <div class="thread-actions">
        <button class="btn primary" data-action="submit-reply" data-id="${esc(commentId)}" title="Submit reply">✓</button>
        <button class="btn" data-action="cancel-reply" title="Cancel">✕</button>
      </div>
    </div>`;
  }

  private bindEvents(): void {
    this.container.querySelectorAll<HTMLElement>("[data-action]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = btn.dataset["action"];

        if (action === "toggle-menu") {
          const id = btn.dataset["id"] ?? "";
          const menu = this.container.querySelector<HTMLElement>(`#thread-menu-${id}`);
          // Close all other open menus first
          this.container.querySelectorAll<HTMLElement>(".thread-menu.open").forEach((m) => {
            if (m !== menu) m.classList.remove("open");
          });
          menu?.classList.toggle("open");
          return;
        }

        // Close any open thread menu when an item action fires
        this.container.querySelectorAll<HTMLElement>(".thread-menu.open")
          .forEach((m) => m.classList.remove("open"));

        if (action === "delete") {
          const id = btn.dataset["id"] ?? "";
          this.post({ type: "deleteComment", id });
        }

        if (action === "resolve") {
          const id = btn.dataset["id"] ?? "";
          const resolved = btn.dataset["resolved"] !== "true";
          this.post({ type: "resolveComment", id, resolved });
        }

        if (action === "start-edit") {
          const card = btn.closest<HTMLElement>("[data-comment-id]");
          const id = card?.dataset["commentId"];
          if (id) this.editComment(id);
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

        if (action === "start-reply") {
          const id = btn.dataset["id"] ?? "";
          this.replyingToId = id;
          this.editingReply = null;
          this.render();
          const card = this.container.querySelector<HTMLElement>(`[data-comment-id="${id}"]`);
          card?.querySelector<HTMLTextAreaElement>(".reply-input-textarea")?.focus();
        }

        if (action === "cancel-reply") {
          this.replyingToId = null;
          this.render();
        }

        if (action === "submit-reply") {
          const card = btn.closest<HTMLElement>("[data-comment-id]");
          const textarea = card?.querySelector<HTMLTextAreaElement>(".reply-input-textarea");
          const body = textarea?.value.trim() ?? "";
          const id = btn.dataset["id"] ?? "";
          if (body && id) {
            this.post({ type: "addReply", commentId: id, body });
          }
          this.replyingToId = null;
          this.render();
        }

        if (action === "start-reply-edit") {
          const commentId = btn.dataset["commentId"] ?? "";
          const replyId = btn.dataset["replyId"] ?? "";
          this.editingReply = { commentId, replyId };
          this.replyingToId = null;
          this.render();
          const card = this.container.querySelector<HTMLElement>(`[data-comment-id="${commentId}"]`);
          const replyEl = card?.querySelector<HTMLElement>(`.reply[data-reply-id="${replyId}"]`);
          const textarea = replyEl?.querySelector<HTMLTextAreaElement>(".reply-edit-textarea");
          const comment = this.comments.find((c) => c.id === commentId);
          const reply = comment?.replies?.find((r) => r.id === replyId);
          if (textarea && reply) {
            textarea.value = reply.body;
            textarea.focus();
            textarea.select();
          }
        }

        if (action === "save-reply-edit") {
          const replyEl = btn.closest<HTMLElement>(".reply");
          const textarea = replyEl?.querySelector<HTMLTextAreaElement>(".reply-edit-textarea");
          const newBody = textarea?.value.trim() ?? "";
          const commentId = btn.dataset["commentId"] ?? "";
          const replyId = btn.dataset["replyId"] ?? "";
          if (newBody && commentId && replyId) {
            this.post({ type: "editReply", commentId, replyId, newBody });
          }
          this.editingReply = null;
          this.render();
        }

        if (action === "cancel-reply-edit") {
          this.editingReply = null;
          this.render();
        }

        if (action === "delete-reply") {
          const commentId = btn.dataset["commentId"] ?? "";
          const replyId = btn.dataset["replyId"] ?? "";
          if (commentId && replyId) {
            this.post({ type: "deleteReply", commentId, replyId });
          }
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

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
