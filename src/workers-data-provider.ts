import * as vscode from 'vscode';
import { Worker } from './worker';
import { relative } from 'path';
import { PREVIEW_SERIVCE_COMMAND } from './constants';

const nodes: vscode.TreeItem[] = [
  new vscode.TreeItem('Thing 1', vscode.TreeItemCollapsibleState.None),
  new vscode.TreeItem('Thing 2', vscode.TreeItemCollapsibleState.None),
  new vscode.TreeItem('Thing 3', vscode.TreeItemCollapsibleState.None),
];

export class WorkersDataProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  onDidChangeTreeData?: vscode.Event<any> | undefined;

  getTreeItem(
    element: vscode.TreeItem,
  ): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }
  getChildren(element?: any): vscode.ProviderResult<vscode.TreeItem[]> {
    return Worker.all.map((w) => {
      const item = new vscode.TreeItem(
        w.service
          ? `${w.service.title.value} v${w.service.majorVersion.value}`
          : w.sourceUri?.fsPath ?? 'Loading ...',
        vscode.TreeItemCollapsibleState.None,
      );

      item.description = `${w.workspace.name} • ${relative(
        w.workspace.uri.fsPath,
        w.sourceUri?.fsPath ?? '',
      )}`;

      if (!w.service || w.status === 'running') {
        item.iconPath = new vscode.ThemeIcon('sync~spin');
      } else if (w.status === 'error') {
        item.iconPath = new vscode.ThemeIcon('error');
      } else if (w.status === 'violations') {
        item.iconPath = new vscode.ThemeIcon('warning');
      }

      item.command = {
        command: PREVIEW_SERIVCE_COMMAND,
        title: 'Preview Service',
        arguments: [w],
      };

      return item;
    });
  }

  getParent?(element: vscode.TreeItem) {
    return undefined;
  }

  resolveTreeItem?(
    item: vscode.TreeItem,
    element: vscode.TreeItem,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.TreeItem> {
    throw new Error('Method not implemented.');
  }
}
