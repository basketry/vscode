import { readFile } from 'fs/promises';
import { join } from 'path';

import * as vscode from 'vscode';

import { Worker } from './worker';
import {
  PREVIEW_SERIVCE_COMMAND,
  RESTART_COMMAND,
  START_COMMAND,
  STOP_COMMAND,
} from './constants';
import { updateStatus } from './status-bar';
import { log } from './log';
import { reloadServiceView } from './tree-view';

// let activeTabListener: vscode.Disposable | undefined;
let changeListener: vscode.Disposable | undefined;
let _stopped: boolean = true;

/** Gets a value indicating if the extension is stopped */
export function stopped(): boolean {
  return _stopped;
}

/** Gets a value indicating if the extension is started */
export function started(): boolean {
  return !_stopped;
}

export function initCommands(context: vscode.ExtensionContext): void {
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
    vscode.commands.registerCommand(
      PREVIEW_SERIVCE_COMMAND,
      (worker?: Worker) => {
        if (worker) reloadServiceView(worker);
      },
    ),
  );
}

export async function restartCommand(): Promise<void> {
  await vscode.commands.executeCommand(STOP_COMMAND);
  await vscode.commands.executeCommand(START_COMMAND);
}

export async function stopCommand(): Promise<void> {
  changeListener?.dispose();
  changeListener === undefined;

  for (const worker of Worker.all) {
    worker.dispose();
  }

  _stopped = true;
  updateStatus();
  log('info', 'Stopped');
}

export async function startCommand(): Promise<void> {
  _stopped = false;
  for (const workspace of vscode.workspace.workspaceFolders || []) {
    let npmPkg: { workspaces?: string[] } | undefined;
    try {
      const pkg = await readFile(
        vscode.Uri.parse(join(workspace.uri.fsPath, 'package.json')).fsPath,
        'utf-8',
      );
      npmPkg = JSON.parse(pkg);
    } catch (e) {}

    for (const npmWorkspace of npmPkg?.workspaces || []) {
      const workspaceConfig = vscode.Uri.parse(
        join(workspace.uri.fsPath, npmWorkspace, 'basketry.config.json'),
      );
      await Worker.create(workspace, workspaceConfig);
    }

    const rootConfig = vscode.Uri.parse(
      join(workspace.uri.fsPath, 'basketry.config.json'),
    );
    await Worker.create(workspace, rootConfig);
  }

  changeListener?.dispose();

  changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    for (const worker of Worker.all) {
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
