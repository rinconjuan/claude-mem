/**
 * extension.ts — Entry point for the claude-mem VS Code extension.
 *
 * Lifecycle:
 *   activate()   → called by VS Code when the extension starts
 *   deactivate() → called on extension unload / window close
 *
 * On activation:
 *   1. Read configuration (worker port, etc.)
 *   2. Spin up WorkerClient, StatusBar, SessionManager, CopilotListener, ContextProvider
 *   3. Check worker readiness and update the status bar
 *   4. Init the session and refresh the Copilot context file
 *   5. Register all VS Code commands
 *   6. Start a periodic health-check loop
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import { WorkerClient } from './worker-client';
import { SessionManager } from './session-manager';
import { StatusBar } from './status-bar';
import { CopilotListener } from './copilot-listener';
import { ContextProvider } from './context-provider';

// ---------------------------------------------------------------------------
// Module-level singletons (cleaned up in deactivate)
// ---------------------------------------------------------------------------

let workerClient: WorkerClient;
let sessionManager: SessionManager;
let statusBar: StatusBar;
let copilotListener: CopilotListener;
let contextProvider: ContextProvider;
let healthCheckTimer: NodeJS.Timeout | undefined;

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('claude-mem');
  const port = config.get<number>('workerPort', 37777);

  // Core services
  workerClient = new WorkerClient(port);
  statusBar = new StatusBar();
  sessionManager = new SessionManager(context, workerClient);
  copilotListener = new CopilotListener(sessionManager, statusBar);
  contextProvider = new ContextProvider(workerClient, sessionManager);

  // Register commands first so they are available even if the worker is down
  registerCommands(context);

  // Register event listeners
  copilotListener.register(context);

  // Register @claude-mem chat participant
  contextProvider.registerChatParticipant(context);

  // Push status bar into subscriptions so VS Code disposes it
  context.subscriptions.push({ dispose: () => statusBar.dispose() });
  context.subscriptions.push({ dispose: () => contextProvider.dispose() });

  // Initial worker check + session init (non-blocking)
  await startUp(config);

  // Periodic health check
  healthCheckTimer = setInterval(
    () => checkWorkerHealth(),
    30_000,
  );

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claude-mem.workerPort')) {
        vscode.window.showInformationMessage(
          'claude-mem: Worker port changed — please reload the window to apply.',
        );
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// deactivate
// ---------------------------------------------------------------------------

export async function deactivate(): Promise<void> {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
  }
  copilotListener?.dispose();
  contextProvider?.dispose();

  // Summarize the current session before the window closes
  await sessionManager?.summarize('[vscode session end]').catch(() => {
    // best-effort
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function startUp(config: vscode.WorkspaceConfiguration): Promise<void> {
  const ready = await workerClient.isReady();

  if (ready) {
    statusBar.setState('connected');
    await sessionManager.initSession();
    contextProvider.startAutoRefresh();
    await contextProvider.refreshContextFile().catch(() => {
      // non-critical — worker may be mid-initialization
    });
  } else {
    statusBar.setState('disconnected');

    const autoStart = config.get<boolean>('autoStartWorker', false);
    if (autoStart) {
      await tryAutoStartWorker();
    } else {
      const choice = await vscode.window.showWarningMessage(
        'claude-mem worker is not running. Memory capture is disabled.',
        'Start Worker',
        'Dismiss',
      );
      if (choice === 'Start Worker') {
        await tryAutoStartWorker();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function checkWorkerHealth(): Promise<void> {
  const ready = await workerClient.isReady();
  if (ready && statusBar.getState() === 'disconnected') {
    statusBar.setState('connected');
    // Re-init session now that the worker is back
    await sessionManager.initSession().catch(() => undefined);
    await contextProvider.refreshContextFile().catch(() => undefined);
  } else if (!ready && statusBar.getState() === 'connected') {
    statusBar.setState('disconnected');
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function registerCommands(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration('claude-mem');
  const port = () => cfg().get<number>('workerPort', 37777);

  context.subscriptions.push(
    // Open memory viewer in the default browser
    vscode.commands.registerCommand('claude-mem.openViewer', () => {
      vscode.env.openExternal(
        vscode.Uri.parse(`http://localhost:${port()}`),
      );
    }),

    // Start the worker via `npx claude-mem worker:start`
    vscode.commands.registerCommand('claude-mem.startWorker', async () => {
      await tryAutoStartWorker();
    }),

    // Stop the worker
    vscode.commands.registerCommand('claude-mem.stopWorker', async () => {
      await workerClient.shutdown();
      statusBar.setState('disconnected');
      vscode.window.showInformationMessage('claude-mem: Worker stopped.');
    }),

    // Restart the worker
    vscode.commands.registerCommand('claude-mem.restartWorker', async () => {
      statusBar.setState('syncing');
      await workerClient.restart();
      // Give it a moment to come back up
      await new Promise((r) => setTimeout(r, 3000));
      await checkWorkerHealth();
    }),

    // End session and trigger summarization
    vscode.commands.registerCommand('claude-mem.endSession', async () => {
      statusBar.setState('syncing');
      await sessionManager.summarize('[manual session end]');
      sessionManager.rotateSession();
      await sessionManager.initSession();
      statusBar.setState('connected');
      vscode.window.showInformationMessage('claude-mem: Session summarized and rotated.');
    }),

    // Show current status
    vscode.commands.registerCommand('claude-mem.showStatus', async () => {
      const health = await workerClient.getHealth();
      if (health) {
        const msg = [
          `**claude-mem Worker**`,
          `Version: ${health.version}`,
          `PID: ${health.pid}`,
          `Initialized: ${health.initialized}`,
          `MCP Ready: ${health.mcpReady}`,
          `Session: ${sessionManager.getSessionId().slice(0, 8)}…`,
          `Project: ${sessionManager.getProject()}`,
        ].join('\n');
        vscode.window.showInformationMessage(msg);
      } else {
        vscode.window.showWarningMessage('claude-mem: Worker is not responding.');
      }
    }),

    // Refresh the Copilot instructions context file
    vscode.commands.registerCommand('claude-mem.refreshContext', async () => {
      statusBar.setState('syncing');
      await contextProvider.refreshContextFile().catch(() => {
        vscode.window.showErrorMessage(
          'claude-mem: Could not refresh context — is the worker running?',
        );
      });
      statusBar.setState(
        (await workerClient.isReady()) ? 'connected' : 'disconnected',
      );
      vscode.window.showInformationMessage('claude-mem: Copilot context file updated.');
    }),

    // Configure .vscode/mcp.json with claude-mem MCP tools
    vscode.commands.registerCommand('claude-mem.configureMcp', async () => {
      await writeMcpConfig(port());
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to start the worker using the globally installed claude-mem CLI.
 */
