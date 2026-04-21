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
  likes?: Array<{ author: string; date: string }>;
}

export interface CommentData {
  id: string;
  author: string;
  body: string;
  date?: string;
  resolved?: boolean;
  replies?: Reply[];
  likes?: Array<{ author: string; date: string }>;
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
  private editingReply: { commentId: string; replyId: string } | null = null;
  /** ID of a comment just created (empty body) — cancel should delete it */
  private creatingCommentId: string | null = null;

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
    // Preserve any in-progress reply text so a host update doesn't wipe it
    const savedReplies = new Map<string, string>();
    this.container.querySelectorAll<HTMLTextAreaElement>(".reply-bar-textarea").forEach((ta) => {
      const id = ta.dataset["commentId"];
      if (id && ta.value.trim()) savedReplies.set(id, ta.value);
    });
    this.comments = comments;
    this.render();
    savedReplies.forEach((text, id) => {
      const ta = this.container.querySelector<HTMLTextAreaElement>(`.reply-bar-textarea[data-comment-id="${id}"]`);
      if (ta) {
        ta.value = text;
        const bar = ta.closest<HTMLElement>(".reply-bar");
        const sendBtn = bar?.querySelector<HTMLButtonElement>("[data-action='submit-reply']");
        if (sendBtn) sendBtn.disabled = false;
        bar?.classList.add("active");
      }
    });
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

