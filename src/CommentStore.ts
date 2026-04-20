/**
 * CommentStore — storage abstraction for inline collaboration comments.
 *
 * The interface decouples "what operation to perform" from "where comments live".
 * Two implementations are planned:
 *
 *  InlineMdCommentStore  (this file)
 *    Comments are embedded in the .md file as <!-- COMMENT {...} --> tags.
 *    This is the current / default behaviour.
 *
 *  SidecarCommentStore  (future)
 *    The .md file contains only clean prose; comments are stored in a
 *    companion file (e.g. `document.md.comments`) as a JSON array.
 *    Suitable when you want to keep the Markdown file free of HTML tags,
 *    or when the file is managed by an external system (e.g. GitHub).
 */

import {
  SimpleComment,
  Reply,
  parseDocument,
  reInjectComments,
  removeComment,
  editCommentBody,
  resolveComment,
  addReply,
  deleteReply,
  editReply,
  toggleLike,
  toggleLikeReply,
} from "./commentParser";

// ── Interface ─────────────────────────────────────────────────────────────────

export interface CommentStore {
  /** Read the current document, returning clean prose and the comment list. */
  load(): Promise<{ contentMarkdown: string; comments: SimpleComment[] }>;

  /**
   * Persist clean markdown content.  The store is responsible for re-associating
   * comments with the new content (e.g. re-injecting tags, or leaving a
   * sidecar file untouched).
   */
  saveContent(cleanMarkdown: string): Promise<void>;

  /**
   * Add a brand-new comment.  `baseMarkdown` is the clean prose at the moment
   * the comment was created (may differ from the last saved state when the
   * editor has unsaved typing).
   */
  addComment(comment: SimpleComment, baseMarkdown?: string): Promise<void>;

  /** Permanently remove a comment and all its replies. */
  deleteComment(id: string): Promise<void>;

  /** Replace the body text of a comment. */
  editComment(id: string, newBody: string): Promise<void>;

  /** Set or clear the resolved flag. */
  resolveComment(id: string, resolved: boolean): Promise<void>;

  /** Append a reply to an existing comment thread. */
  addReply(commentId: string, reply: Reply): Promise<void>;

  /** Remove a single reply from a thread. */
  deleteReply(commentId: string, replyId: string): Promise<void>;

  /** Replace the body of an existing reply. */
  editReply(commentId: string, replyId: string, newBody: string): Promise<void>;

  /** Toggle a like on a top-level comment. */
  toggleLike(commentId: string, author: string): Promise<void>;

  /** Toggle a like on a reply. */
  toggleLikeReply(commentId: string, replyId: string, author: string): Promise<void>;

  /** Mark every comment in the document as resolved. */
  resolveAll(): Promise<void>;

  /** Delete every comment in the document. */
  deleteAll(): Promise<void>;
}

// ── Inline implementation ─────────────────────────────────────────────────────

/**
 * Stores comments as <!-- COMMENT {...} --> HTML tags embedded directly in
 * the Markdown file.  This is the default behaviour of md-collab-editor.
 *
 * @param getText    Returns the current raw file content (including comment tags).
 * @param applyEdit  Atomically replaces the entire file content with new text.
 */
export class InlineMdCommentStore implements CommentStore {
  constructor(
    private readonly getText: () => string,
    private readonly applyEdit: (newText: string) => Promise<void>,
  ) {}

  async load() {
    return parseDocument(this.getText());
  }

  async saveContent(cleanMarkdown: string) {
    const { comments } = parseDocument(this.getText());
    await this.applyEdit(reInjectComments(cleanMarkdown, comments));
  }

  async addComment(comment: SimpleComment, baseMarkdown?: string) {
    const parsed = parseDocument(this.getText());
    const base = baseMarkdown ?? parsed.contentMarkdown;
    const withExisting = reInjectComments(base, parsed.comments);
    await this.applyEdit(reInjectComments(withExisting, [comment]));
  }

  async deleteComment(id: string) {
    await this.applyEdit(removeComment(this.getText(), id));
  }

  async editComment(id: string, newBody: string) {
    await this.applyEdit(editCommentBody(this.getText(), id, newBody));
  }

  async resolveComment(id: string, resolved: boolean) {
    await this.applyEdit(resolveComment(this.getText(), id, resolved));
  }

  async addReply(commentId: string, reply: Reply) {
    await this.applyEdit(addReply(this.getText(), commentId, reply));
  }

  async deleteReply(commentId: string, replyId: string) {
    await this.applyEdit(deleteReply(this.getText(), commentId, replyId));
  }

  async editReply(commentId: string, replyId: string, newBody: string) {
    await this.applyEdit(editReply(this.getText(), commentId, replyId, newBody));
  }

  async toggleLike(commentId: string, author: string) {
    await this.applyEdit(toggleLike(this.getText(), commentId, author));
  }

  async toggleLikeReply(commentId: string, replyId: string, author: string) {
    await this.applyEdit(toggleLikeReply(this.getText(), commentId, replyId, author));
  }

  async resolveAll() {
    const { comments } = parseDocument(this.getText());
    let text = this.getText();
    for (const c of comments) {
      text = resolveComment(text, c.id, true);
    }
    await this.applyEdit(text);
  }

  async deleteAll() {
    const { comments } = parseDocument(this.getText());
    let text = this.getText();
    for (const c of comments) {
      text = removeComment(text, c.id);
    }
    await this.applyEdit(text);
  }
}
