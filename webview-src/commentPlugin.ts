/**
 * commentPlugin.ts
 *
 * Comment anchor support implemented as a ProseMirror Decoration plugin —
 * intentionally avoids Milkdown's $markSchema API so we don't need to
 * implement Milkdown-specific markdown parsing/serialisation hooks.
 *
 * Architecture:
 *   - Anchor syntax (<!--ref:ID-->text<!--/ref:ID-->) is stripped BEFORE
 *     content reaches Milkdown. Milkdown sees only clean markdown.
 *   - Anchor ranges are rendered as ProseMirror Decorations (InlineDecoration)
 *     located by searching for anchoredText in the doc.
 *   - On serialise: the extension host re-injects the anchor pairs by text
 *     matching (see commentParser.ts → reInjectAnchors).
 *   - When the user adds a comment the selected text is sent to the host;
 *     the host writes the anchor syntax and pushes the updated file back.
 */

import { Plugin, PluginKey, PluginSpec } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import type { Node as PmNode } from "prosemirror-model";

// ── Anchor data (mirrors what the extension host tracks) ─────────────────────

export interface AnchorInfo {
  commentId: string;
  anchoredText: string;
  author?: string;
  body?: string;
}

// ── Plugin key (used to read/update plugin state) ────────────────────────────

export const anchorPluginKey = new PluginKey<DecorationSet>("commentAnchors");

// ── Decoration builder ────────────────────────────────────────────────────────

/**
 * Convert the raw-markdown anchoredText into plain text that matches what
 * ProseMirror stores in its text nodes (stripped of all markdown syntax).
 *
 * For table rows the anchoredText spans multiple cells separated by `|`.
 * ProseMirror stores each cell as a separate block (sentinel between them),
 * so we must isolate just the last cell's content before searching.
 */
function toSearchText(text: string): string {
  let s = text;

  // If the text looks like a table row, take only the last non-empty cell segment
  if (s.includes("|")) {
    const parts = s.split("|").map((p) => p.trim()).filter(Boolean);
    s = parts[parts.length - 1] ?? s;
  }

  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")  // [link](url) → text
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")        // **bold** → bold
    .replace(/\*([^*\n]+)\*/g, "$1")            // *italic* → italic
    .replace(/`([^`]+)`/g, "$1")               // `code` → code
    // Strip leading block markers (headings, list bullets, blockquotes)
    .replace(/^[\s]*(?:#{1,6}\s+|[*\-+]\s+|\d+\.\s+|(?:>\s*)+)*/, "")
    // Only strip chars PM doesn't preserve as plain text:
    // leftover [ ] from non-link brackets, _ ~ for italic/strikethrough
    // Keep ( ) — PM preserves them and they're needed for exact matching
    .replace(/[_~[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-40)
    .trim();
}

function buildDecorations(
  doc: PmNode,
  anchors: AnchorInfo[],
  onIconClick: (commentId: string) => void
): DecorationSet {
  const decos: Decoration[] = [];

  for (const anchor of anchors) {
    if (!anchor.anchoredText) {
      continue;
    }
    const ranges = findTextInDoc(doc, toSearchText(anchor.anchoredText));
    // Use the end of the first match as the widget insertion point
    const pos = ranges.length > 0 ? ranges[0].to : null;
    if (pos === null) continue;

    const capturedAnchor = anchor;
    decos.push(
      Decoration.widget(
        pos,
        () => {
          const icon = document.createElement("span");
          icon.className = "comment-icon";
          icon.setAttribute("contenteditable", "false");
          icon.setAttribute("data-comment-id", capturedAnchor.commentId);
          const tooltip = [capturedAnchor.author, capturedAnchor.body]
            .filter(Boolean)
            .join(": ");
          if (tooltip) icon.setAttribute("title", tooltip);
          icon.textContent = "💬";
          icon.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
          });
          icon.addEventListener("click", (e) => {
            e.stopPropagation();
            onIconClick(capturedAnchor.commentId);
          });
          return icon;
        },
        { side: 1, stopEvent: () => true }
      )
    );
  }

  return DecorationSet.create(doc, decos);
}

// ── Text search in ProseMirror doc ───────────────────────────────────────────

/**
 * Find all occurrences of `text` in the document and return doc-space
 * {from, to} ranges.  Sentinel characters prevent matches across blocks.
 */
export function findTextInDoc(
  doc: PmNode,
  text: string
): Array<{ from: number; to: number }> {
  if (!text) {
    return [];
  }

  const results: Array<{ from: number; to: number }> = [];
  const textParts: Array<{ pos: number; text: string }> = [];

  doc.nodesBetween(0, doc.content.size, (node, pos) => {
    if (node.isText && node.text) {
      textParts.push({ pos, text: node.text });
    }
  });

  // Build a flat string + position map, inserting sentinels between text nodes
  // from different blocks so we never match across a block boundary.
  let concat = "";
  const posMap: number[] = [];

  for (const part of textParts) {
    for (let i = 0; i < part.text.length; i++) {
      posMap.push(part.pos + i);
      concat += part.text[i];
    }
    // sentinel — can't appear in user text
    posMap.push(-1);
    concat += "\x00";
  }

  let searchStart = 0;
  while (searchStart < concat.length) {
    const idx = concat.indexOf(text, searchStart);
    if (idx === -1) {
      break;
    }
    const slice = concat.slice(idx, idx + text.length);
    if (!slice.includes("\x00")) {
      const from = posMap[idx];
      const to = posMap[idx + text.length - 1] + 1;
      if (from !== -1 && to !== -1) {
        results.push({ from, to });
      }
    }
    searchStart = idx + 1;
  }

  return results;
}

// ── The plugin ────────────────────────────────────────────────────────────────

export function createAnchorPlugin(
  initialAnchors: AnchorInfo[],
  onIconClick: (commentId: string) => void
): Plugin<DecorationSet> {
  const spec: PluginSpec<DecorationSet> = {
    key: anchorPluginKey,

    state: {
      init(_, state) {
        return buildDecorations(state.doc, initialAnchors, onIconClick);
      },
      apply(tr, old) {
        if (tr.docChanged) {
          return old.map(tr.mapping, tr.doc);
        }
        const newAnchors = tr.getMeta(anchorPluginKey) as
          | AnchorInfo[]
          | undefined;
        if (newAnchors !== undefined) {
          return buildDecorations(tr.doc, newAnchors, onIconClick);
        }
        return old;
      },
    },

    props: {
      decorations(state) {
        return anchorPluginKey.getState(state);
      },
    },
  };

  return new Plugin<DecorationSet>(spec);
}

/** Dispatch a transaction that updates the decoration set with fresh anchor data */
export function setAnchors(view: EditorView, anchors: AnchorInfo[]): void {
  view.dispatch(view.state.tr.setMeta(anchorPluginKey, anchors));
}

// ── Markdown pre-processing ───────────────────────────────────────────────────

const ANCHOR_PAIR_RE =
  /<!--ref:([a-zA-Z0-9_-]+)-->([\s\S]*?)<!--\/ref:\1-->/g;

/**
 * Strip <!--ref:ID-->text<!--/ref:ID--> anchors from markdown before
 * passing to Milkdown.  Returns clean markdown + a map of {id → anchoredText}.
 */
export function stripAnchors(raw: string): {
  markdown: string;
  anchors: Map<string, string>;
} {
  const anchors = new Map<string, string>();
  const markdown = raw.replace(
    ANCHOR_PAIR_RE,
    (_: string, id: string, content: string) => {
      anchors.set(id, content);
      return content;
    }
  );
  return { markdown, anchors };
}
