/**
 * WorkerClient — HTTP client for the claude-mem Worker API (port 37777)
 *
 * All calls are fire-and-forget safe: if the worker is not running,
 * errors are swallowed so they never interrupt the developer's workflow.
 */

import * as http from 'http';
import * as https from 'https';

export interface WorkerHealth {
  status: string;
  version: string;
  initialized: boolean;
  mcpReady: boolean;
  pid: number;
}

export interface SessionInitBody {
  contentSessionId: string;
  project: string;
  prompt: string;
  platformSource: string;
  customTitle?: string;
}

export interface ObservationBody {
  contentSessionId: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  cwd: string;
  platformSource: string;
}

export interface SummarizeBody {
  contentSessionId: string;
  last_assistant_message: string;
  platformSource: string;
}

export interface ContextInjectResponse {
  context: string;
  tokenCount?: number;
}

export class WorkerClient {
  private readonly baseUrl: string;

  constructor(port: number = 37777) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  // ---------------------------------------------------------------------------
  // Health / Readiness
  // ---------------------------------------------------------------------------

  async isReady(): Promise<boolean> {
    try {
      const res = await this.get<{ status: string }>('/api/readiness');
      return res.status === 'ready';
    } catch {
      return false;
    }
  }

  async getHealth(): Promise<WorkerHealth | null> {
    try {
      return await this.get<WorkerHealth>('/api/health');
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  /** POST /api/sessions/init — idempotent session creation */
  async initSession(body: SessionInitBody): Promise<void> {
    try {
      await this.post('/api/sessions/init', body);
    } catch {
      // fire-and-forget: never break the developer's flow
    }
  }

  /** POST /api/sessions/observations — queue an observation */
  async saveObservation(body: ObservationBody): Promise<void> {
    try {
      await this.post('/api/sessions/observations', body);
    } catch {
      // fire-and-forget
    }
  }

  /** POST /api/sessions/summarize — request AI summary for the session */
  async summarizeSession(body: SummarizeBody): Promise<void> {
    try {
      await this.post('/api/sessions/summarize', body);
    } catch {
      // fire-and-forget
    }
  }

  // ---------------------------------------------------------------------------
  // Context injection
  // ---------------------------------------------------------------------------

  /** GET /api/context/inject — fetch formatted context for Copilot instructions */
  async getContextInject(project: string, maxTokens: number = 4000): Promise<string | null> {
    try {
      const params = new URLSearchParams({ project, maxTokens: String(maxTokens) });
      const res = await this.get<ContextInjectResponse>(`/api/context/inject?${params}`);
      return res.context ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    try {
      await this.post('/api/admin/shutdown', {});
    } catch {
      // expected: worker shuts down before it can respond
    }
  }

  async restart(): Promise<void> {
    try {
      await this.post('/api/admin/restart', {});
    } catch {
      // expected
    }
  }

  // ---------------------------------------------------------------------------
  // Internal HTTP helpers
  // ---------------------------------------------------------------------------

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path, undefined);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private request<T>(method: string, path: string, body: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const url = new URL(path, this.baseUrl);
      const isHttps = url.protocol === 'https:';
      // url.port is a string; fall back to the protocol default only when empty
      const port = url.port ? Number(url.port) : (isHttps ? 443 : 80);
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port,
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      };

      const lib = isHttps ? https : http;
      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            resolve(data as unknown as T);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy(new Error('Request timeout'));
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }
}
