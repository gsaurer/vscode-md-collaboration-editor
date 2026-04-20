---
name: md-collab-comments
description: Understand and work with the inline comment format used by the md-collab-editor VS Code extension. Use when reading, writing, inserting, editing, or removing collaboration comments in Markdown files that use the <!-- COMMENT {...} --> convention. Trigger when the user mentions "md-collab-editor comments", "inline comments in markdown", or asks to add/edit/resolve/reply to comments in .md files managed by this editor.
---

# md-collab-editor — Inline Comment Format

## Overview

The `md-collab-editor` VS Code extension stores collaboration comments **inline inside Markdown files** as HTML comments. They are invisible to Markdown renderers but are parsed and displayed by the extension's WYSIWYG panel.

Comments are anchored to a position in the document by being placed **immediately after** the prose they refer to (no newline between the anchor text and the tag).

---

## Comment Tag Format (v2 — current)

```
<anchor text><!-- COMMENT <JSON> -->
```

The JSON payload is a single-line serialized object with the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` (6-char alphanumeric) | ✅ | Stable identifier. Used for all edit/delete/reply operations. |
| `author` | `string` | ✅ | Display name of the comment author. |
| `body` | `string` | ✅ | Comment text. Use `"\u200b"` (zero-width space) as a placeholder for unsaved drafts. |
| `date` | `string` (ISO 8601) | optional | Creation timestamp, e.g. `"2026-04-20T14:30:00.000Z"`. |
| `resolved` | `boolean` | optional | `true` means the thread has been resolved (Word-style). Omit when `false`. |
| `replies` | `Reply[]` | optional | Threaded replies. Omit when empty. |
| `likes` | `Like[]` | optional | Users who liked this comment. Omit when empty. |

### Reply object

```ts
{
  id: string;       // 6-char alphanumeric
  author: string;
  body: string;
  date?: string;    // ISO 8601
  likes?: Like[];
}
```

### Like object

```ts
{
  author: string;   // display name
  date: string;     // ISO 8601
}
```

---

## Full Example

```markdown
This section needs more detail<!-- COMMENT {"id":"a1b2c3","author":"Jane Doe","body":"Please expand the introduction.","date":"2026-04-20T10:00:00.000Z","replies":[{"id":"d4e5f6","author":"John Smith","body":"Will do, adding examples.","date":"2026-04-20T10:15:00.000Z"}]} --> with examples.
```

Resolved thread with a like:

```markdown
Some text<!-- COMMENT {"id":"x9y8z7","author":"Alice","body":"Looks good!","date":"2026-04-19T09:00:00.000Z","resolved":true,"likes":[{"author":"Bob","date":"2026-04-19T09:30:00.000Z"}]} -->
```

---

## Positioning Rules

- The tag is placed **immediately after** the anchor text it refers to, with **no newline** between them.
- The extension uses up to the last **30 characters** of the current line (before the tag) as `anchoredText` — a positional marker used to re-inject the tag after edits.
- Multiple comments on the same paragraph are placed sequentially after their respective anchor text.

---

## Regex (for parsing)

```
/<!--\s*COMMENT\s+(\{(?:[^-]|-(?!->))*\})\s*-->/g
```

Uses a **tempered greedy token** `(?:[^-]|-(?!->))*` to avoid catastrophic backtracking from nested `}` characters inside reply arrays.

---

## Legacy Format (read-only, auto-upgraded)

The extension can still read the old format and upgrades it to v2 on the next write:

```
<!-- COMMENT id="abc123" @Author Name: body text -->
```

Do not write new comments in this format.

---

## ID Generation

IDs are 6-character alphanumeric strings generated with:

```ts
Math.random().toString(36).slice(2, 8).padEnd(6, "0")
```

When adding comments programmatically, generate a unique 6-char ID using this pattern.

---

## Operations Reference

| Operation | What changes in the file |
|-----------|--------------------------|
| **Add comment** | Insert `<!-- COMMENT {...} -->` immediately after anchor text |
| **Edit body** | Update `body` field in the JSON, preserve all other fields |
| **Resolve** | Set `"resolved": true` in the JSON |
| **Unresolve** | Remove `resolved` key (or set to `false`) |
| **Delete comment** | Remove the entire `<!-- COMMENT ... -->` tag |
| **Add reply** | Append to `replies` array; create array if absent |
| **Edit reply** | Find reply by `id` in `replies`, update its `body` |
| **Delete reply** | Filter out reply by `id` from `replies`; remove key if array becomes empty |
| **Like comment** | Append `{author, date}` to `likes`; remove the object to unlike |
| **Like reply** | Same as above but inside the reply object's `likes` array |

---

## Important Constraints

1. **Never modify the anchor text** before a tag — it is used as a positional marker for re-injection.
2. **Preserve all fields** when editing — only change the specific field being updated.
3. **Do not pretty-print** the JSON — it must remain on a single line inside the comment tag.
4. **`anchoredText` is never stored** in the file — it is derived at parse time from the 30 chars before the tag.
5. Comments are **invisible to standard Markdown renderers** — safe to include in any `.md` file.
