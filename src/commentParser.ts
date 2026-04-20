/**
 * Inline comment parser.
 *
 * File format (v2 — JSON):
 *   Some prose<!-- COMMENT {"id":"a1b2c3","author":"Jane Doe","body":"needs detail"} --> continues.
 *
 * - `id`          — stable 6-char ID for delete/edit operations
 * - `anchoredText`— short raw-markdown snippet immediately before the tag,
 *                   stored in memory only (not in the file). Used by
 *                   reInjectComments to find the reinsertion point, and by
 *                   the ProseMirror plugin to place the 💬 icon widget.
 *
 * Legacy format (id="..." @Author: body) is read and auto-upgraded to v2 on next write.
 */

export interface Reply {
  /** Stable ID for delete/edit operations */
  id: string;
  author: string;
  body: string;
  /** ISO 8601 timestamp */
  date?: string;
  likes?: Like[];
}

export interface Like {
  /** Name of the user who liked */
  author: string;
  /** ISO 8601 timestamp of the like */
  date: string;
}

export interface SimpleComment {
  /** Stable ID stored in the file tag */
  id: string;
  author: string;
  body: string;
  /** ISO 8601 timestamp of when the comment was created */
  date?: string;
  /** Whether the comment has been resolved (Word-style) */
  resolved?: boolean;
  /** Threaded replies */
  replies?: Reply[];
  /** Users who liked this comment */
  likes?: Like[];
  /**
   * Short raw-markdown snippet from immediately before the comment tag.
   * Used solely as a positional marker — to locate where to place the
   * icon widget in ProseMirror and where to re-insert the tag on save.
   * Not stored in the file; derived from context on parse, or supplied
   * explicitly when a new comment is created.
   */
  anchoredText: string;
}

export interface ParsedDocument {
  /** Markdown with all comments stripped */
  contentMarkdown: string;
  comments: SimpleComment[];
}

// v2 JSON: <!-- COMMENT {"id":"abc123","author":"Author Name","body":"body text"} -->
// Use a tempered greedy token (?:[^-]|-(?!->))* instead of [\s\S]*? to avoid
// catastrophic backtracking caused by nested } characters inside replies arrays.
const COMMENT_RE_JSON = /<!--\s*COMMENT\s+(\{(?:[^-]|-(?!->))*\})\s*-->/g;

// Legacy: <!-- COMMENT id="abc123" @Author Name: body text -->
const COMMENT_RE_LEGACY =
  /<!--\s*COMMENT id="([a-z0-9]+)"\s*@([^:]+?):\s*((?:[^-]|-(?!->))*?)-->/g;

/** Generate a random 6-char alphanumeric ID */
export function generateId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

/**
 * Extract a short positional context snippet from the raw markdown immediately
 * before the comment tag. Only strips earlier comment tags; all other markdown
 * syntax is preserved so reInjectComments can find this string verbatim.
 */
function extractPositionContext(rawBefore: string): string {
  const before = rawBefore
    .replace(/<!--[\s\S]*?-->/g, "")   // strip earlier comment tags on same line
    .trimEnd();
  const lastNl = before.lastIndexOf("\n");
  const lastLine = lastNl === -1 ? before : before.slice(lastNl + 1);
  return (lastLine.length <= 30 ? lastLine : lastLine.slice(-30)).trim();
}

// ── Public API ───────────────────────────────────────────────────────────────