  /** Open a comment in edit mode. If isNew=true, treat cancel as delete and start with empty body. */
  editComment(commentId: string, isNew = false): void {
    this.activeCommentId = commentId;
    this.editingCommentId = commentId;
    this.creatingCommentId = isNew ? commentId : null;
    this.editingReply = null;
    this.render();
    const card = this.container.querySelector<HTMLElement>(
      `[data-comment-id="${commentId}"]`
    );
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const textarea = card?.querySelector<HTMLTextAreaElement>(".edit-textarea");
    const comment = this.comments.find((c) => c.id === commentId);
    if (textarea && comment) {
      // Clear zero-width space placeholder used for new drafts
      textarea.value = comment.body === "\u200b" ? "" : comment.body;
      textarea.focus();
      textarea.select();
      const saveBtn = card?.querySelector<HTMLButtonElement>("[data-action='save-edit']");
      if (saveBtn) saveBtn.disabled = !textarea.value.trim();
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
    requestAnimationFrame(() => this.positionCards());
  }

  /**
   * Absolutely position each comment card to align with its anchor icon
   * in the editor pane. Cards are pushed down to avoid overlap.
   * Call this on scroll, resize, and after render.
   */
  positionCards(): void {
    const editorPane = document.getElementById("editor-pane");
    if (!editorPane) return;

    const containerRect = this.container.getBoundingClientRect();

    // Map commentId -> anchor viewport top
    const anchorTops = new Map<string, number>();
    editorPane.querySelectorAll<HTMLElement>("[data-comment-id]").forEach((anchor) => {
      const id = anchor.dataset["commentId"];
      if (!id) return;
      anchorTops.set(id, anchor.getBoundingClientRect().top - containerRect.top);
    });

    // Collect cards with a matching visible anchor, skip those above the top
    const entries: Array<{ card: HTMLElement; top: number }> = [];
    this.container.querySelectorAll<HTMLElement>(".thread").forEach((card) => {
      const id = card.dataset["commentId"] ?? "";
      if (anchorTops.has(id)) {
        const t = anchorTops.get(id)!;
        if (t < 0) {
          card.style.display = "none"; // anchor scrolled off top
        } else {
          entries.push({ card, top: t });
        }
      } else {
        card.style.display = "none";
      }
    });

    // Sort by anchor position, then apply push-down to prevent overlap
    entries.sort((a, b) => a.top - b.top);
    let nextMinTop = 0;
    for (const { card, top } of entries) {
      const finalTop = Math.max(top, nextMinTop);
      card.style.display = "";
      card.style.top = finalTop + "px";
      nextMinTop = finalTop + Math.max(card.offsetHeight, 60) + 8;
    }
  }

  private renderComment(comment: CommentData): string {
    const isActive = comment.id === this.activeCommentId;
    const isEditing = comment.id === this.editingCommentId;
    const isResolved = !!comment.resolved;
    const classes = ["thread", isActive ? "active" : "", isResolved ? "resolved" : ""].filter(Boolean).join(" ");

    const dateStr = comment.date ? formatDate(comment.date) : "";
    const datePart = dateStr ? `<div class="thread-date-line">${esc(dateStr)}</div>` : "";
    const resolveIcon = isResolved ? "↩" : "✓";
    const resolveTitle = isResolved ? "Unresolve" : "Resolve";
    const repliesHtml = this.renderReplies(comment);
    const replyBarHtml = this.renderReplyBar(comment.id);

    const menuHtml = `
      <div class="thread-menu" id="thread-menu-${esc(comment.id)}">
        <div class="thread-menu-item" data-action="resolve" data-id="${esc(comment.id)}" data-resolved="${isResolved ? "true" : "false"}">${resolveIcon}&nbsp;${resolveTitle}</div>
        <div class="thread-menu-item danger" data-action="delete" data-id="${esc(comment.id)}">&#128465;&nbsp;Delete</div>
      </div>`;

    if (isEditing) {
      return `
    <div class="${classes}" data-comment-id="${comment.id}">
      <div class="thread-meta">
        <div class="thread-meta-left"><span class="thread-author">${esc(comment.author)}</span></div>
        <div class="thread-icon-actions">
          <button class="icon-btn" data-action="toggle-menu" data-id="${esc(comment.id)}" title="More">⋯</button>
        </div>
      </div>
      ${menuHtml}
      <textarea class="edit-textarea" rows="3"></textarea>
      ${datePart}
      <div class="thread-actions">
        <button class="btn primary" data-action="save-edit" data-id="${esc(comment.id)}" title="Send" disabled>&#10148;</button>
        <button class="btn" data-action="cancel-edit" title="Cancel">&#10005;</button>
      </div>
    </div>`;
    }

    return `
    <div class="${classes}" data-comment-id="${comment.id}">
      <div class="thread-meta">
        <div class="thread-meta-left"><span class="thread-author">${esc(comment.author)}</span></div>
        <div class="thread-icon-actions">
          <button class="icon-btn" data-action="toggle-menu" data-id="${esc(comment.id)}" title="More">⋯</button>
          <button class="icon-btn" data-action="start-edit" title="Edit">✎</button>
          ${this.renderLikeBtn(comment)}
        </div>
      </div>
      ${menuHtml}
      <div class="thread-body">${esc(comment.body)}</div>
      ${datePart}
      ${repliesHtml}
      ${replyBarHtml}
    </div>`;
  }

  private renderLikeBtn(comment: CommentData): string {
    const likes = comment.likes ?? [];
    const count = likes.length;
    const likedAuthors = likes.map((l) => l.author).join(", ");
    const title = count > 0 ? `Liked by: ${likedAuthors}` : "Like";
    const extraClass = count > 0 ? " has-likes" : "";
    return `<button class="icon-btn like-btn${extraClass}" data-action="like" data-id="${esc(comment.id)}" title="${esc(title)}">&#128077;${count > 0 ? `<span class="like-count">${count}</span>` : ""}</button>`;
  }

  private renderLikeRow(comment: CommentData): string {
    return "";
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
    const datePart = dateStr ? `<div class="thread-date-line">${esc(dateStr)}</div>` : "";

    // like button
    const likes = reply.likes ?? [];
    const likeCount = likes.length;
    const likedAuthors = likes.map((l) => l.author).join(", ");
    const likeTitle = likeCount > 0 ? `Liked by: ${likedAuthors}` : "Like";
    const likeExtraClass = likeCount > 0 ? " has-likes" : "";
    const likeBtn = `<button class="icon-btn like-btn${likeExtraClass}" data-action="like-reply" data-comment-id="${esc(commentId)}" data-reply-id="${esc(reply.id)}" title="${esc(likeTitle)}">&#128077;${likeCount > 0 ? `<span class="like-count">${likeCount}</span>` : ""}</button>`;

    const menuId = `reply-menu-${esc(reply.id)}`;
    const menuHtml = `
      <div class="thread-menu" id="${menuId}">
        <div class="thread-menu-item danger" data-action="delete-reply" data-comment-id="${esc(commentId)}" data-reply-id="${esc(reply.id)}">&#128465;&nbsp;Delete</div>
      </div>`;
    const editBtn = `<button class="icon-btn" data-action="start-reply-edit" data-comment-id="${esc(commentId)}" data-reply-id="${esc(reply.id)}" title="Edit">&#9998;</button>`;

    if (isEditing) {
      return `
      <div class="reply" data-reply-id="${esc(reply.id)}">
        <div class="thread-meta">
          <div class="thread-meta-left"><span class="thread-author">${esc(reply.author)}</span></div>
          <div class="thread-icon-actions">
            <button class="icon-btn" data-action="toggle-reply-menu" data-reply-id="${esc(reply.id)}" title="More">⋯</button>
            ${likeBtn}
          </div>
        </div>
        ${menuHtml}
        <textarea class="reply-edit-textarea" rows="2"></textarea>
        ${datePart}
        <div class="thread-actions">
          <button class="btn primary" data-action="save-reply-edit" data-comment-id="${esc(commentId)}" data-reply-id="${esc(reply.id)}" title="Send" disabled>&#10148;</button>
          <button class="btn" data-action="cancel-reply-edit" title="Cancel">&#10005;</button>
        </div>
      </div>`;
    }

    return `
      <div class="reply" data-reply-id="${esc(reply.id)}">
        <div class="thread-meta">
          <div class="thread-meta-left"><span class="thread-author">${esc(reply.author)}</span></div>
          <div class="thread-icon-actions reply-icon-actions-hover">
            <button class="icon-btn" data-action="toggle-reply-menu" data-reply-id="${esc(reply.id)}" title="More">⋯</button>
            ${editBtn}
            ${likeBtn}
          </div>
        </div>
        ${menuHtml}
        <div class="thread-body">${esc(reply.body)}</div>
        ${datePart}
      </div>`;
  }

  private renderReplyBar(commentId: string): string {
    return `
    <div class="reply-bar">
      <textarea class="reply-bar-textarea" rows="1" placeholder="Reply…" data-comment-id="${esc(commentId)}"></textarea>
      <div class="reply-bar-actions">
        <button class="btn primary" data-action="submit-reply" data-id="${esc(commentId)}" title="Send" disabled>&#10148;</button>
        <button class="btn" data-action="cancel-reply-bar" data-id="${esc(commentId)}" title="Cancel">&#10005;</button>
      </div>
    </div>`;
  }

  private bindEvents(): void {
    this.container.querySelectorAll<HTMLElement>("[data-action]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = btn.dataset["action"];

        if (action === "like") {
          const id = btn.dataset["id"] ?? "";
          if (id) this.post({ type: "likeComment", id });
          return;
        }

        if (action === "like-reply") {
          const commentId = btn.dataset["commentId"] ?? "";
          const replyId = btn.dataset["replyId"] ?? "";
          if (commentId && replyId) this.post({ type: "likeReply", commentId, replyId });
          return;
        }

        if (action === "toggle-menu") {
          const id = btn.dataset["id"] ?? "";
          const menu = this.container.querySelector<HTMLElement>(`#thread-menu-${id}`);
          this.container.querySelectorAll<HTMLElement>(".thread-menu.open").forEach((m) => {
            if (m !== menu) m.classList.remove("open");
          });
          menu?.classList.toggle("open");
          return;
        }

        if (action === "toggle-reply-menu") {
          const replyId = btn.dataset["replyId"] ?? "";
          const menu = this.container.querySelector<HTMLElement>(`#reply-menu-${replyId}`);
          this.container.querySelectorAll<HTMLElement>(".thread-menu.open").forEach((m) => {
            if (m !== menu) m.classList.remove("open");
          });
          menu?.classList.toggle("open");
          return;
        }

        if (action === "submit-new") {
          // legacy — no longer used, but kept defensively
          return;
        }

        if (action === "cancel-new") {
          // legacy — no longer used
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
          if (id) {
            if (newBody) {
              this.post({ type: "editComment", id, newBody });
              // Optimistic: update body locally
              this.comments = this.comments.map((c) => c.id === id ? { ...c, body: newBody } : c);
            } else if (this.creatingCommentId === id) {
              // Empty body on a brand-new comment → delete the draft
              this.post({ type: "deleteComment", id });
            }
          }
          this.editingCommentId = null;
          this.creatingCommentId = null;
          this.render();
        }

        if (action === "cancel-edit") {
          const id = this.editingCommentId ?? "";
          if (id && this.creatingCommentId === id) {
            this.post({ type: "deleteComment", id });
          }
          this.editingCommentId = null;
          this.creatingCommentId = null;
          this.render();
        }

        if (action === "cancel-reply-bar") {
          const id = btn.dataset["id"] ?? "";
          const card = this.container.querySelector<HTMLElement>(`[data-comment-id="${id}"]`);
          const ta = card?.querySelector<HTMLTextAreaElement>(".reply-bar-textarea");
          const sendBtn = card?.querySelector<HTMLButtonElement>("[data-action='submit-reply']");
          if (ta) ta.value = "";
          if (sendBtn) sendBtn.disabled = true;
        }

        if (action === "submit-reply") {
          const id = btn.dataset["id"] ?? "";
          const card = this.container.querySelector<HTMLElement>(`[data-comment-id="${id}"]`);
          const textarea = card?.querySelector<HTMLTextAreaElement>(".reply-bar-textarea");
          const body = textarea?.value.trim() ?? "";
          if (body && id) {
            this.post({ type: "addReply", commentId: id, body });
            // Optimistic update: add reply locally so it shows immediately
            this.comments = this.comments.map((c) => {
              if (c.id !== id) return c;
              const newReply = { id: "__r_" + Date.now(), author: "…", body, date: new Date().toISOString() };
              return { ...c, replies: [...(c.replies ?? []), newReply] };
            });
            this.render();
            // Re-focus the reply bar after re-render
            const newCard = this.container.querySelector<HTMLElement>(`[data-comment-id="${id}"]`);
            newCard?.querySelector<HTMLTextAreaElement>(".reply-bar-textarea")?.focus();
          }
        }

        if (action === "start-reply-edit") {
          const commentId = btn.dataset["commentId"] ?? "";
          const replyId = btn.dataset["replyId"] ?? "";
          this.editingReply = { commentId, replyId };
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
            const saveBtn = replyEl?.querySelector<HTMLButtonElement>("[data-action='save-reply-edit']");
            if (saveBtn) saveBtn.disabled = !textarea.value.trim();
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

    // edit-textarea: input enables/disables save; Escape cancels; Ctrl+Enter saves
    this.container.querySelectorAll<HTMLTextAreaElement>(".edit-textarea").forEach((textarea) => {
      textarea.addEventListener("input", () => {
        const card = textarea.closest<HTMLElement>("[data-comment-id]");
        const saveBtn = card?.querySelector<HTMLButtonElement>("[data-action='save-edit']");
        if (saveBtn) saveBtn.disabled = !textarea.value.trim();
      });
      textarea.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          textarea.closest<HTMLElement>(".thread")
            ?.querySelector<HTMLElement>("[data-action='cancel-edit'],[data-action='cancel-new']")
            ?.click();
        }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.stopPropagation();
          const save = textarea.closest<HTMLElement>(".thread")
            ?.querySelector<HTMLButtonElement>("[data-action='save-edit'],[data-action='submit-new']");
          if (save && !save.disabled) save.click();
        }
      });
    });