async function tryAutoStartWorker(): Promise<void> {
  return new Promise((resolve) => {
    const cfg = vscode.workspace.getConfiguration('claude-mem');
    const customCmd = cfg.get<string>('workerStartCommand', '').trim();
    const defaultCmd = process.platform === 'win32'
      ? 'npx.cmd claude-mem worker:start'
      : 'npx claude-mem worker:start';
    const cmd = customCmd || defaultCmd;

    cp.exec(cmd, { timeout: 15_000 }, async (err) => {
      if (err) {
        vscode.window.showErrorMessage(
          'claude-mem: Could not start worker. ' +
          'Make sure claude-mem is installed globally (npm i -g claude-mem) ' +
          'and try "claude-mem: Start Worker" from the command palette.',
        );
        resolve();
        return;
      }

      // Wait for readiness
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await workerClient.isReady()) {
          statusBar.setState('connected');
          await sessionManager.initSession();
          await contextProvider.refreshContextFile().catch(() => undefined);
          vscode.window.showInformationMessage('claude-mem: Worker started successfully.');
          resolve();
          return;
        }
      }

      vscode.window.showWarningMessage(
        'claude-mem: Worker started but is not yet responding. ' +
        'It may still be initializing — check the status bar.',
      );
      resolve();
    });
  });
}

/**
 * Write/update `.vscode/mcp.json` with claude-mem MCP server config.
 */
async function writeMcpConfig(port: number): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('claude-mem: No workspace folder open.');
    return;
  }

  const vscodePath = vscode.Uri.joinPath(folders[0].uri, '.vscode');
  const mcpPath = vscode.Uri.joinPath(vscodePath, 'mcp.json');

  let existing: { servers?: Record<string, unknown> } = {};
  try {
    const raw = await vscode.workspace.fs.readFile(mcpPath);
    existing = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    // File doesn't exist yet — start fresh
  }

  existing.servers = existing.servers ?? {};
  existing.servers['claude-mem'] = {
    type: 'http',
    url: `http://127.0.0.1:${port}/mcp`,
  };

  const content = new TextEncoder().encode(JSON.stringify(existing, null, 2) + '\n');

  try {
    await vscode.workspace.fs.createDirectory(vscodePath);
  } catch {
    // directory may already exist
  }

  await vscode.workspace.fs.writeFile(mcpPath, content);
  vscode.window.showInformationMessage(
    'claude-mem: MCP tools configured in .vscode/mcp.json',
  );

  // Open the file so the user can see what was written
  const doc = await vscode.workspace.openTextDocument(mcpPath);
  await vscode.window.showTextDocument(doc);
}
