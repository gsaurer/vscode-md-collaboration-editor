/**
 * Inline comment parser.
 *
 * File format (v2 — ID-based):
 *   Some prose<!-- COMMENT id="a1b2c3" @Jane Doe: needs detail --> continues.
 *
 * - `id`          — stable 6-char ID for delete/edit operations
 * - `anchoredText`— short raw-markdown snippet immediately before the tag,
 *                   stored in memory only (not in the file). Used by
 *                   reInjectComments to find the reinsertion point, and by
 *                   the ProseMirror plugin to place the 💬 icon widget.
 *
 * Legacy v1 (no id attr) is read and auto-upgraded to v2 on next write.
 */

export interface SimpleComment {
  /** Stable ID stored in the file tag */
  id: string;
  author: string;
  body: string;
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

// v2: <!-- COMMENT id="abc123" @Author Name: body text -->
const COMMENT_RE_V2 =
  /<!--\s*COMMENT id="([a-z0-9]+)"\s*@([^:]+?):\s*([\s\S]*?)\s*-->/g;

// v1 legacy: <!-- COMMENT @Author Name: body text -->
const COMMENT_RE_V1 = /<!--\s*COMMENT @([^:]+?):\s*(.*?)\s*-->/g;

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
  const comments: SimpleComment[] = [];
  const byIndex = new Map<number, SimpleComment>();

  // Pass 1: v2 (with ID)
  COMMENT_RE_V2.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMMENT_RE_V2.exec(raw)) !== null) {
    byIndex.set(m.index, {
      id: m[1],
      author: m[2].trim(),
      body: m[3].trim(),
      anchoredText: extractPositionContext(raw.slice(0, m.index)),
    });
  }

  // Pass 2: v1 legacy — skip positions already handled by v2
  COMMENT_RE_V1.lastIndex = 0;
  while ((m = COMMENT_RE_V1.exec(raw)) !== null) {
    if (!byIndex.has(m.index)) {
      byIndex.set(m.index, {
        id: generateId(),
        author: m[1].trim(),
        body: m[2].trim(),
        anchoredText: extractPositionContext(raw.slice(0, m.index)),
      });
    }
  }

  for (const [, c] of [...byIndex.entries()].sort(([a], [b]) => a - b)) {
    comments.push(c);
  }

  const contentMarkdown = raw
    .replace(COMMENT_RE_V2, "")
    .replace(COMMENT_RE_V1, "")
    .trimEnd();

  return { contentMarkdown, comments };
}

/**
 * Re-inject comments into clean markdown immediately after each anchoredText.
 * anchoredText is a raw-markdown snippet that must appear verbatim in the
 * clean markdown.  Comments whose context can no longer be found are dropped.
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
    const tag = `<!-- COMMENT id="${comment.id}" @${comment.author}: ${comment.body} -->`;
    result = result.slice(0, insertPos) + tag + result.slice(insertPos);
  }
  return result;
}

/** Remove a comment by its stable ID. */
export function removeComment(markdown: string, id: string): string {
  return markdown.replace(
    new RegExp(`<!--\\s*COMMENT id="${id}"[\\s\\S]*?-->`, "g"),
    ""
  );
}

/** Replace the body of an existing comment by its stable ID. */
export function editCommentBody(
  markdown: string,
  id: string,
  newBody: string
): string {
  return markdown.replace(
    new RegExp(`(<!--\\s*COMMENT id="${id}"\\s*@[^:]+?:\\s*)[\\s\\S]*?(\\s*-->)`),
    `$1${newBody}$2`
  );
}

