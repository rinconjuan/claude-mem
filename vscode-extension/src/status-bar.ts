/**
 * StatusBar — shows the claude-mem worker connection state in the VS Code status bar.
 *
 * States:
 *   connected    $(database) claude-mem  [green]
 *   syncing      $(sync~spin) claude-mem [yellow]
 *   disconnected $(database) claude-mem  [red]
 *
 * Clicking opens the Memory Viewer at http://localhost:37777.
 */

import * as vscode from 'vscode';

export type WorkerState = 'connected' | 'syncing' | 'disconnected';

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private currentState: WorkerState = 'disconnected';

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = 'claude-mem.openViewer';
    this.item.tooltip = 'claude-mem — click to open Memory Viewer';
    this.setState('disconnected');
    this.item.show();
  }

  setState(state: WorkerState): void {
    this.currentState = state;
    switch (state) {
      case 'connected':
        this.item.text = '$(database) claude-mem';
        this.item.backgroundColor = undefined;
        this.item.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
        break;
      case 'syncing':
        this.item.text = '$(sync~spin) claude-mem';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.item.color = undefined;
        break;
      case 'disconnected':
        this.item.text = '$(database) claude-mem';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.item.color = undefined;
        break;
    }
  }

  getState(): WorkerState {
    return this.currentState;
  }

  dispose(): void {
    this.item.dispose();
  }
}
