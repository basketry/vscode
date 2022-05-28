import * as cp from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';

import * as vscode from 'vscode';

import type {
  Violation,
  Config,
  CliOutput,
  BasketryError,
} from 'basketry/lib/types';

import { isLocalConfig, resolveConfig } from 'basketry/lib/utils';

const STOP_COMMAND = 'basketry-vscode.stop';
const START_COMMAND = 'basketry-vscode.start';
const RESTART_COMMAND = 'basketry-vscode.restart';
const SHOW_ERROR_COMMAND = 'basketry-vscode.showError';

const workers = new Set<Worker>();
const statusByConfig = new Map<string, WorkerStatus>();

let changeListener: vscode.Disposable | undefined;
let statusBarItem: vscode.StatusBarItem;
let channel: vscode.OutputChannel;
let stopped: boolean = true;

type WorkerStatus = 'idle' | 'running' | 'error' | 'violations';

export function activate(context: vscode.ExtensionContext) {
  channel = vscode.window.createOutputChannel('Basketry');
  context.subscriptions.push(channel);

  const diag = vscode.languages.createDiagnosticCollection('basketry');
  context.subscriptions.push(diag);

  context.subscriptions.push(
    vscode.commands.registerCommand(STOP_COMMAND, stopCommand),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(START_COMMAND, startCommand),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(RESTART_COMMAND, restartCommand),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_ERROR_COMMAND, showError),
  );

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      vscode.commands.executeCommand(RESTART_COMMAND);
    }),
  );

  vscode.commands.executeCommand(START_COMMAND);

  log('info', 'Extension activated');
}

export function deactivate() {
  vscode.commands.executeCommand(STOP_COMMAND);
}

async function restartCommand(): Promise<void> {
  await vscode.commands.executeCommand(STOP_COMMAND);
  await vscode.commands.executeCommand(START_COMMAND);
}

async function stopCommand(): Promise<void> {
  changeListener?.dispose();
  changeListener === undefined;

  for (const worker of workers) {
    worker.dispose();
  }

  workers.clear();
  stopped = true;
  updateStatus();
  log('info', 'Stopped');
}

async function startCommand(): Promise<void> {
  stopped = false;
  for (const workspace of vscode.workspace.workspaceFolders || []) {
    const config = vscode.Uri.parse(
      join(workspace.uri.fsPath, 'basketry.config.json'),
    );

    for (const worker of await Worker.create(workspace, config)) {
      workers.add(worker);
    }
  }

  changeListener?.dispose();

  changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    for (const worker of workers) {
      if (worker.isSource(event.document)) {
        log(
          'info',
          `Source changed: ${event.document.uri.fsPath}`,
          worker.workspace,
          worker.config,
        );
        worker.check(event.document.getText());
        break;
      } else if (!event.document.isDirty && worker.isConfig(event.document)) {
        log(
          'info',
          `Config changed: ${event.document.uri.fsPath}`,
          worker.workspace,
          worker.config,
        );
        worker.handleConfigChange();
        if (worker.sourceUri) {
          vscode.workspace
            .openTextDocument(worker.sourceUri)
            .then((doc) => worker.check(doc.getText()));
        }
      }
    }
  });

  updateStatus();
  log('info', 'Started');
}

async function showError(error: BasketryError): Promise<void> {
  const msg = error.filepath
    ? `${error.code}: ${error.message} (${error.filepath})`
    : `${error.code}: ${error.message}`;
  log('error', msg);

  // vscode.window.showErrorMessage(`${error.code}: ${error.message}`);
}

