import { existsSync, readFileSync } from 'fs';
import { join, sep } from 'path';
import * as vscode from 'vscode';
import * as cp from 'child_process';

import type { Violation, Config } from 'basketry';

const workspaces = new Map<string, Workspace>();

export function activate(context: vscode.ExtensionContext) {
  const diag = vscode.languages.createDiagnosticCollection('basketry');
  context.subscriptions.push(diag);

  vscode.workspace.workspaceFolders?.forEach((folder) => {
    const existing = workspaces.get(folder.name);
    if (existing) {
      existing.dispose();
      workspaces.delete(folder.name);
    }

    workspaces.set(folder.name, new Workspace(context, folder));
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const added of event.added) {
        const existing = workspaces.get(added.name);
        if (existing) {
          existing.dispose();
          workspaces.delete(added.name);
        }

        workspaces.set(added.name, new Workspace(context, added));
      }

      for (const removed of event.removed) {
        const workspace = workspaces.get(removed.name);
        if (workspace) {
          workspace.dispose();
          workspaces.delete(removed.name);
        }
      }
    }),
  );
}

export function deactivate() {
  for (const workspace of workspaces.values()) {
    workspace.dispose();
  }
}

export function resolvePath(
  folder: vscode.WorkspaceFolder,
  path: string,
): string {
  if (path.startsWith(sep)) return path;
  return join(folder.uri.fsPath, path);
}

function createDiagnostic(violation: Violation): vscode.Diagnostic {
  const { start, end } = violation.range;
  const range = new vscode.Range(
    start.line - 1,
    start.column - 1,
    end.line - 1,
    end.column - 1,
  );

  let severity: vscode.DiagnosticSeverity;

  switch (violation.severity) {
    case 'error':
      severity = vscode.DiagnosticSeverity.Error;
      break;
    case 'warning':
      severity = vscode.DiagnosticSeverity.Warning;
      break;
    case 'info':
      severity = vscode.DiagnosticSeverity.Information;
      break;
  }

  const diagnostic = new vscode.Diagnostic(range, violation.message, severity);
  diagnostic.code = violation.code;
  return diagnostic;
}

class Workspace implements vscode.Disposable {
  constructor(
    context: vscode.ExtensionContext,
    private readonly folder: vscode.WorkspaceFolder,
  ) {
    this.diagnostics = vscode.languages.createDiagnosticCollection(folder.name);
    context.subscriptions.push(this.diagnostics);

    this.changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.fsPath === this.sourceUri?.fsPath) {
        this.check(event.document.getText());
      } else if (
        !event.document.isDirty &&
        this.sourceUri &&
        event.document.uri.fsPath === this.configUri.fsPath
      ) {
        vscode.workspace
          .openTextDocument(this.sourceUri)
          .then((doc) => this.check(doc.getText()));
      }
    });

    context.subscriptions.push(this.changeListener);

    this.init();
  }

  private timer: NodeJS.Timeout | null = null;

  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly changeListener: vscode.Disposable;

  private init() {
    if (this.sourceUri) {
      vscode.workspace
        .openTextDocument(this.sourceUri)
        .then((doc) => this.check(doc.getText()));
    }
  }

  check(content: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.hasBasketry()) {
        this.diagnostics.clear();
        return;
      }

      let stdout: string = '';

      try {
        stdout = cp
          .execSync(`node_modules/.bin/basketry --json --validate`, {
            cwd: this.folder.uri.fsPath,
            input: content,
          })
          .toString();
      } catch (ex) {
        console.error(ex);
      }
      try {
        const violations: Violation[] = JSON.parse(stdout);
        const documents = new Set(violations.map((v) => v.document));

        this.diagnostics.clear();
        for (const document of documents) {
          this.diagnostics.set(
            vscode.Uri.parse(document),
            violations.map(createDiagnostic),
          );
        }
      } catch (ex) {
        console.error(ex);
      }
    }, 500);
  }

  get sourceUri(): vscode.Uri | undefined {
    try {
      const basketryConfig: Config = JSON.parse(
        readFileSync(this.configUri.fsPath).toString(),
      );

      if (!basketryConfig.source) return;

      return vscode.Uri.parse(resolvePath(this.folder, basketryConfig.source));
    } catch {
      return;
    }
  }

  get configUri(): vscode.Uri {
    return vscode.Uri.parse(
      join(this.folder.uri.fsPath, 'basketry.config.json'),
    );
  }

  private hasBasketry(): boolean {
    try {
      const isBasketryInstalled = existsSync(
        join(this.folder.uri.fsPath, 'node_modules', '.bin', 'basketry'),
      );
      if (!isBasketryInstalled) return false;

      const basketryConfig: Config = JSON.parse(
        readFileSync(
          join(this.folder.uri.fsPath, 'basketry.config.json'),
        ).toString(),
      );

      return (
        !!basketryConfig.source &&
        existsSync(resolvePath(this.folder, basketryConfig.source))
      );
    } catch {
      return false;
    }
  }

  dispose() {
    this.diagnostics.clear();
    this.diagnostics.dispose();
    this.changeListener.dispose();
  }
}
