import { join, relative } from 'path';

import * as vscode from 'vscode';

import { BASKETRY_LOG_CHANNEL } from './constants';

let channel: vscode.OutputChannel;

export function initLog(context: vscode.ExtensionContext) {
  channel = vscode.window.createOutputChannel(BASKETRY_LOG_CHANNEL);
  context.subscriptions.push(channel);
}

export function log(
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
