import * as vscode from "vscode";
import * as crypto from "crypto";
import {
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
  generateId,
  SimpleComment,
  Reply,
  Like,
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
  | { type: "addComment"; id?: string; anchoredText: string; body: string; markdown?: string }
  | { type: "deleteComment"; id: string }
  | { type: "editComment"; id: string; newBody: string }
  | { type: "resolveComment"; id: string; resolved: boolean }
  | { type: "addReply"; commentId: string; body: string }
  | { type: "deleteReply"; commentId: string; replyId: string }
  | { type: "editReply"; commentId: string; replyId: string; newBody: string }
  | { type: "resolveAll" }
  | { type: "deleteAll" }
  | { type: "likeComment"; id: string }
  | { type: "likeReply"; commentId: string; replyId: string };

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
              id: msg.id ?? generateId(),
              author: user.name,
              body: msg.body,
              date: new Date().toISOString(),
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

          case "resolveComment": {
            const newText = resolveComment(
              document.getText(),
              msg.id,
              msg.resolved
            );
            await applyWholeDocumentEdit(
              document,
              newText,
              (v) => (isApplyingEdit = v)
            );
            pushUpdate();
            break;
          }

          case "addReply": {
            const workspacePath = vscode.workspace.getWorkspaceFolder(
              document.uri
            )?.uri.fsPath;
            const user = getGitUser(workspacePath);
            const reply: Reply = {
              id: generateId(),
              author: user.name,
              body: msg.body,
              date: new Date().toISOString(),
            };
            const newText = addReply(document.getText(), msg.commentId, reply);
            await applyWholeDocumentEdit(
              document,
              newText,
              (v) => (isApplyingEdit = v)
            );
            pushUpdate();
            break;
          }

          case "deleteReply": {
            const newText = deleteReply(
              document.getText(),
              msg.commentId,
              msg.replyId
            );
            await applyWholeDocumentEdit(
              document,
              newText,
              (v) => (isApplyingEdit = v)
            );
            pushUpdate();
            break;
          }

          case "editReply": {
            const newText = editReply(
              document.getText(),
              msg.commentId,
              msg.replyId,
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

          case "resolveAll": {
            const { comments: allComments } = parseDocument(document.getText());
            let resolvedText = document.getText();
            for (const c of allComments) {
              resolvedText = resolveComment(resolvedText, c.id, true);
            }
            await applyWholeDocumentEdit(document, resolvedText, (v) => (isApplyingEdit = v));
            pushUpdate();
            break;
          }

          case "deleteAll": {
            const { comments: allComments2 } = parseDocument(document.getText());
            let deletedText = document.getText();
            for (const c of allComments2) {
              deletedText = removeComment(deletedText, c.id);
            }
            await applyWholeDocumentEdit(document, deletedText, (v) => (isApplyingEdit = v));
            pushUpdate();
            break;
          }

          case "likeComment": {
            const workspacePath = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
            const user = getGitUser(workspacePath);
            const newText = toggleLike(document.getText(), msg.id, user.name);
            await applyWholeDocumentEdit(document, newText, (v) => (isApplyingEdit = v));
            pushUpdate();
            break;
          }

          case "likeReply": {
            const workspacePath = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
            const user = getGitUser(workspacePath);
            const newText = toggleLikeReply(document.getText(), msg.commentId, msg.replyId, user.name);
            await applyWholeDocumentEdit(document, newText, (v) => (isApplyingEdit = v));
            pushUpdate();
            break;
          }
        }
      }
    );

    // ── Sync external file changes → webview ──────────────────────────────────

    // Debounce: parsing on every keystroke blocks the extension host, preventing
    // the close button and other UI events from being processed in time.
    let changeTimer: ReturnType<typeof setTimeout> | undefined;
    const changeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (
        e.document.uri.toString() === document.uri.toString() &&
        !isApplyingEdit
      ) {
        if (changeTimer) { clearTimeout(changeTimer); }
        changeTimer = setTimeout(() => { pushUpdate(); }, 200);
      }
    });

    webviewPanel.onDidDispose(() => {
      if (this.activePanel === webviewPanel) {
        this.activePanel = undefined;
      }
      if (changeTimer) { clearTimeout(changeTimer); }
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
      position: relative;
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
      font-size: 1.25em;
      margin-left: 3px;
      cursor: pointer;
      vertical-align: middle;
      user-select: none;
      opacity: 0.9;
      transition: opacity 0.15s, transform 0.1s;
      line-height: 1;
    }
    .comment-icon:hover { opacity: 1; transform: scale(1.15); }

    /* ── Comment pane header ──────────────────────── */
    .pane-header {
      padding: 6px 8px 6px 14px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
      background: var(--vscode-sideBarSectionHeader-background, transparent);
      user-select: none;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    #header-more-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      font-size: 16px;
      letter-spacing: -1px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      border-radius: 3px;
      opacity: 0.5;
      padding: 0;
      font-weight: 400;
      text-transform: none;
    }
    #header-more-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    /* Dropdown menu */
    #header-menu {
      display: none;
      position: absolute;
      right: 8px;
      top: 34px;
      background: var(--vscode-menu-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      z-index: 100;
      min-width: 170px;
      padding: 4px 0;
    }
    #header-menu.open { display: block; }
    .header-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 14px;
      font-size: 12px;
      font-weight: 400;
      text-transform: none;
      letter-spacing: 0;
      cursor: pointer;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      white-space: nowrap;
    }
    .header-menu-item:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-toolbar-hoverBackground)); }
    .header-menu-item.danger { color: var(--vscode-inputValidation-errorBorder); }

    #threads-container {
      flex: 1;
      overflow: hidden;
      position: relative;
    }

    /* ── Comment card ──────────────────────────────── */
    .thread {
      position: absolute;
      left: 8px;
      right: 8px;
      box-sizing: border-box;
      padding: 10px 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      cursor: default;
      transition: background 0.1s, box-shadow 0.1s;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    .thread:hover { background: var(--vscode-list-hoverBackground); box-shadow: 0 2px 8px rgba(0,0,0,0.12); }
    .thread.active { background: var(--vscode-list-activeSelectionBackground); }
    /* Per-card ... dropdown */
    .thread-menu {
      display: none;
      position: absolute;
      right: 8px;
      top: 34px;
      background: var(--vscode-menu-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      z-index: 200;
      min-width: 140px;
      padding: 4px 0;
    }
    .thread-menu.open { display: block; }
    .thread-menu-item {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 7px 12px;
      font-size: 12px;
      cursor: pointer;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      white-space: nowrap;
    }
    .thread-menu-item:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-toolbar-hoverBackground)); }
    .thread-menu-item.danger { color: var(--vscode-inputValidation-errorBorder); }

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
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 5px;
    }
    .thread-meta-left {
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
    }
    .thread-author {
      font-weight: 600;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .thread-body {
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    /* Like button — in the meta icon row */
    .like-btn { font-size: 13px; }
    .like-btn.liked { opacity: 1; color: var(--vscode-textLink-foreground, #3794ff); }
    .like-btn.has-likes { opacity: 0.85 !important; }
    .like-btn .like-count { font-size: 10px; margin-left: 1px; }

    /* ── Action buttons ───────────────────────────── */
    .thread-icon-actions {
      display: flex;
      gap: 2px;
      flex-shrink: 0;
    }
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      font-size: 15px;
      line-height: 1;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      border-radius: 3px;
      opacity: 0.55;
      padding: 0;
      font-family: var(--vscode-font-family);
    }
    .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    .icon-btn.resolve { color: var(--vscode-testing-iconPassed, #4caf50); }
    .icon-btn.danger:hover { color: var(--vscode-inputValidation-errorBorder); opacity: 1; }
    /* Save/cancel row — right-aligned below textarea, Word-style */
    .thread-actions {
      margin-top: 6px;
      display: flex;
      gap: 4px;
      align-items: center;
      justify-content: flex-end;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      font-size: 15px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      background: transparent;
      color: var(--vscode-foreground);
      opacity: 0.6;
      padding: 0;
      font-family: var(--vscode-font-family);
    }
    .btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    .btn.primary {
      color: var(--vscode-testing-iconPassed, #4caf50);
      opacity: 0.85;
    }
    .btn.primary:hover { opacity: 1; }
    .btn:disabled, .btn.primary:disabled { opacity: 0.3; pointer-events: none; }
    .btn.danger { color: var(--vscode-inputValidation-errorBorder); }

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
      position: absolute;
      left: 8px;
      right: 8px;
      box-sizing: border-box;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 4px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      padding: 10px 12px;
      display: none;
      flex-direction: column;
      gap: 8px;
      z-index: 300;
    }
    #new-comment-panel.visible { display: flex; }
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
      min-height: 56px;
      box-sizing: border-box;
    }
    #new-comment-panel textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
    #new-comment-panel .panel-actions { display: flex; gap: 4px; justify-content: flex-end; }
    #new-comment-panel .panel-actions .btn { font-size: 16px; }

    /* ── Thread date ──────────────────────────────── */
    .thread-date-line {
      font-size: 11px;
      opacity: 0.5;
      margin-top: 4px;
      padding: 0 2px;
    }

    /* ── Resolved state ───────────────────────────── */
    .thread.resolved {
      opacity: 0.5;
    }
    .thread.resolved .thread-body,
    .thread.resolved .thread-anchor-preview {
      text-decoration: line-through;
      text-decoration-color: var(--vscode-foreground);
    }
    .thread.resolved .thread-author::after {
      content: " ✓ Resolved";
      font-size: 10px;
      font-weight: 400;
      color: var(--vscode-testing-iconPassed, #4caf50);
      margin-left: 4px;
    }
    .btn.resolve { color: var(--vscode-testing-iconPassed, #4caf50); }

    /* ── Replies ──────────────────────────────────── */
    .replies {
      margin-top: 10px;
      border-left: 2px solid var(--vscode-panel-border);
      padding-left: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    /* Hide reply action buttons until hovered */
    .reply .reply-icon-actions-hover { opacity: 0; transition: opacity 0.12s; }
    .reply:hover .reply-icon-actions-hover,
    .reply .reply-icon-actions-hover:has(.has-likes) { opacity: 1; }
    .reply {
      font-size: 12px;
    }
    .reply .thread-body {
      font-size: 12px;
    }
    .reply .thread-actions {
      margin-top: 5px;
    }
    .reply-edit-textarea {
      width: 100%;
      padding: 4px 6px;
      margin-top: 4px;
      font-size: 12px;
      font-family: var(--vscode-font-family);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      resize: vertical;
      min-height: 44px;
      box-sizing: border-box;
    }
    .reply-edit-textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }

    /* ── Reply bar (always-visible, Word-style) ───── */
    .reply-bar {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 8px 8px;
      border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.2));
      margin-top: 4px;
    }
    .reply-bar-textarea {
      width: 100%;
      resize: none;
      border: 1px solid transparent;
      border-radius: 3px;
      padding: 4px 6px;
      font-size: 12px;
      font-family: var(--vscode-font-family);
      background: var(--vscode-input-background, rgba(128,128,128,0.08));
      color: var(--vscode-input-foreground);
      min-height: 26px;
      box-sizing: border-box;
      overflow: hidden;
    }
    .reply-bar-textarea:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    .reply-bar-actions {
      display: none;
      gap: 2px;
      justify-content: flex-end;
    }
    .reply-bar.active .reply-bar-actions { display: flex; }

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
      <div class="pane-header">
        <span>Comments</span>
        <button id="header-more-btn" title="More actions">&#8943;</button>
      </div>
      <div id="header-menu">
        <div class="header-menu-item" id="menu-resolve-all">&#10003;&nbsp; Resolve all</div>
        <div class="header-menu-item danger" id="menu-delete-all">&#128465;&nbsp; Delete all</div>
      </div>
      <div id="threads-container"></div>
    </div>
  </div>

  <!-- Right-click context menu -->
  <div id="ctx-menu">
    <div class="ctx-item" id="ctx-add-comment">💬 Add Comment</div>
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
