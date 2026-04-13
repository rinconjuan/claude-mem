# claude-mem for VS Code

> Persistent memory for GitHub Copilot — captures tool use, file edits, and terminal commands to build a searchable knowledge base across sessions.

## What it does

This extension bridges VS Code / GitHub Copilot with the **claude-mem Worker** (the same backend used by Claude Code). Every session is automatically recorded, compressed by an AI agent, and made available as context in your next Copilot conversation.

```
VS Code events          claude-mem Worker (port 37777)       SQLite + Chroma
──────────────          ──────────────────────────────       ───────────────
File saves          →   POST /api/sessions/observations  →   Stored & indexed
Terminal output     →   POST /api/sessions/observations  →   Stored & indexed
Session start       →   POST /api/sessions/init          →   Session created
Session end         →   POST /api/sessions/summarize     →   AI summary saved
                        GET  /api/context/inject         ←   Context for Copilot
                              ↓
                    .github/copilot-instructions.md      ←   Copilot reads this
```

## Prerequisites

You must have the **claude-mem worker** running. The worker is part of the main `claude-mem` npm package:

```bash
npm install -g claude-mem
claude-mem worker:start
```

Verify it's running:
```bash
curl http://localhost:37777/api/health
```

## Installation

Install from the VS Code Marketplace (search for **"claude-mem"**) or install the `.vsix` manually:

```bash
cd vscode-extension
npm install
npm run package       # produces claude-mem-vscode-x.x.x.vsix
code --install-extension claude-mem-vscode-*.vsix
```

## Features

### 🧠 Automatic context injection
At session start, the extension fetches your recent work history from the worker and writes it to `.github/copilot-instructions.md`. GitHub Copilot reads this file automatically, so it always has context from your previous sessions.

### 📝 File save capture
Every file save is recorded as an observation with the file path and language — so the AI knows which files were touched during a session.

### 💻 Terminal capture
Terminal output is buffered and recorded as `Bash` observations. Useful for capturing test failures, build errors, and commands run.

### 🔍 @claude-mem chat participant
Type `@claude-mem <query>` in Copilot Chat to search your memory directly:

```
@claude-mem what authentication library did I use last month?
@claude-mem show me the database schema changes from last week
```

### 🔧 LM Tools for Copilot Agents
Two tools are registered for Copilot agent mode:

- **`claude-mem_record`** — explicitly record a memory note during a Copilot conversation
- **`claude-mem_search`** — search past memories inline during agent execution

### ⚙️ MCP tool configuration
Run `claude-mem: Configure MCP Tools for this Workspace` to automatically create `.vscode/mcp.json` pointing to the worker's MCP endpoint, giving Copilot access to all claude-mem search tools.

## Commands

| Command | Description |
|---------|-------------|
| `claude-mem: Open Memory Viewer` | Open the web viewer at `http://localhost:37777` |
| `claude-mem: Start Worker` | Start the claude-mem worker via npx |
| `claude-mem: Stop Worker` | Gracefully stop the worker |
| `claude-mem: Restart Worker` | Restart the worker |
| `claude-mem: End Session & Summarize` | Summarize the current session and start a fresh one |
| `claude-mem: Show Status` | Display worker version, PID, and session info |
| `claude-mem: Refresh Copilot Context File` | Re-fetch context and update `.github/copilot-instructions.md` |
| `claude-mem: Configure MCP Tools for this Workspace` | Write `.vscode/mcp.json` |

## Configuration

Open **Settings → Extensions → claude-mem**:

| Setting | Default | Description |
|---------|---------|-------------|
| `claude-mem.workerPort` | `37777` | Port where the worker listens |
| `claude-mem.autoStartWorker` | `false` | Auto-start the worker if not running |
| `claude-mem.captureFileSaves` | `true` | Record file saves as observations |
| `claude-mem.captureTerminal` | `true` | Record terminal output as observations |
| `claude-mem.contextFileLocation` | `.github/copilot-instructions.md` | Where to write injected context |
| `claude-mem.autoUpdateContextFile` | `true` | Refresh context file at session start |
| `claude-mem.skipTools` | `[]` | Tool names to exclude from recording |

## Status bar

The status bar item `$(database) claude-mem` in the bottom-right corner shows the connection state:

- **Green** — connected to the worker, recording
- **Yellow (spinning)** — syncing an observation
- **Red** — worker not responding

Click the item to open the Memory Viewer.

## Architecture

This extension is a thin HTTP adapter over the existing claude-mem Worker. It does **not** modify the Worker — it only calls its REST API:

```
vscode-extension/
├── src/
│   ├── extension.ts        # activate/deactivate, command registration
│   ├── worker-client.ts    # HTTP client for Worker API (port 37777)
│   ├── session-manager.ts  # Session lifecycle per workspace
│   ├── copilot-listener.ts # VS Code event listeners
│   ├── context-provider.ts # Copilot instructions file + @claude-mem participant
│   └── status-bar.ts       # Status bar indicator
```

The Worker backend (SQLite, Chroma, AI summarization) is shared with Claude Code, Cursor, Windsurf, Codex, and all other claude-mem integrations.

## Privacy

The extension only communicates with `http://127.0.0.1:<port>` (your local machine). No data is sent to any external server by the extension itself. See the [claude-mem privacy docs](https://docs.claude-mem.ai) for Worker-level privacy controls, including `<private>` tags.

## License

AGPL-3.0 — same as the claude-mem project.
