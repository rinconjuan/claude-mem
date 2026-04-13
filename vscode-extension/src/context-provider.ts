/**
 * ContextProvider — injects claude-mem context into GitHub Copilot.
 *
 * Strategy (best-effort, in order of preference):
 *
 * 1. Write/update `.github/copilot-instructions.md` — Copilot reads this file
 *    automatically and prepends it to every chat conversation in the workspace.
 *    This is the most reliable injection method without requiring a Copilot API.
 *
 * 2. Optionally also write `.vscode/copilot-context.md` for reference/fallback.
 *
 * The file is regenerated at session start and optionally on a timer so that
 * the context stays fresh across long working sessions.
 *
 * Note on direct chat injection: VS Code's vscode.chat API allows registering a
 * ChatParticipant (@claude-mem) that can respond directly. The participant is
 * registered here so users can type `@claude-mem search <query>` in Copilot Chat.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WorkerClient } from './worker-client';
import { SessionManager } from './session-manager';

const CONTEXT_HEADER = `<!-- claude-mem: auto-generated context — do not edit manually -->\n`;
const CONTEXT_FOOTER = `\n<!-- /claude-mem -->\n`;

/** Sentinel markers used to update only our section if the file already exists */
const SECTION_START = '<!-- claude-mem:start -->';
const SECTION_END = '<!-- claude-mem:end -->';

export class ContextProvider {
  private chatParticipant: vscode.ChatParticipant | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly client: WorkerClient,
    private readonly sessionManager: SessionManager,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Fetch context from the Worker and write it to the Copilot instructions file.
   * Call this at session start and when the user runs "Refresh Copilot Context".
   */
  async refreshContextFile(): Promise<void> {
    const config = vscode.workspace.getConfiguration('claude-mem');
    if (!config.get<boolean>('autoUpdateContextFile', true)) {
      return;
    }

    const project = this.sessionManager.getProject();
    const context = await this.client.getContextInject(project);
    if (!context) {
      return;
    }

    const location = config.get<string>('contextFileLocation', '.github/copilot-instructions.md');
    const cwd = this.sessionManager.workspaceCwd();

    if (location === '.github/copilot-instructions.md' || location === 'both') {
      await this.writeContextSection(
        path.join(cwd, '.github', 'copilot-instructions.md'),
        context,
      );
    }
    if (location === '.vscode/copilot-context.md' || location === 'both') {
      await this.writeContextSection(
        path.join(cwd, '.vscode', 'copilot-context.md'),
        context,
      );
    }
  }

  /**
   * Register a @claude-mem chat participant that lets users search their
   * memory directly from Copilot Chat.
   */
  registerChatParticipant(context: vscode.ExtensionContext): void {
    if (!vscode.chat?.createChatParticipant) {
      // Chat API not available in this VS Code version
      return;
    }

    this.chatParticipant = vscode.chat.createChatParticipant(
      'claude-mem.assistant',
      this.handleChatRequest.bind(this),
    );

    this.chatParticipant.iconPath = new vscode.ThemeIcon('database');
    context.subscriptions.push(this.chatParticipant);
  }

  /**
   * Start a periodic refresh timer so the context file stays current.
   * @param intervalMs refresh interval in milliseconds (default: 5 minutes)
   */
  startAutoRefresh(intervalMs: number = 5 * 60 * 1000): void {
    this.stopAutoRefresh();
    this.refreshTimer = setInterval(() => {
      this.refreshContextFile().catch(() => {
        // ignore errors — non-critical background refresh
      });
    }, intervalMs);
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  dispose(): void {
    this.stopAutoRefresh();
  }

  // ---------------------------------------------------------------------------
  // Chat participant handler
  // ---------------------------------------------------------------------------

  private async handleChatRequest(
    request: vscode.ChatRequest,
    _chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> {
    if (token.isCancellationRequested) {
      return {};
    }

    const query = request.prompt.trim();
    if (!query) {
      stream.markdown(
        'Ask me anything about your project history. Example: `@claude-mem what did I build last week?`',
      );
      return {};
    }

    stream.progress('Searching memory...');

    try {
      // Use the search API endpoint
      const params = new URLSearchParams({
        q: query,
        project: this.sessionManager.getProject(),
        limit: '10',
      });

      // Make a direct HTTP call via workerClient's internal request helper
      // by fetching via the REST search endpoint
      const searchUrl = `/api/search?${params}`;
      const workerPort = vscode.workspace
        .getConfiguration('claude-mem')
        .get<number>('workerPort', 37777);
      const rawUrl = `http://127.0.0.1:${workerPort}${searchUrl}`;

      const response = await fetch(rawUrl);
      if (!response.ok) {
        stream.markdown('Could not connect to the claude-mem worker. Is it running?');
        return {};
      }

      const data = (await response.json()) as { results?: unknown[]; context?: string };

      if (data.context) {
        stream.markdown(data.context);
      } else if (data.results && data.results.length > 0) {
        stream.markdown(JSON.stringify(data.results, null, 2));
      } else {
        stream.markdown(`No results found for: **${query}**`);
      }
    } catch {
      stream.markdown('Error querying claude-mem. Make sure the worker is running.');
    }

    return {};
  }

  // ---------------------------------------------------------------------------
  // File writing helpers
  // ---------------------------------------------------------------------------

  private async writeContextSection(filePath: string, context: string): Promise<void> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const newSection =
      `${SECTION_START}\n` +
      CONTEXT_HEADER +
      context.trim() +
      CONTEXT_FOOTER +
      `${SECTION_END}`;

    if (fs.existsSync(filePath)) {
      let existing = fs.readFileSync(filePath, 'utf-8');

      const startIdx = existing.indexOf(SECTION_START);
      const endIdx = existing.indexOf(SECTION_END);

      if (startIdx !== -1 && endIdx !== -1) {
        // Replace existing section
        existing =
          existing.slice(0, startIdx) +
          newSection +
          existing.slice(endIdx + SECTION_END.length);
      } else {
        // Append new section (preserve any existing human-written content)
        existing = existing.trimEnd() + '\n\n' + newSection + '\n';
      }

      fs.writeFileSync(filePath, existing, 'utf-8');
    } else {
      // Create new file with just our section
      fs.writeFileSync(filePath, newSection + '\n', 'utf-8');
    }
  }
}