export function parseDocument(raw: string): ParsedDocument {
  const byIndex = new Map<number, SimpleComment>();

  // Pass 1: v2 JSON format
  COMMENT_RE_JSON.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMMENT_RE_JSON.exec(raw)) !== null) {
    try {
      const parsed = JSON.parse(m[1]) as Partial<SimpleComment>;
      if (parsed.id && parsed.author !== undefined && parsed.body !== undefined) {
        byIndex.set(m.index, {
          id: parsed.id,
          author: parsed.author,
          body: parsed.body,
          date: parsed.date,
          resolved: parsed.resolved,
          replies: Array.isArray(parsed.replies) ? parsed.replies : undefined,
          likes: Array.isArray(parsed.likes) ? parsed.likes : undefined,
          anchoredText: extractPositionContext(raw.slice(0, m.index)),
        });
      }
    } catch {
      // malformed JSON — skip
    }
  }

  // Pass 2: legacy format — skip positions already handled by v2
  COMMENT_RE_LEGACY.lastIndex = 0;
  while ((m = COMMENT_RE_LEGACY.exec(raw)) !== null) {
    if (!byIndex.has(m.index)) {
      byIndex.set(m.index, {
        id: m[1],
        author: m[2].trim(),
        body: m[3].trim(),
        anchoredText: extractPositionContext(raw.slice(0, m.index)),
      });
    }
  }

  const comments: SimpleComment[] = [];
  for (const [, c] of [...byIndex.entries()].sort(([a], [b]) => a - b)) {
    comments.push(c);
  }

  const contentMarkdown = raw
    .replace(COMMENT_RE_JSON, "")
    .replace(COMMENT_RE_LEGACY, "")
    .trimEnd();

  return { contentMarkdown, comments };
}

/**
 * Re-inject comments into clean markdown immediately after each anchoredText.
 * anchoredText is a raw-markdown snippet that must appear verbatim in the
 * clean markdown.  Comments whose context can no longer be found are dropped.
 * Always writes v2 JSON format — auto-migrates any legacy comments on save.
 */
export function reInjectComments(
  cleanMarkdown: string,
  comments: SimpleComment[]
): string {
  let result = cleanMarkdown;
  for (const comment of comments) {
    if (!comment.anchoredText) continue;
    const idx = result.indexOf(comment.anchoredText);
    if (idx === -1) continue;
    const insertPos = idx + comment.anchoredText.length;
    const data: Record<string, unknown> = { id: comment.id, author: comment.author, body: comment.body };
    if (comment.date !== undefined) data["date"] = comment.date;
    if (comment.resolved !== undefined) data["resolved"] = comment.resolved;
    if (comment.replies?.length) data["replies"] = comment.replies;
    if (comment.likes?.length) data["likes"] = comment.likes;
    const tag = `<!-- COMMENT ${JSON.stringify(data)} -->`;
    result = result.slice(0, insertPos) + tag + result.slice(insertPos);
  }
  return result;
}

/** Remove a comment by its stable ID. Handles both v2 JSON and legacy format. */
export function removeComment(markdown: string, id: string): string {
  // Remove v2 JSON tags matching the given ID
  let result = markdown.replace(COMMENT_RE_JSON, (match, json: string) => {
    try {
      const parsed = JSON.parse(json) as Partial<SimpleComment>;
      return parsed.id === id ? "" : match;
    } catch {
      return match;
    }
  });
  // Remove legacy tags matching the given ID
  result = result.replace(
    new RegExp(`<!--\\s*COMMENT id="${id}"[\\s\\S]*?-->`, "g"),
    ""
  );
  return result;
}

/** Replace the body of an existing comment by its stable ID. Handles both v2 JSON and legacy format. */
export function editCommentBody(
  markdown: string,
  id: string,
  newBody: string
): string {
  // Edit v2 JSON tags — preserve all other fields
  let result = markdown.replace(COMMENT_RE_JSON, (match, json: string) => {
    try {
      const parsed = JSON.parse(json) as Partial<SimpleComment>;
      if (parsed.id !== id) return match;
      parsed.body = newBody;
      return `<!-- COMMENT ${JSON.stringify(parsed)} -->`;
    } catch {
      return match;
    }
  });
  // Edit legacy tags — upgrade to v2 JSON while editing
  result = result.replace(
    new RegExp(`<!--\\s*COMMENT id="${id}"\\s*@([^:]+?):\\s*[\\s\\S]*?\\s*-->`, "g"),
    (_match, author: string) =>
      `<!-- COMMENT ${JSON.stringify({ id, author: author.trim(), body: newBody })} -->`
  );
  return result;
}

/** Add a reply to an existing comment by its stable ID. */
export function addReply(markdown: string, commentId: string, reply: Reply): string {
  return markdown.replace(COMMENT_RE_JSON, (match, json: string) => {
    try {
      const parsed = JSON.parse(json) as Partial<SimpleComment>;
      if (parsed.id !== commentId) return match;
      const replies = Array.isArray(parsed.replies) ? [...parsed.replies] : [];
      replies.push(reply);
      parsed.replies = replies;
      return `<!-- COMMENT ${JSON.stringify(parsed)} -->`;
    } catch {
      return match;
    }
  });
}

