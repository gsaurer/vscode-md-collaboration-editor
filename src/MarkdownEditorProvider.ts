import * as vscode from "vscode";
import * as crypto from "crypto";
import * as path from "path";
import {
  parseDocument,
  generateId,
  SimpleComment,
  Reply,
} from "./commentParser";
import { CommentStore, InlineMdCommentStore } from "./CommentStore";
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
  | { type: "likeReply"; commentId: string; replyId: string }
  | { type: "openFile"; relativePath: string };

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

    // Register the "Open with Collaboration Editor" context menu command
    const openWithDisposable = vscode.commands.registerCommand(
      "mdCollabEditor.openWith",
      (uri: vscode.Uri) => {
        vscode.commands.executeCommand(
          "vscode.openWith",
          uri,
          MarkdownEditorProvider.viewType
        );
      }
    );

    return vscode.Disposable.from(editorDisposable, commandDisposable, openWithDisposable);
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
    const docFolder = vscode.Uri.file(path.dirname(document.uri.fsPath));

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        docFolder,
      ],
    };

    webviewPanel.webview.html = this.buildHtml(webviewPanel.webview, docFolder);

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

    const applyEdit = (newText: string) =>
      applyWholeDocumentEdit(document, newText, (v) => (isApplyingEdit = v));

    const store: CommentStore = new InlineMdCommentStore(
      () => document.getText(),
      applyEdit,
    );

    const workspacePath = () =>
      vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;

    const pushUpdate = async () => {
      const { contentMarkdown, comments } = await store.load();
      const currentUser = getGitUser(workspacePath());
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
            if (isApplyingEdit) return;
            await store.saveContent(msg.markdown);
            break;
          }

          case "addComment": {
            const user = getGitUser(workspacePath());
            const newComment: SimpleComment = {
              id: msg.id ?? generateId(),
              author: user.name,
              body: msg.body,
              date: new Date().toISOString(),
              anchoredText: msg.anchoredText,
            };
            await store.addComment(newComment, msg.markdown);
            pushUpdate();
            break;
          }

          case "deleteComment": {
            await store.deleteComment(msg.id);
            pushUpdate();
            break;
          }

          case "editComment": {
            await store.editComment(msg.id, msg.newBody);
            pushUpdate();
            break;
          }

          case "resolveComment": {
            await store.resolveComment(msg.id, msg.resolved);
            pushUpdate();
            break;
          }

          case "addReply": {
            const user = getGitUser(workspacePath());
            const reply: Reply = {
              id: generateId(),
              author: user.name,
              body: msg.body,
              date: new Date().toISOString(),
            };
            await store.addReply(msg.commentId, reply);
            pushUpdate();
            break;
          }

          case "deleteReply": {
            await store.deleteReply(msg.commentId, msg.replyId);
            pushUpdate();
            break;
          }

          case "editReply": {
            await store.editReply(msg.commentId, msg.replyId, msg.newBody);
            pushUpdate();
            break;
          }

          case "resolveAll": {
            await store.resolveAll();
            pushUpdate();
            break;
          }

          case "deleteAll": {
            await store.deleteAll();
            pushUpdate();
            break;
          }

          case "likeComment": {
            const user = getGitUser(workspacePath());
            await store.toggleLike(msg.id, user.name);
            pushUpdate();
            break;
          }

          case "likeReply": {
            const user = getGitUser(workspacePath());
            await store.toggleLikeReply(msg.commentId, msg.replyId, user.name);
            pushUpdate();
            break;
          }

          case "openFile": {
            const docDir = path.dirname(document.uri.fsPath);
            const targetPath = path.resolve(docDir, msg.relativePath);
            const targetUri = vscode.Uri.file(targetPath);
            await vscode.commands.executeCommand(
              "vscode.openWith",
              targetUri,
              MarkdownEditorProvider.viewType
            );
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

  private buildHtml(webview: vscode.Webview, docFolder: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "editor.css")
    );
    const resourceBase = webview.asWebviewUri(docFolder).toString();
    const nonce = crypto.randomBytes(16).toString("base64url");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <base href="${resourceBase}/" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}' 'unsafe-eval';
             img-src ${webview.cspSource} data: https:;
             font-src ${webview.cspSource};" />
  <title>Markdown Collaboration Editor</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div id="app">
    <div id="editor-pane">
      <div id="editor"></div>
      <div id="mermaid-layer"></div>
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

  <script nonce="${nonce}">window.__resourceBase = "${resourceBase}";</script>
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
