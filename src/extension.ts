import * as vscode from 'vscode';

import type { BasketryError } from 'basketry/lib/types';
import {
  RESTART_COMMAND,
  SHOW_ERROR_COMMAND,
  START_COMMAND,
  STOP_COMMAND,
} from './constants';
import { initCommands } from './commands';
import { initLog, log } from './log';
import { initStatusBar } from './status-bar';
import { initTreeView } from './tree-view';

export function activate(context: vscode.ExtensionContext) {
  initLog(context);

  const diag = vscode.languages.createDiagnosticCollection('basketry');
  context.subscriptions.push(diag);

  initCommands(context);

  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_ERROR_COMMAND, showError),
  );

  initStatusBar();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      vscode.commands.executeCommand(RESTART_COMMAND);
    }),
  );

  initTreeView();

  vscode.commands.executeCommand(START_COMMAND);

  log('info', 'Extension activated');
}

export function deactivate() {
  vscode.commands.executeCommand(STOP_COMMAND);
}

async function showError(error: BasketryError): Promise<void> {
  const msg = error.filepath
    ? `${error.code}: ${error.message} (${error.filepath})`
    : `${error.code}: ${error.message}`;
  log('error', msg);

  // vscode.window.showErrorMessage(`${error.code}: ${error.message}`);
}
