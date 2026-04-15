import * as vscode from "vscode";
import * as crypto from "crypto";
import {
  parseDocument,
  reInjectComments,
  removeComment,
  editCommentBody,
  generateId,
  SimpleComment,
} from "./commentParser";
import { getGitUser } from "./gitConfig";

// ── Message types (shared with webview) ──────────────────────────────────────

export type ExtensionMessage =
  | {
      type: "update";
      markdown: string;
      comments: SimpleComment[];
      currentUser: { name: string; email: string };
    }
  | { type: "focusComment"; commentId: string };

type WebviewMessage =
  | { type: "ready" }
  | { type: "edit"; markdown: string }
  | {
      type: "addComment";
      anchoredText: string;
      body: string;
      markdown?: string;
    }
  | { type: "deleteComment"; id: string }
  | { type: "editComment"; id: string; newBody: string };

// ── Provider ─────────────────────────────────────────────────────────────────

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "mdCollabEditor.markdownEditor";

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new MarkdownEditorProvider(context);
    const editorDisposable = vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );

    // Register the "Add Comment" command — it posts a message to the active webview
    const commandDisposable = vscode.commands.registerCommand(
      "mdCollabEditor.addComment",
      () => provider.triggerAddComment()
    );

    return vscode.Disposable.from(editorDisposable, commandDisposable);
  }

  /** Tracks the currently focused webview panel so the command can reach it */
  private activePanel: vscode.WebviewPanel | undefined;

  private constructor(private readonly context: vscode.ExtensionContext) {}

  private triggerAddComment() {
    this.activePanel?.webview.postMessage({ type: "triggerAddComment" });
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };

    webviewPanel.webview.html = this.buildHtml(webviewPanel.webview);

    // Track which panel is active
    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        this.activePanel = webviewPanel;
      } else if (this.activePanel === webviewPanel) {
        this.activePanel = undefined;
      }
    });
    this.activePanel = webviewPanel;

    // Guard against feedback loops when we programmatically edit the document
    let isApplyingEdit = false;

    const pushUpdate = () => {
      const { contentMarkdown, comments } = parseDocument(document.getText());
      const workspacePath = vscode.workspace.getWorkspaceFolder(
        document.uri
      )?.uri.fsPath;
      const currentUser = getGitUser(workspacePath);
      const msg: ExtensionMessage = {
        type: "update",
        markdown: contentMarkdown,
        comments,
        currentUser,
      };
      webviewPanel.webview.postMessage(msg);
    };

    // ── Message handler ───────────────────────────────────────────────────────

    const msgDisposable = webviewPanel.webview.onDidReceiveMessage(
      async (msg: WebviewMessage) => {
        switch (msg.type) {
          case "ready":
            pushUpdate();
            break;

          case "edit": {
            if (isApplyingEdit) {
              return;
            }
            // The webview sends clean markdown (no comment tags).
            // Re-inject comments by locating each anchoredText in the new content.
            const { comments } = parseDocument(document.getText());
            const newText = reInjectComments(msg.markdown, comments);
            await applyWholeDocumentEdit(
              document,
              newText,
              (v) => (isApplyingEdit = v)
            );
            break;
          }

          case "addComment": {
            const parsed = parseDocument(document.getText());
            const workspacePath = vscode.workspace.getWorkspaceFolder(
              document.uri
            )?.uri.fsPath;
            const user = getGitUser(workspacePath);
            const newComment: SimpleComment = {
              id: generateId(),
              author: user.name,
              body: msg.body,
              anchoredText: msg.anchoredText,
            };
            // Re-inject existing comments first, then append the new one
            const baseMarkdown = msg.markdown ?? parsed.contentMarkdown;
            const withExisting = reInjectComments(baseMarkdown, parsed.comments);
            const newText = reInjectComments(withExisting, [newComment]);
            await applyWholeDocumentEdit(
              document,
              newText,
              (v) => (isApplyingEdit = v)
            );
            pushUpdate();
            break;
          }

          case "deleteComment": {
            const newText = removeComment(
              document.getText(),
              msg.id
            );
            await applyWholeDocumentEdit(
              document,
              newText,
              (v) => (isApplyingEdit = v)
            );
            pushUpdate();
            break;
          }

          case "editComment": {
            const newText = editCommentBody(
              document.getText(),
              msg.id,
              msg.newBody
            );
            await applyWholeDocumentEdit(
              document,
              newText,
              (v) => (isApplyingEdit = v)
            );
            pushUpdate();
            break;
          }
        }
      }
    );

    // ── Sync external file changes → webview ──────────────────────────────────

    const changeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (
        e.document.uri.toString() === document.uri.toString() &&
        !isApplyingEdit
      ) {
        pushUpdate();
      }
    });

    webviewPanel.onDidDispose(() => {
      if (this.activePanel === webviewPanel) {
        this.activePanel = undefined;
      }
      msgDisposable.dispose();
      changeDisposable.dispose();
    });
  }

  // ── HTML ────────────────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js")
    );
    const nonce = crypto.randomBytes(16).toString("base64url");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';
             img-src ${webview.cspSource} data: https:;
             font-src ${webview.cspSource};" />
  <title>Markdown Collaboration Editor</title>
  <style>
    /* ── Reset & base ─────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    /* ── Layout ───────────────────────────────────── */
    #app { display: flex; height: 100vh; }

    #editor-pane {
      flex: 1;
      overflow-y: auto;
      padding: 32px 48px;
      min-width: 0;
    }

    #comment-pane {
      width: 300px;
      flex-shrink: 0;
      border-left: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Milkdown editor ──────────────────────────── */
    .milkdown {
      max-width: 780px;
      outline: none;
    }
    .milkdown .editor {
      outline: none;
      min-height: calc(100vh - 64px);
      line-height: 1.7;
    }

    /* ── Typography ───────────────────────────────── */
    .milkdown .editor h1,
    .milkdown .editor h2,
    .milkdown .editor h3,
    .milkdown .editor h4,
    .milkdown .editor h5,
    .milkdown .editor h6 {
      font-weight: 700;
      line-height: 1.3;
      margin: 1.2em 0 0.4em;
      color: var(--vscode-editor-foreground);
    }
    .milkdown .editor h1 { font-size: 2em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.2em; }
    .milkdown .editor h2 { font-size: 1.5em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.15em; }
    .milkdown .editor h3 { font-size: 1.25em; }
    .milkdown .editor h4 { font-size: 1.05em; }
    .milkdown .editor h5 { font-size: 0.95em; }
    .milkdown .editor h6 { font-size: 0.875em; opacity: 0.8; }

    .milkdown .editor p { margin: 0.6em 0; }

    .milkdown .editor strong { font-weight: 700; }
    .milkdown .editor em { font-style: italic; }

    .milkdown .editor code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.88em;
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
      padding: 0.15em 0.35em;
      border-radius: 3px;
    }
    .milkdown .editor pre {
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
      border-radius: 4px;
      padding: 1em 1.2em;
      overflow-x: auto;
      margin: 0.8em 0;
    }
    .milkdown .editor pre code {
      background: none;
      padding: 0;
      font-size: 0.9em;
    }

    .milkdown .editor blockquote {
      border-left: 4px solid var(--vscode-textBlockQuote-border, #888);
      background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.08));
      margin: 0.8em 0;
      padding: 0.4em 1em;
      color: inherit;
      opacity: 0.85;
    }

    .milkdown .editor ul,
    .milkdown .editor ol {
      padding-left: 1.8em;
      margin: 0.5em 0;
    }
    .milkdown .editor li { margin: 0.2em 0; }

    .milkdown .editor a {
      color: var(--vscode-textLink-foreground, #4aa0f5);
      text-decoration: none;
    }
    .milkdown .editor a:hover { text-decoration: underline; }

    .milkdown .editor hr {
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
      margin: 1.2em 0;
    }

    /* ── Tables ───────────────────────────────────── */
    .milkdown .editor table {
      border-collapse: collapse;
      width: 100%;
      margin: 0.8em 0;
      font-size: 0.95em;
    }
    .milkdown .editor th,
    .milkdown .editor td {
      border: 1px solid var(--vscode-panel-border);
      padding: 6px 12px;
      text-align: left;
    }
    .milkdown .editor th {
      background: var(--vscode-editor-lineHighlightBackground, rgba(128,128,128,0.1));
      font-weight: 700;
    }
    .milkdown .editor tr:nth-child(even) td {
      background: rgba(128,128,128,0.04);
    }

    /* ── Context menu ─────────────────────────────── */
    #ctx-menu {
      position: fixed;
      display: none;
      z-index: 200;
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      min-width: 160px;
      padding: 4px 0;
    }
    #ctx-menu.visible { display: block; }
    .ctx-item {
      padding: 6px 14px;
      font-size: 13px;
      cursor: pointer;
      color: var(--vscode-menu-foreground, var(--vscode-editor-foreground));
      white-space: nowrap;
    }
    .ctx-item:hover {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-menu-selectionForeground, var(--vscode-editor-foreground));
    }

    /* ── Comment anchor highlight ─────────────────── */
    .comment-anchor {
      background: rgba(255, 213, 0, 0.28);
      border-bottom: 2px solid rgba(255, 176, 0, 0.75);
      border-radius: 2px;
      cursor: pointer;
      padding-bottom: 1px;
      transition: background 0.15s;
    }
    .comment-anchor:hover,
    .comment-anchor.active {
      background: rgba(255, 196, 0, 0.45);
    }
    .comment-anchor.active {
      background: rgba(255, 196, 0, 0.45);
    }

    /* ── Comment icon ────────────────────────────────── */
    .comment-icon {
      display: inline-block;
      font-size: 0.72em;
      margin-left: 2px;
      cursor: pointer;
      vertical-align: text-top;
      user-select: none;
      opacity: 0.65;
      transition: opacity 0.15s, transform 0.1s;
      line-height: 1;
    }
    .comment-icon:hover { opacity: 1; transform: scale(1.2); }

    /* ── Comment pane header ──────────────────────── */
    .pane-header {
      padding: 10px 14px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
      background: var(--vscode-sideBarSectionHeader-background, transparent);
      user-select: none;
      flex-shrink: 0;
    }

    #threads-container {
      flex: 1;
      overflow-y: auto;
    }

    /* ── Comment card ──────────────────────────────── */
    .thread {
      padding: 12px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      cursor: default;
      transition: background 0.1s;
    }
    .thread:hover { background: var(--vscode-list-hoverBackground); }
    .thread.active { background: var(--vscode-list-activeSelectionBackground); }

    .thread-anchor-preview {
      font-size: 11px;
      color: var(--vscode-textPreformat-foreground);
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid rgba(255, 176, 0, 0.75);
      padding: 2px 6px;
      margin-bottom: 7px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      border-radius: 0 2px 2px 0;
    }

    .thread-meta {
      display: flex;
      align-items: baseline;
      gap: 6px;
      margin-bottom: 5px;
    }
    .thread-author {
      font-weight: 600;
      font-size: 12px;
    }

    .thread-body {
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* ── Action buttons ───────────────────────────── */
    .thread-actions {
      margin-top: 9px;
      display: flex;
      gap: 5px;
      align-items: center;
    }
    .btn {
      font-size: 11px;
      padding: 3px 9px;
      border-radius: 3px;
      cursor: pointer;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-family: var(--vscode-font-family);
    }
    .btn:hover { opacity: 0.85; }
    .btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn.danger { border-color: var(--vscode-inputValidation-errorBorder); }

    /* ── Inline edit textarea ────────────────────────── */
    .edit-textarea {
      width: 100%;
      padding: 5px 7px;
      margin-top: 4px;
      font-size: 12px;
      font-family: var(--vscode-font-family);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      resize: vertical;
      min-height: 56px;
      box-sizing: border-box;
    }
    .edit-textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }

    /* ── "Add comment" new-thread panel ──────────────*/
    #new-comment-panel {
      position: fixed;
      bottom: 24px;
      right: 316px;
      width: 280px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      padding: 12px;
      display: none;
      flex-direction: column;
      gap: 8px;
      z-index: 100;
    }
    #new-comment-panel.visible { display: flex; }
    #new-comment-panel label { font-size: 11px; font-weight: 600; }
    #new-comment-panel .selection-preview {
      font-size: 11px;
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid rgba(255,176,0,0.75);
      padding: 3px 7px;
      border-radius: 0 2px 2px 0;
      color: var(--vscode-textPreformat-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #new-comment-panel textarea {
      width: 100%;
      padding: 6px 8px;
      font-size: 12px;
      font-family: var(--vscode-font-family);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      resize: vertical;
      min-height: 72px;
    }
    #new-comment-panel textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
    #new-comment-panel .panel-actions { display: flex; gap: 6px; justify-content: flex-end; }

    /* ── Empty state ──────────────────────────────── */
    .empty-state {
      padding: 20px 14px;
      font-size: 12px;
      opacity: 0.55;
      text-align: center;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div id="app">
    <div id="editor-pane">
      <div id="editor"></div>
    </div>
    <div id="comment-pane">
      <div class="pane-header">Comments</div>
      <div id="threads-container"></div>
    </div>
  </div>

  <!-- Right-click context menu -->
  <div id="ctx-menu">
    <div class="ctx-item" id="ctx-add-comment">💬 Add Comment</div>
  </div>

  <!-- Floating "add comment" form, shown when user triggers the command -->
  <div id="new-comment-panel">
    <label>After:</label>
    <div class="selection-preview" id="new-selection-preview"></div>
    <textarea id="new-comment-body" placeholder="Add a comment…" rows="3"></textarea>
    <div class="panel-actions">
      <button class="btn" id="btn-cancel-comment">Cancel</button>
      <button class="btn primary" id="btn-submit-comment">Comment</button>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function applyWholeDocumentEdit(
  document: vscode.TextDocument,
  newText: string,
  setApplying: (v: boolean) => void
): Promise<void> {
  setApplying(true);
  try {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      ),
      newText
    );
    await vscode.workspace.applyEdit(edit);
  } finally {
    // Brief guard so we don't react to our own document change event
    setTimeout(() => setApplying(false), 150);
  }
}
