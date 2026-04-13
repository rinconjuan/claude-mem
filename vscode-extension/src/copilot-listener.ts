/**
 * CopilotListener — captures VS Code events and forwards them as observations
 * to the claude-mem Worker.
 *
 * Captured events (equivalents of the Claude Code / Cursor hooks):
 *
 * | claude-mem hook         | VS Code event                               |
 * |-------------------------|---------------------------------------------|
 * | afterFileEdit           | workspace.onDidSaveTextDocument             |
 * | afterShellExecution     | window.onDidWriteTerminalData               |
 * | beforeSubmitPrompt      | chat participant request handler            |
 * | afterMCPExecution       | lm.invokeTool (wrapper registration)        |
 * | stop                    | explicit endSession command                 |
 *
 * All observations are fire-and-forget; errors are swallowed so they never
 * interrupt the developer's flow.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { SessionManager } from './session-manager';
import { StatusBar } from './status-bar';

/** Maximum characters of terminal data to record per event (avoid huge dumps) */
const MAX_TERMINAL_CHARS = 2000;

/** Debounce interval for terminal data (ms) — aggregate rapid output into one observation */
const TERMINAL_DEBOUNCE_MS = 800;

export class CopilotListener {
  private readonly disposables: vscode.Disposable[] = [];
  /** Accumulated terminal data per terminal, flushed after debounce */
  private readonly terminalBuffers = new Map<string, string>();
  private readonly terminalTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly statusBar: StatusBar,
  ) {}

  // ---------------------------------------------------------------------------
  // Start / Stop
  // ---------------------------------------------------------------------------

  register(context: vscode.ExtensionContext): void {
    const config = vscode.workspace.getConfiguration('claude-mem');

    // File saves
    if (config.get<boolean>('captureFileSaves', true)) {
      this.disposables.push(
        vscode.workspace.onDidSaveTextDocument(this.onFileSave.bind(this)),
      );
    }

    // Terminal output
    if (config.get<boolean>('captureTerminal', true)) {
      this.disposables.push(
        (vscode.window as unknown as {
          onDidWriteTerminalData?: (
            cb: (e: { terminal: vscode.Terminal; data: string }) => void,
          ) => vscode.Disposable;
        }).onDidWriteTerminalData?.(this.onTerminalData.bind(this)) ??
          { dispose: () => undefined },
      );
    }

    // Register our own LM tools that act as observation wrappers
    this.registerLmTools(context);

    // Push all disposables to the extension context
    context.subscriptions.push(...this.disposables);
  }

  dispose(): void {
    // Flush any pending terminal buffers
    for (const [termId, timerId] of this.terminalTimers.entries()) {
      clearTimeout(timerId);
      this.flushTerminalBuffer(termId);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private onFileSave(doc: vscode.TextDocument): void {
    const filePath = doc.uri.fsPath;
    const cwd = this.sessionManager.workspaceCwd();

    // Skip files outside the workspace and our own generated files
    if (!filePath.startsWith(cwd)) {
      return;
    }
    if (
      filePath.includes('copilot-instructions.md') ||
      filePath.includes('copilot-context.md') ||
      filePath.includes('session-memory')
    ) {
      return;
    }

    const config = vscode.workspace.getConfiguration('claude-mem');
    const skipTools = new Set<string>(config.get<string[]>('skipTools', []));
    if (skipTools.has('Write')) {
      return;
    }

    const relativePath = path.relative(cwd, filePath);
    this.statusBar.setState('syncing');

    this.sessionManager
      .observe(
        'Write',
        { file_path: relativePath, language: doc.languageId },
        { saved: true, lines: doc.lineCount },
        cwd,
      )
      .finally(() => {
        if (this.statusBar.getState() === 'syncing') {
          this.statusBar.setState('connected');
        }
      });
  }

  private onTerminalData(e: { terminal: vscode.Terminal; data: string }): void {
    const termId = e.terminal.name || 'terminal';
    const existing = this.terminalBuffers.get(termId) ?? '';
    this.terminalBuffers.set(termId, existing + e.data);

    // Reset debounce timer
    const existing_timer = this.terminalTimers.get(termId);
    if (existing_timer) {
      clearTimeout(existing_timer);
    }
    const timer = setTimeout(() => {
      this.flushTerminalBuffer(termId);
    }, TERMINAL_DEBOUNCE_MS);
    this.terminalTimers.set(termId, timer);
  }

  private flushTerminalBuffer(termId: string): void {
    const data = this.terminalBuffers.get(termId);
    this.terminalBuffers.delete(termId);
    this.terminalTimers.delete(termId);

    if (!data || !data.trim()) {
      return;
    }

    const truncated = data.length > MAX_TERMINAL_CHARS
      ? '…' + data.slice(-MAX_TERMINAL_CHARS)
      : data;

    this.sessionManager
      .observe(
        'Bash',
        { command: termId },
        { output: truncated },
        this.sessionManager.workspaceCwd(),
      )
      .catch(() => {
        // fire-and-forget
      });
  }

  // ---------------------------------------------------------------------------
  // LM Tool registration
  // ---------------------------------------------------------------------------

  /**
   * Register custom LM tools that wrap common Copilot agent tool calls.
   * When Copilot (or any LM tool caller) invokes these, we intercept the
   * call, forward it to the real implementation, and record an observation.
   *
   * Note: These are *additional* tools that AI agents can call.
   * They do NOT intercept built-in Copilot tools — Copilot's own tools
   * are opaque. This gives Copilot explicit tools to log intent.
   */
  private registerLmTools(context: vscode.ExtensionContext): void {
    if (!vscode.lm?.registerTool) {
      return;
    }

    // Tool: claude-mem_record — lets Copilot explicitly record a memory note
    const recordTool = vscode.lm.registerTool<{
      summary: string;
      category?: string;
    }>('claude-mem_record', {
      invoke: async (options, _token) => {
        const { summary, category = 'note' } = options.input;

        await this.sessionManager.observe(
          'MemoryRecord',
          { summary, category },
          { recorded: true },
          this.sessionManager.workspaceCwd(),
        );

        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Memory recorded: "${summary}" (category: ${category})`,
          ),
        ]);
      },
    });

    // Tool: claude-mem_search — lets Copilot search past memories inline
    const searchTool = vscode.lm.registerTool<{
      query: string;
      project?: string;
    }>('claude-mem_search', {
      invoke: async (options, _token) => {
        const { query, project = this.sessionManager.getProject() } = options.input;
        const workerPort = vscode.workspace
          .getConfiguration('claude-mem')
          .get<number>('workerPort', 37777);

        try {
          const params = new URLSearchParams({ q: query, project, limit: '5' });
          const res = await fetch(`http://127.0.0.1:${workerPort}/api/search?${params}`);
          const data = (await res.json()) as { context?: string; results?: unknown[] };
          const text = data.context ?? JSON.stringify(data.results ?? [], null, 2);

          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
          ]);
        } catch {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('claude-mem worker not available'),
          ]);
        }
      },
    });

    context.subscriptions.push(recordTool, searchTool);
  }
}
