import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { execSync } from 'child_process';

import * as vscode from 'vscode';

import type { Violation, Config, CliOutput } from 'basketry/lib/types';

import { isLocalConfig, resolveConfig } from 'basketry/lib/utils';

import { exec } from './utils';
import { SHOW_ERROR_COMMAND } from './constants';
import { reloadServiceView } from './tree-view';
import { log } from './log';
import { updateStatus } from './status-bar';
import { Service } from 'basketry';

const workers = new Set<Worker>();
const statusByConfig = new Map<string, WorkerStatus>();
type WorkerStatus = 'idle' | 'running' | 'error' | 'violations';

const workerAddedHandlers = new Set<WorkerEvent>();
const workerRemovedHandlers = new Set<WorkerEvent>();
const serviceHandler = new Set<ServiceEvent>();

export type WorkerEvent = (worker: Worker) => void;
export type ServiceEvent = (service: Service, worker: Worker) => void;

export class Worker implements vscode.Disposable {
  private constructor(
    readonly workspace: vscode.WorkspaceFolder,
    readonly config: vscode.Uri,
    readonly cwd: string,
  ) {
    this.status = 'idle';
    this.diagnostics = vscode.languages.createDiagnosticCollection(
      config.fsPath,
    );

    this.init();
  }

  private _service: Service | undefined;
  get service(): Service | undefined {
    return this._service;
  }

  /** Gets an array of all Worker instances. Disposed workers are removed from this list. */
  static get all(): Worker[] {
    return Array.from(workers);
  }

  static get statusByConfig(): ReadonlyMap<string, WorkerStatus> {
    return statusByConfig;
  }

  private timer: NodeJS.Timeout | null = null;
  private readonly diagnostics: vscode.DiagnosticCollection;

  static onWorkerAdded(handler: WorkerEvent): void {
    workerAddedHandlers.add(handler);
  }

  static onWorkerRemoved(handler: WorkerEvent): void {
    workerRemovedHandlers.add(handler);
  }

  static onServiceChanged(handler: ServiceEvent): void {
    serviceHandler.add(handler);
  }

  static removeHandler(handler: WorkerEvent | ServiceEvent): void {
    workerAddedHandlers.delete(handler as any);
    workerRemovedHandlers.delete(handler as any);
    serviceHandler.delete(handler as any);
  }

  static async create(
    workspace: vscode.WorkspaceFolder,
    config: vscode.Uri,
  ): Promise<Worker[]> {
    const configs = await resolveConfig(config.fsPath, {
      cwd: workspace.uri.fsPath,
    });
    return configs.value.map((c) => {
      const configUri = vscode.Uri.parse(c);
      const worker = new Worker(
        workspace,
        configUri,
        dirname(configUri.fsPath),
      );
      workers.add(worker);
      for (const handler of workerAddedHandlers) {
        handler(worker);
      }
      return worker;
    });
  }

  private init() {
    this.info('Initialize worker');
    this.handleConfigChange();
    if (this.sourceUri) {
      this.info(`Source: ${this.sourceUri.fsPath}`);
      this.info(`Config: ${this.config.fsPath}`);
      this.info(`CWD: ${this.cwd}`);
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

        if (!this.isBasketryInstalled) {
          this.warning('Basketry not installed');
          this.diagnostics.clear();
          this.status = 'idle';
          return;
        }

        // TODO: condider not doing this
        if (
          vscode.window.activeTextEditor &&
          this.isSource(vscode.window.activeTextEditor.document)
        ) {
          reloadServiceView(this);
        }

        const configPath = this.config.fsPath;
        log('info', `Checking ${configPath}`, this.workspace, this.config);
        const args = [
          '--no',
          'basketry',
          '--',
          '--config',
          configPath,
          '--json',
          '--validate',
        ];
        this.info(`command: ${['npx', ...args].join(' ')}`);

        const { stdout, stderr, code, ms } = await exec('npx', args, {
          cwd: this.cwd,
          input: content,
        });

        // TODO: do in parallel with the validation above
        const serviceResult = await exec(
          'npx',
          ['--no', 'basketry', '--', 'ir', '--config', configPath],
          {
            cwd: this.cwd,
            input: content,
          },
        );

        this.info(`Completed in ${ms}ms`);

        if (code === null || serviceResult.code === null) {
          throw new Error('Timeout!');
        } else if (code !== 0 || serviceResult.code !== 0) {
          throw new Error(stderr);
        }

        this.info(`stdout: ${stdout.trim()}`);
        const output: CliOutput = JSON.parse(stdout);
        this._service = JSON.parse(serviceResult.stdout).service;

        if (this._service) {
          for (const handler of serviceHandler) {
            handler(this._service, this);
          }
        }

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
          resolve(this.cwd, basketryConfig.source),
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

  get isBasketryInstalled(): boolean {
    try {
      execSync('npx --no basketry -- --version', {
        stdio: 'ignore',
        cwd: this.cwd,
      });
      return true;
    } catch {
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

    workers.delete(this);
    for (const handler of workerRemovedHandlers) {
      handler(this);
    }
  }
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
