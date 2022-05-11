import { existsSync, readFileSync } from 'fs';
import { join, sep } from 'path';
import * as vscode from 'vscode';
import * as cp from 'child_process';

import type { Violation, Config, CliOutput, BasketryError } from 'basketry';

const workspaces = new Map<string, Workspace>();
const errorsByWorkspace = new Map<string, BasketryError[]>();

let statusBarItem: vscode.StatusBarItem;
let channel: vscode.OutputChannel;

type WorkspaceStatus = 'idle' | 'running' | 'error' | 'violations';

const statusByWorkspace = new Map<string, WorkspaceStatus>();

function updateStatus() {
  if (!statusByWorkspace.size) {
    statusBarItem.hide();
    return;
  }
  let icon = '$(pass)';
  for (const status of statusByWorkspace.values()) {
    if (status === 'running') icon = '$(loading~spin)';
    if (status === 'error') icon = '$(error)';
    if (status === 'violations') icon = '$(warning)';
    if (icon !== '$(pass)') break;
  }

  const ct = Array.from(workspaces.values()).filter(
    (w) => w.hasBasketry,
  ).length;

  statusBarItem.text = `${icon} Basketry`;
  statusBarItem.tooltip = `Active in ${ct} workspace folder${
    ct === 1 ? '' : 's'
  }`;
  statusBarItem.show();
}

export function activate(context: vscode.ExtensionContext) {
  channel = vscode.window.createOutputChannel('Basketry');
  context.subscriptions.push(channel);

  const diag = vscode.languages.createDiagnosticCollection('basketry');
  context.subscriptions.push(diag);

  context.subscriptions.push(
    vscode.commands.registerCommand('basketry-vscode.showErrors', () => {
      for (const [name, errors] of errorsByWorkspace) {
        for (const error of errors) {
          if (error.filepath) {
            vscode.window
              .showErrorMessage(
                `${error.code}: ${error.message} (${error.filepath})`,
                {
                  title: 'View File',
                  action() {
                    if (error.filepath) {
                      const Uri = vscode.Uri.file(error.filepath);
                      vscode.commands.executeCommand<vscode.TextDocumentShowOptions>(
                        'vscode.open',
                        Uri,
                      );
                    }
                  },
                },
              )
              .then((x) => x?.action());
          } else {
            vscode.window.showErrorMessage(`${error.code}: ${error.message}`);
          }
        }
      }
    }),
  );

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  statusBarItem.command = 'basketry-vscode.showErrors';
  context.subscriptions.push(statusBarItem);

  vscode.workspace.workspaceFolders?.forEach((folder) => {
    const existing = workspaces.get(folder.name);
    if (existing) {
      existing.dispose();
      workspaces.delete(folder.name);
    }

    workspaces.set(folder.name, new Workspace(context, folder));
  });

  updateStatus();

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

      updateStatus();
    }),
  );

  log('info', 'Extension activated');
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
    this.status = 'idle';
    this.diagnostics = vscode.languages.createDiagnosticCollection(folder.name);
    context.subscriptions.push(this.diagnostics);

    this.changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.fsPath === this.sourceUri?.fsPath) {
        this.info('Source changed');
        this.check(event.document.getText());
      } else if (
        !event.document.isDirty &&
        this.sourceUri &&
        event.document.uri.fsPath === this.configUri.fsPath
      ) {
        this.info('Config changed');
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
    this.info('Initialize workspace');
    if (this.sourceUri) {
      this.info(`Source: ${this.sourceUri.fsPath}`);
      this.info(`Config: ${this.configUri.fsPath}`);
      vscode.workspace
        .openTextDocument(this.sourceUri)
        .then((doc) => this.check(doc.getText()));
    }
  }

  private set status(value: WorkspaceStatus) {
    statusByWorkspace.set(this.folder.name, value);
    updateStatus();
  }

  get status(): WorkspaceStatus {
    return statusByWorkspace.get(this.folder.name)!;
  }

  check(content: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.status = 'running';
    errorsByWorkspace.delete(this.folder.name);
    this.timer = setTimeout(() => {
      try {
        if (!this.hasBasketry) {
          this.warning('Basketry not configured');
          this.diagnostics.clear();
          this.status = 'idle';
          return;
        }
        let stdout: string = '';
        const command = `node_modules/.bin/basketry --json --validate`;
        this.info(`command: ${command}`);

        stdout = cp
          .execSync(command, {
            cwd: this.folder.uri.fsPath,
            input: content,
          })
          .toString();
        this.info(`stdout: ${stdout.trim()}`);
        const output: CliOutput = JSON.parse(stdout);
        const { violations, errors } = output;
        const documents = new Set(violations.map((v) => v.sourcePath));

        this.diagnostics.clear();
        for (const document of documents) {
          this.diagnostics.set(
            vscode.Uri.parse(document),
            violations.map(createDiagnostic),
          );
        }

        if (errors.length) {
          this.status = 'error';
          errorsByWorkspace.set(this.folder.name, errors);
        } else {
          this.status = violations.length ? 'violations' : 'idle';
        }
      } catch (ex) {
        const err = ex as any;
        this.error(err.toString());
        this.status = 'error';
        this.diagnostics.clear();
        errorsByWorkspace.set(this.folder.name, [
          {
            code: 'FATAL_ERROR',
            message: err.message || err.toString(),
          },
        ]);
      }

      for (const e of errorsByWorkspace.get(this.folder.name) || []) {
        this.error(`${e.code}: ${e.message}`);
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

  get hasBasketry(): boolean {
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

  private log(level: 'debug' | 'info' | 'warning' | 'error', msg: string) {
    log(level, msg, this.folder.name);
  }

  private info(msg: string) {
    this.log('info', msg);
  }

  private warning(msg: string) {
    this.log('warning', msg);
  }

  private error(msg: string) {
    this.log('error', msg);
  }

  dispose() {
    this.info('Dispose workspace');
    statusByWorkspace.delete(this.folder.name);
    this.diagnostics.clear();
    this.diagnostics.dispose();
    this.changeListener.dispose();
  }
}

function log(
  level: 'debug' | 'info' | 'warning' | 'error',
  msg: string,
  folder?: string,
) {
  channel.appendLine(
    `[${date()}] [${[level, folder].filter((x) => x).join(' | ')}] ${msg}`,
  );
}

function date() {
  return (
    new Date().toLocaleString('sv') +
    '.' +
    `000${new Date().getMilliseconds()}`.slice(-3)
  );
}
