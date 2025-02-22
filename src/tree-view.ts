import * as vscode from 'vscode';

import {
  ServiceExplorerDataProvider,
  ServiceNode,
} from './service-explorer-data-provider';
import { Worker } from './worker';
import { SERVICE_TREE_ID, WORKERS_TREE_ID } from './constants';
import { WorkersDataProvider } from './workers-data-provider';

let serviceTreeView: vscode.TreeView<ServiceNode> | undefined;

export function initTreeView() {
  serviceTreeView = vscode.window.createTreeView('basketryService', {
    showCollapseAll: false,
    treeDataProvider: new ServiceExplorerDataProvider(),
  });

  Worker.onWorkerAdded(() => reloadWorkersView());
  Worker.onWorkerRemoved(() => reloadWorkersView());
  Worker.onServiceChanged(() => reloadWorkersView());

  reloadWorkersView();
}

export async function reloadWorkersView() {
  vscode.window.createTreeView(WORKERS_TREE_ID, {
    showCollapseAll: true,
    treeDataProvider: new WorkersDataProvider(),
  });
}

export async function reloadServiceView(worker: Worker) {
  if (serviceTreeView) {
    serviceTreeView.description = undefined;
    serviceTreeView.message = ' ';
    serviceTreeView = vscode.window.createTreeView(SERVICE_TREE_ID, {
      showCollapseAll: true,
      treeDataProvider: new ServiceExplorerDataProvider({
        worker,
        onInit: ({ service }) => {
          if (serviceTreeView) {
            if (service) {
              serviceTreeView.description = `${service.title.value} v${service.majorVersion.value}`;
            } else {
              serviceTreeView.description = undefined;
            }
            serviceTreeView.message = undefined;
          }
        },
      }),
    });
  }
}