function updateStatus() {
  if (!workers.size || stopped) {
    statusBarItem.hide();
    return;
  }
  let icon = '$(pass)';
  for (const status of statusByConfig.values()) {
    if (status === 'running') icon = '$(loading~spin)';
    if (status === 'error') icon = '$(error)';
    if (status === 'violations') icon = '$(warning)';
    if (icon !== '$(pass)') break;
  }

  statusBarItem.text = `${icon} Basketry`;
  statusBarItem.show();
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

class Worker implements vscode.Disposable {
  private constructor(
    readonly workspace: vscode.WorkspaceFolder,
    readonly config: vscode.Uri,
  ) {
    this.status = 'idle';
    this.diagnostics = vscode.languages.createDiagnosticCollection(
      config.fsPath,
    );

    this.init();
  }

  private timer: NodeJS.Timeout | null = null;
  private readonly diagnostics: vscode.DiagnosticCollection;

  static async create(
    workspace: vscode.WorkspaceFolder,
    config: vscode.Uri,
  ): Promise<Worker[]> {
    const configs = await resolveConfig(config.fsPath, {
      cwd: workspace.uri.fsPath,
    });
    return configs.value.map(
      (c) =>
        new Worker(
          workspace,
          vscode.Uri.parse(resolve(workspace.uri.fsPath, c)),
        ),
    );
  }

  private init() {
    this.info('Initialize worker');
    this.handleConfigChange();
    if (this.sourceUri) {
      this.info(`Source: ${this.sourceUri.fsPath}`);
      this.info(`Config: ${this.config.fsPath}`);
      vscode.workspace
        .openTextDocument(this.sourceUri)
        .then((doc) => this.check(doc.getText()));
    }
  }

  isSource(file: vscode.TextDocument): boolean {
    return file.uri.fsPath === this._sourceUri?.fsPath;
  }

  isConfig(file: vscode.TextDocument): boolean {
    return file.uri.fsPath === this.config.fsPath;
  }

  check(content: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.status = 'running';
    this.timer = setTimeout(async () => {
      try {
        this.handleConfigChange();
        if (!this.hasBasketry) {
          this.warning('Basketry not configured');
          this.diagnostics.clear();
          this.status = 'idle';
          return;
        }
        const configPath = relative(
          this.workspace.uri.fsPath,
          this.config.fsPath,
        );
        const command = 'node_modules/.bin/basketry';
        const args = ['--config', configPath, '--json', '--validate'];
        this.info(`command: ${[command, ...args].join(' ')}`);

        const { stdout, stderr, code, ms } = await exec(command, args, {
          cwd: this.workspace.uri.fsPath,
          input: content,
        });

        this.info(`Completed in ${ms}ms`);

        if (code === null) {
          throw new Error('Timeout!');
        } else if (code !== 0) {
          throw new Error(stderr);
        }

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
          for (const err of errors) {
            vscode.commands.executeCommand(SHOW_ERROR_COMMAND, err);
          }
        } else {
          this.status = violations.length ? 'violations' : 'idle';
        }
      } catch (ex) {
        const err = ex as any;
        this.error(err.toString());
        this.status = 'error';
        this.diagnostics.clear();
        vscode.commands.executeCommand(SHOW_ERROR_COMMAND, {
          code: 'FATAL_ERROR',
          message: err.message || err.toString(),
        });
      }
    }, 500);
  }

  private _sourceUri: vscode.Uri | undefined;
  public handleConfigChange(): void {
    try {
      const basketryConfig: Config = JSON.parse(
        readFileSync(this.config.fsPath).toString(),
      );

      if (isLocalConfig(basketryConfig) && basketryConfig.source) {
        this._sourceUri = vscode.Uri.parse(
          resolve(this.workspace.uri.fsPath, basketryConfig.source),
        );
      } else {
        this._sourceUri = undefined;
      }
    } catch {
      this._sourceUri = undefined;
    }
  }

  get sourceUri(): vscode.Uri | undefined {
    return this._sourceUri;
  }

  get hasBasketry(): boolean {
    try {
      const isBasketryInstalled = existsSync(
        resolve(this.workspace.uri.fsPath, 'node_modules', '.bin', 'basketry'),
      );
      if (!isBasketryInstalled) {
        this.info(`Basketry is not installed`);
        return false;
      }

      const basketryConfig: Config = JSON.parse(
        readFileSync(this.config.fsPath).toString(),
      );

      return (
        isLocalConfig(basketryConfig) &&
        !!basketryConfig.source &&
        existsSync(resolve(this.workspace.uri.fsPath, basketryConfig.source))
      );
    } catch (ex) {
      this.log('error', (ex as any).message);
      return false;
    }
  }

  private set status(value: WorkerStatus) {
    statusByConfig.set(this.config.fsPath, value);
    updateStatus();
  }

  get status(): WorkerStatus {
    return statusByConfig.get(this.config.fsPath)!;
  }

  private log(level: 'debug' | 'info' | 'warning' | 'error', msg: string) {
    log(level, msg, this.workspace, this.config);
  }

  private debug(msg: string) {
    this.log('debug', msg);
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
    statusByConfig.delete(this.config.fsPath);
    this.diagnostics.clear();
    this.diagnostics.dispose();
  }
}

function log(
  level: 'debug' | 'info' | 'warning' | 'error',
  msg: string,
  workspace?: vscode.WorkspaceFolder,
  config?: vscode.Uri,
) {
  const name = workspace?.name;
  const path =
    workspace && config
      ? relative(workspace.uri.fsPath, config.fsPath)
      : undefined;
  const location =
    workspace || config
      ? join(
          ...[
            name,
            path?.substring(0, path.length - '/basketry.config.json'.length),
          ].filter((x): x is string => !!x),
        )
      : undefined;

  channel.appendLine(
    `[${date()}] [${[level, location].filter((x) => x).join(' | ')}] ${msg}`,
  );
}

function date() {
  return (
    new Date().toLocaleString('sv') +
    '.' +
    `000${new Date().getMilliseconds()}`.slice(-3)
  );
}

function exec(
  command: string,
  args: string[],
  options: { cwd: string; input: string },
): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
}> {
  return new Promise((res) => {
    const s = process.hrtime();
    const { input, ...rest } = options;
    let stdout: string = '';
    let stderr: string = '';

    const proc = cp.spawn(command, args, { timeout: 5000, ...rest });
    proc.stdin.write(input);
    proc.stdin.end();
    proc.stdout.on('data', (data) => (stdout += data.toString()));
    proc.stderr.on('data', (data) => (stderr += data.toString()));
    proc.on('close', (code) => {
      const e = process.hrtime(s);
      const ms = Math.round((e[0] * 1000000000 + e[1]) / 1000000);
      res({ stdout, stderr, code, ms });
    });
  });
}
