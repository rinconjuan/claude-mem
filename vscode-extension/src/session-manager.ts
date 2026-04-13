/**
 * SessionManager — manages the lifecycle of a claude-mem session per workspace.
 *
 * Responsibilities:
 * - Generate a stable contentSessionId (UUID) per VS Code workspace
 * - Track current project name from the workspace root
 * - Persist the active session ID in ExtensionContext.workspaceState so it
 *   survives hot reloads but resets when the window is closed
 * - Expose helpers to init, observe, and summarize
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { WorkerClient } from './worker-client';

const PLATFORM_SOURCE = 'vscode';

export class SessionManager {
  private sessionId: string;
  private project: string;
  private readonly client: WorkerClient;
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext, client: WorkerClient) {
    this.client = client;
    this.context = context;

    this.project = this.detectProject();

    // Reuse session ID across hot reloads within the same window
    const stored = context.workspaceState.get<string>('claudeMemSessionId');
    this.sessionId = stored ?? this.generateSessionId();
    context.workspaceState.update('claudeMemSessionId', this.sessionId);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getSessionId(): string {
    return this.sessionId;
  }

  getProject(): string {
    return this.project;
  }

  /** Call once when the extension starts (or when a new Copilot chat begins). */
  async initSession(prompt: string = '[vscode session start]', customTitle?: string): Promise<void> {
    await this.client.initSession({
      contentSessionId: this.sessionId,
      project: this.project,
      prompt,
      platformSource: PLATFORM_SOURCE,
      customTitle,
    });
  }

  /** Record a single tool-use / file-edit / command observation. */
  async observe(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: Record<string, unknown>,
    cwd?: string,
  ): Promise<void> {
    await this.client.saveObservation({
      contentSessionId: this.sessionId,
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      cwd: cwd ?? this.workspaceCwd(),
      platformSource: PLATFORM_SOURCE,
    });
  }

  /** Request an AI summary for the current session (call at session end). */
  async summarize(lastAssistantMessage: string = ''): Promise<void> {
    await this.client.summarizeSession({
      contentSessionId: this.sessionId,
      last_assistant_message: lastAssistantMessage,
      platformSource: PLATFORM_SOURCE,
    });
  }

  /**
   * Rotate session ID — creates a fresh session while preserving the project.
   * Call this when the user explicitly starts a new Copilot conversation.
   */
  rotateSession(): void {
    this.sessionId = this.generateSessionId();
    this.context.workspaceState.update('claudeMemSessionId', this.sessionId);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private generateSessionId(): string {
    return crypto.randomUUID();
  }

  private detectProject(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return path.basename(folders[0].uri.fsPath);
    }
    return 'unknown';
  }

  workspaceCwd(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    return process.cwd();
  }
}
