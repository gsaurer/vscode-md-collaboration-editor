import { execSync } from "child_process";
import * as vscode from "vscode";

export interface GitUser {
  name: string;
  email: string;
}

/**
 * Resolve the author identity for a new comment.
 * Priority: VS Code settings → git config → fallback.
 */
export function getGitUser(workspaceFolder?: string): GitUser {
  const cfg = vscode.workspace.getConfiguration("mdCollabEditor");
  const cfgName = cfg.get<string>("authorName", "").trim();
  const cfgEmail = cfg.get<string>("authorEmail", "").trim();

  if (cfgName && cfgEmail) {
    return { name: cfgName, email: cfgEmail };
  }

  try {
    const cwd = workspaceFolder ?? process.cwd();
    const opts = { cwd, encoding: "utf8" as const, stdio: "pipe" as const };
    const gitName = execSync("git config user.name", opts).toString().trim();
    const gitEmail = execSync("git config user.email", opts).toString().trim();
    return {
      name: cfgName || gitName || "Anonymous",
      email: cfgEmail || gitEmail || "",
    };
  } catch {
    return { name: cfgName || "Anonymous", email: cfgEmail || "" };
  }
}
