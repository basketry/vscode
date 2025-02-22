import * as vscode from 'vscode';

import { Worker } from './worker';
import { stopped } from './commands';

let statusBarItem: vscode.StatusBarItem;

export function initStatusBar() {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
}

export function updateStatus() {
  if (!Worker.all.length || stopped()) {
    statusBarItem.hide();
    return;
  }
  let icon = '$(pass)';
  for (const status of Worker.statusByConfig.values()) {
    if (status === 'running') icon = '$(loading~spin)';
    if (status === 'error') icon = '$(error)';
    if (status === 'violations') icon = '$(warning)';
    if (icon !== '$(pass)') break;
  }

  statusBarItem.text = `${icon} Basketry`;
  statusBarItem.show();
}
