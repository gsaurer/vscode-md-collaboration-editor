# Markdown Collaboration Editor

A VS Code extension that brings Word-style inline commenting to Markdown files — comments are stored directly inside the `.md` file as invisible HTML comments, so they travel with the document through git.

## Features

- **WYSIWYG editing** — Milkdown-powered rich text editor renders Markdown in-place
- **Inline comments** — comments are anchored to text and stored as `<!-- COMMENT {...} -->` tags inside the file; invisible to Markdown renderers, visible in the panel
- **Threaded replies** — reply to any comment thread
- **Resolve threads** — mark threads resolved (Word-style); toggle visibility of resolved comments
- **Likes** — like comments and replies
- **Bulk actions** — resolve all or delete all comments at once
- **Author detection** — author name and email are read from `git config`; override in settings
- **Keyboard shortcut** — `Ctrl+Shift+;` (macOS: `Cmd+Shift+;`) to add a comment at the cursor

## Usage

Open any `.md` file and switch the editor to **Markdown Collaboration Editor** via the editor-picker dropdown (top-right of the editor tab). The editor panel opens with the rendered Markdown on the left and the comment panel on the right.

### Adding a comment

1. Select text in the editor
2. Press `Ctrl+Shift+;` (macOS: `Cmd+Shift+;`), or run **Markdown Collaboration Editor: Add Comment** from the Command Palette
3. Type your comment and press **Save**

### Replying and resolving

- Click a comment card to expand it and write a reply
- Use the `...` menu on a comment card to **Edit**, **Resolve**, or **Delete** a thread

## Comment Storage Format

Comments are stored inline in the Markdown file as HTML comments and are never visible in rendered output:

```markdown
Some text<!-- COMMENT {"id":"a1b2c3","author":"Jane Doe","body":"Please expand this.","date":"2026-04-20T10:00:00.000Z"} -->
```

Replies and likes are stored in the same JSON payload. The format is git-friendly — comments diff and merge naturally alongside prose.

## Settings

| Setting | Default | Description |
|---|---|---|
| `mdCollabEditor.authorName` | `""` | Override the author name for new comments (defaults to `git user.name`) |
| `mdCollabEditor.authorEmail` | `""` | Override the author email (defaults to `git user.email`) |
| `mdCollabEditor.showResolvedComments` | `false` | Show resolved comment threads in the panel |

## Commands

| Command | Shortcut | Description |
|---|---|---|
| Markdown Collaboration Editor: Add Comment | `Ctrl+Shift+;` | Add a comment at the current selection |
| Markdown Collaboration Editor: Toggle Resolved Comments | — | Show/hide resolved threads |

## Requirements

- VS Code 1.85 or later
- Git installed (for author detection)

## License

MIT
