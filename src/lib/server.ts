import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import process from 'node:process';
import { ChromaClient } from 'chromadb';
import type { ServerInfo } from '../types/index.js';
import { ServerError } from './errors.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ServerManagerConfig {
  /** Directory containing .chromactl/ */
  projectRoot: string;
  /** Absolute path to chroma-data directory */
  persistPath: string;
  /** Default: 8100 */
  port: number;
  /** Default: "localhost" */
  host: string;
  /** Default: 30000 */
  startupTimeoutMs?: number;
  /** Default: 10000 */
  shutdownTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the chromadb CLI binary (dist/cli.mjs).
 * Throws a clear ServerError if the binary cannot be found.
 */
function resolveChromaBinary(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('chromadb/package.json');
    const cliBinary = path.join(path.dirname(pkgPath), 'dist', 'cli.mjs');

    // Verify the file actually exists (synchronous check is fine at startup)
    try {
      const stat = require('node:fs').statSync(cliBinary);
      if (!stat.isFile()) {
        throw new Error('not a file');
      }
    } catch {
      throw new ServerError(
        `ChromaDB CLI binary not found at: ${cliBinary}`,
        'Ensure you have a compatible version of the chromadb package installed (v3.4.3+). ' +
          'Run: npm install chromadb@latest',
      );
    }

    return cliBinary;
  } catch (err) {
    if (err instanceof ServerError) throw err;
    throw new ServerError(
      'Could not resolve the chromadb package. Is it installed?',
      'Run: npm install chromadb',
    );
  }
}

/**
 * Check if a process with the given PID is alive.
 * Uses signal 0 (existence check only).
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permissions to signal it
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Check if a TCP port is available for binding.
 */
function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/**
 * Perform a raw HTTP health check against the ChromaDB heartbeat endpoint.
 * Returns true if the server responds with an OK status.
 */
async function healthCheck(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/api/v2/heartbeat`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Create a ChromaClient connected to the given host and port.
 */
function createClient(host: string, port: number): ChromaClient {
  return new ChromaClient({
    path: `http://${host}:${port}`,
  });
}

