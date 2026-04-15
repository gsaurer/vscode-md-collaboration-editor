import * as vscode from "vscode";
import { MarkdownEditorProvider } from "./MarkdownEditorProvider";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(MarkdownEditorProvider.register(context));
}

export function deactivate(): void {}