    // reply-edit-textarea: same pattern
    this.container.querySelectorAll<HTMLTextAreaElement>(".reply-edit-textarea").forEach((textarea) => {
      textarea.addEventListener("input", () => {
        const replyEl = textarea.closest<HTMLElement>(".reply");
        const saveBtn = replyEl?.querySelector<HTMLButtonElement>("[data-action='save-reply-edit']");
        if (saveBtn) saveBtn.disabled = !textarea.value.trim();
      });
      textarea.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          textarea.closest<HTMLElement>(".reply")
            ?.querySelector<HTMLElement>("[data-action='cancel-reply-edit']")
            ?.click();
        }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.stopPropagation();
          const save = textarea.closest<HTMLElement>(".reply")
            ?.querySelector<HTMLButtonElement>("[data-action='save-reply-edit']");
          if (save && !save.disabled) save.click();
        }
      });
    });

    // Reply bar: Enter submits (when enabled), Shift+Enter newline, Escape clears
    this.container.querySelectorAll<HTMLTextAreaElement>(".reply-bar-textarea").forEach((ta) => {
      const bar = ta.closest<HTMLElement>(".reply-bar");
      const sendBtn = bar?.querySelector<HTMLButtonElement>("[data-action='submit-reply']");
      ta.addEventListener("focus", () => {
        bar?.classList.add("active");
      });
      ta.addEventListener("blur", () => {
        if (!ta.value.trim()) bar?.classList.remove("active");
      });
      ta.addEventListener("input", () => {
        if (sendBtn) sendBtn.disabled = !ta.value.trim();
      });
      ta.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          if (sendBtn && !sendBtn.disabled) sendBtn.click();
        }
        if (e.key === "Escape") {
          ta.value = "";
          if (sendBtn) sendBtn.disabled = true;
          bar?.classList.remove("active");
          ta.blur();
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
    return new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}