/** Delete a reply from a comment. */
export function deleteReply(markdown: string, commentId: string, replyId: string): string {
  return markdown.replace(COMMENT_RE_JSON, (match, json: string) => {
    try {
      const parsed = JSON.parse(json) as Partial<SimpleComment>;
      if (parsed.id !== commentId || !Array.isArray(parsed.replies)) return match;
      parsed.replies = parsed.replies.filter((r) => r.id !== replyId);
      if (parsed.replies.length === 0) delete parsed.replies;
      return `<!-- COMMENT ${JSON.stringify(parsed)} -->`;
    } catch {
      return match;
    }
  });
}

/** Edit the body of an existing reply. */
export function editReply(markdown: string, commentId: string, replyId: string, newBody: string): string {
  return markdown.replace(COMMENT_RE_JSON, (match, json: string) => {
    try {
      const parsed = JSON.parse(json) as Partial<SimpleComment>;
      if (parsed.id !== commentId || !Array.isArray(parsed.replies)) return match;
      parsed.replies = parsed.replies.map((r) => r.id === replyId ? { ...r, body: newBody } : r);
      return `<!-- COMMENT ${JSON.stringify(parsed)} -->`;
    } catch {
      return match;
    }
  });
}

/** Toggle a like on a comment. Adds if the user hasn't liked, removes if they have. */
export function toggleLike(markdown: string, commentId: string, author: string): string {
  return markdown.replace(COMMENT_RE_JSON, (match, json: string) => {
    try {
      const parsed = JSON.parse(json) as Partial<SimpleComment>;
      if (parsed.id !== commentId) return match;
      const likes: Like[] = Array.isArray(parsed.likes) ? [...parsed.likes] : [];
      const idx = likes.findIndex((l) => l.author === author);
      if (idx === -1) {
        likes.push({ author, date: new Date().toISOString() });
      } else {
        likes.splice(idx, 1);
      }
      parsed.likes = likes.length ? likes : undefined;
      if (parsed.likes === undefined) delete parsed.likes;
      return `<!-- COMMENT ${JSON.stringify(parsed)} -->`;
    } catch {
      return match;
    }
  });
}

/** Toggle a like on a reply. Adds if the user hasn't liked, removes if they have. */
export function toggleLikeReply(markdown: string, commentId: string, replyId: string, author: string): string {
  return markdown.replace(COMMENT_RE_JSON, (match, json: string) => {
    try {
      const parsed = JSON.parse(json) as Partial<SimpleComment>;
      if (parsed.id !== commentId || !Array.isArray(parsed.replies)) return match;
      parsed.replies = parsed.replies.map((r) => {
        if (r.id !== replyId) return r;
        const likes: Like[] = Array.isArray(r.likes) ? [...r.likes] : [];
        const idx = likes.findIndex((l) => l.author === author);
        if (idx === -1) {
          likes.push({ author, date: new Date().toISOString() });
        } else {
          likes.splice(idx, 1);
        }
        return { ...r, likes: likes.length ? likes : undefined };
      });
      return `<!-- COMMENT ${JSON.stringify(parsed)} -->`;
    } catch {
      return match;
    }
  });
}

/** Set the resolved state of a comment by its stable ID. */
export function resolveComment(
  markdown: string,
  id: string,
  resolved: boolean
): string {
  let result = markdown.replace(COMMENT_RE_JSON, (match, json: string) => {
    try {
      const parsed = JSON.parse(json) as Partial<SimpleComment>;
      if (parsed.id !== id) return match;
      parsed.resolved = resolved;
      return `<!-- COMMENT ${JSON.stringify(parsed)} -->`;
    } catch {
      return match;
    }
  });
  // Handle legacy tags — upgrade to v2 JSON while resolving
  result = result.replace(
    new RegExp(`<!--\\s*COMMENT id="${id}"\\s*@([^:]+?):\\s*([\\s\\S]*?)\\s*-->`, "g"),
    (_match, author: string, body: string) =>
      `<!-- COMMENT ${JSON.stringify({ id, author: author.trim(), body: body.trim(), resolved })} -->`
  );
  return result;
}