/**
 * Wait for a short duration. Used for polling loops.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// ServerManager
// ---------------------------------------------------------------------------

export class ServerManager {
  private readonly pidDir: string;
  private readonly pidFile: string;
  private readonly logFile: string;
  private readonly config: ServerManagerConfig;

  constructor(config: ServerManagerConfig) {
    this.config = config;
    this.pidDir = path.join(config.projectRoot, '.chromactl');
    this.pidFile = path.join(this.pidDir, 'server.json');
    this.logFile = path.join(this.pidDir, 'server.log');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Ensure a server is running and return a connected ChromaClient.
   * If a server is already running (verified via PID + heartbeat), reuse it.
   * Otherwise, start a new one.
   */
  async ensureRunning(): Promise<ChromaClient> {
    const existing = await this.getRunningServer();
    if (existing) {
      return createClient(existing.host, existing.port);
    }
    return this.start();
  }

  /**
   * Start a new server. Throws if port is in use.
   * Writes PID file, unrefs the process so CLI can exit.
   * Returns a connected ChromaClient.
   */
  async start(): Promise<ChromaClient> {
    const { persistPath, port, host } = this.config;

    // Validate port availability
    const free = await isPortFree(port, host);
    if (!free) {
      const alive = await healthCheck(host, port);
      if (alive) {
        throw new ServerError(
          `A ChromaDB server is already running on ${host}:${port} (not managed by chromactl).`,
          'Stop the other server or configure a different port in chromactl.json.',
        );
      }
      throw new ServerError(
        `Port ${port} on ${host} is in use by another process.`,
        'Configure a different port in chromactl.json.',
      );
    }

    // Ensure the persist and PID directories exist
    await fs.mkdir(persistPath, { recursive: true });
    await fs.mkdir(this.pidDir, { recursive: true });

    // Resolve the CLI binary
    const cliBinary = resolveChromaBinary();

    // Open a log file for server stdout/stderr
    const fsSync = await import('node:fs');
    const logFd = fsSync.openSync(this.logFile, 'a');

    // Spawn the server process
    const proc = spawn(
      process.execPath,
      [cliBinary, 'run', '--path', persistPath, '--port', String(port), '--host', host],
      {
        stdio: ['ignore', logFd, logFd],
        detached: true,
        env: {
          ...process.env,
          CHROMADB_VERSION: '999.999.999',
        },
      },
    );

    // Close the log file descriptor in the parent process
    // (the child process has its own copy)
    fsSync.closeSync(logFd);

    if (!proc.pid) {
      throw new ServerError(
        'Failed to spawn ChromaDB server process.',
        'Check that Node.js can execute the chromadb CLI binary.',
      );
    }

    // Detect early exit
    let earlyExitError: Error | null = null;
    const exitListener = (code: number | null, signal: string | null): void => {
      earlyExitError = new ServerError(
        `ChromaDB server exited unexpectedly (code=${code}, signal=${signal}).`,
        `Check the server log at ${this.logFile} for details.`,
      );
    };
    proc.on('exit', exitListener);

    // Wait for readiness with exponential backoff
    const client = createClient(host, port);
    const startupTimeout = this.config.startupTimeoutMs ?? 30_000;

    try {
      await this.pollUntilReady(client, startupTimeout, () => earlyExitError);
    } catch (err) {
      // If the server exited early, throw that error instead
      if (earlyExitError) {
        throw earlyExitError;
      }
      throw err;
    }

    // Write PID file
    const info: ServerInfo = {
      pid: proc.pid,
      port,
      host,
      startedAt: new Date().toISOString(),
      persistPath,
    };
    await this.writeInfo(info);

    // Detach: let the CLI exit while the server keeps running
    proc.removeListener('exit', exitListener);
    proc.unref();

    return client;
  }

  /**
   * Stop the managed server.
   * Sends SIGTERM, waits up to shutdownTimeoutMs, then SIGKILL.
   * Deletes the PID file.
   * Returns true if a server was stopped, false if none was running.
   */
  async stop(): Promise<boolean> {
    const info = await this.readInfo();
    if (!info) {
      return false;
    }

    if (isProcessAlive(info.pid)) {
      // Send SIGTERM for graceful shutdown
      try {
        process.kill(info.pid, 'SIGTERM');
      } catch {
        // Process may have already exited
      }

      // Wait for the process to exit
      const deadline = Date.now() + (this.config.shutdownTimeoutMs ?? 10_000);
      while (Date.now() < deadline && isProcessAlive(info.pid)) {
        await sleep(200);
      }

      // Force kill if still alive
      if (isProcessAlive(info.pid)) {
        try {
          process.kill(info.pid, 'SIGKILL');
        } catch {
          // Process may have already exited
        }
        // Brief wait for SIGKILL to take effect
        await sleep(200);
      }
    }

    await this.deleteInfo();
    return true;
  }

  /**
   * Get info about the currently running server, or null if none.
   * Performs three-tier validation:
   *   1. PID file exists
   *   2. Process is alive (signal 0)
   *   3. Heartbeat responds on the recorded port
   * Cleans up stale PID files automatically.
   */
  async getRunningServer(): Promise<ServerInfo | null> {
    // Tier 1: PID file check
    const info = await this.readInfo();
    if (!info) {
      return null;
    }

    // Tier 2: Process alive check
    if (!isProcessAlive(info.pid)) {
      // Stale PID file -- process no longer exists
      await this.deleteInfo();
      return null;
    }

    // Tier 3: Heartbeat check -- verify it's actually a ChromaDB server
    // on the expected port (guards against PID reuse by another process)
    const alive = await healthCheck(info.host, info.port);
    if (!alive) {
      // Process exists but is not responding as a ChromaDB server
      // This is likely a PID collision -- clean up the stale file
      await this.deleteInfo();
      return null;
    }

    // Verify port matches config (tier 3 extension)
    if (info.port !== this.config.port) {
      // Server is running but on a different port than configured
      // This can happen if the config was changed after the server started
      // We still return the info so callers can decide what to do
    }

    return info;
  }

  /**
   * Get the current server status.
   */
  async status(): Promise<{ running: boolean; info: ServerInfo | null }> {
    const info = await this.getRunningServer();
    return {
      running: info !== null,
      info,
    };
  }

  /**
   * Return a connected ChromaClient for the currently running server.
   * Throws if no server is running.
   */
  async getClient(): Promise<ChromaClient> {
    const info = await this.getRunningServer();
    if (!info) {
      throw new ServerError(
        'No ChromaDB server is running.',
        "Run 'chromactl server start' to start the server.",
      );
    }
    return createClient(info.host, info.port);
  }

  // -------------------------------------------------------------------------
  // Private methods
  // -------------------------------------------------------------------------

  /**
   * Poll the ChromaDB heartbeat endpoint with exponential backoff
   * until the server is ready or timeout is reached.
   *
   * @param client - ChromaClient to use for heartbeat checks
   * @param timeoutMs - Maximum time to wait for readiness
   * @param getEarlyError - Optional callback that returns an error if the
   *   server process exited before becoming ready
   */
  private async pollUntilReady(
    client: ChromaClient,
    timeoutMs: number,
    getEarlyError?: () => Error | null,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let delay = 100; // Start at 100ms
    const maxDelay = 2000; // Cap at 2s
    const backoffFactor = 1.5;
    let attempts = 0;
    const maxAttempts = 30;

    while (Date.now() < deadline && attempts < maxAttempts) {
      // Check for early server exit
      if (getEarlyError) {
        const earlyError = getEarlyError();
        if (earlyError) {
          throw earlyError;
        }
      }

      try {
        await client.heartbeat();
        return; // Server is ready
      } catch {
        // Server not ready yet -- wait and retry
        attempts++;
        await sleep(delay);
        delay = Math.min(delay * backoffFactor, maxDelay);
      }
    }

    throw new ServerError(
      `ChromaDB server did not become ready within ${timeoutMs}ms (${attempts} attempts).`,
      `Check the server log at ${this.logFile} for errors.`,
    );
  }

  /**
   * Write server info (PID file) to disk.
   */
  private async writeInfo(info: ServerInfo): Promise<void> {
    await fs.mkdir(this.pidDir, { recursive: true });
    // Write atomically: write to temp file, then rename
    const tmpFile = this.pidFile + '.tmp';
    await fs.writeFile(tmpFile, JSON.stringify(info, null, 2) + '\n', 'utf-8');
    await fs.rename(tmpFile, this.pidFile);
  }

  /**
   * Read server info (PID file) from disk.
   * Returns null if the file does not exist or is unreadable.
   */
  private async readInfo(): Promise<ServerInfo | null> {
    try {
      const content = await fs.readFile(this.pidFile, 'utf-8');
      return JSON.parse(content) as ServerInfo;
    } catch {
      return null;
    }
  }

  /**
   * Delete the server info (PID file) from disk.
   */
  private async deleteInfo(): Promise<void> {
    try {
      await fs.unlink(this.pidFile);
    } catch {
      // File already deleted or does not exist -- ignore
    }
  }
}
