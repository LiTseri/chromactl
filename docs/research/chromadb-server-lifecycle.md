# ChromaDB JS Client v3.x Server Lifecycle Management

## Research Summary

This document provides deep technical research on managing a ChromaDB server lifecycle from a Node.js/TypeScript CLI tool. It covers server startup via `child_process.spawn`, health checking, graceful shutdown, port configuration, error handling, PID file management, and architectural patterns (start-per-command vs persistent daemon).

**Target**: ChromaDB npm package `chromadb` v3.4.3+, Node.js >= 20, TypeScript.

---

## 1. Starting a ChromaDB Server from Node.js

### 1.1 The Bundled CLI Binary

The `chromadb` npm package (v3.4.3) ships a CLI binary via the `bin` field in `package.json`:

```json
{
  "bin": { "chroma": "dist/cli.mjs" }
}
```

This `dist/cli.mjs` entry point is a thin wrapper that:

1. Strips `process.argv[0]` and `process.argv[1]` to get user-provided arguments
2. Registers a `SIGINT` handler that calls `process.exit(0)`
3. Calls `binding.cli(["chroma", ...args])` -- delegating to the platform-specific native Rust binary

The native bindings are shipped as optional dependencies (auto-selected per platform):

| Platform       | Architecture | Package                                   | Size   |
| -------------- | ------------ | ----------------------------------------- | ------ |
| macOS          | arm64        | `chromadb-js-bindings-darwin-arm64`        | ~53 MB |
| macOS          | x64          | `chromadb-js-bindings-darwin-x64`          | ~53 MB |
| Linux          | x64          | `chromadb-js-bindings-linux-x64-gnu`       | ~53 MB |
| Linux          | arm64        | `chromadb-js-bindings-linux-arm64-gnu`     | ~53 MB |
| Windows        | arm64        | `chromadb-js-bindings-win32-arm64-msvc`    | ~53 MB |

**Note**: Windows x64 is NOT supported by the native bindings.

### 1.2 CLI Arguments for `chroma run`

The `chroma run` subcommand (implemented in Rust via `clap`) accepts these arguments:

| Argument        | Type             | Default       | Description                                    |
| --------------- | ---------------- | ------------- | ---------------------------------------------- |
| `[config_path]` | Positional (opt) | None          | Path to a YAML config file (conflicts with other flags) |
| `--path`        | `String`         | Server default| Persistence directory for the Chroma database  |
| `--host`        | `String`         | `"localhost"` | Host/IP address to bind the server to           |
| `--port`        | `u16`            | `8000`        | TCP port to listen on                           |

**Conflict rules**: `config_path` (positional) conflicts with `--path`, `--host`, and `--port`. You use either a config file OR individual CLI flags, not both.

### 1.3 Spawning the Server Process

There are two strategies for spawning the server from Node.js:

#### Strategy A: Spawn via `npx chroma run` (not recommended)

```typescript
import { spawn } from 'node:child_process';

const server = spawn('npx', ['chroma', 'run', '--path', './data', '--port', '8100'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
```

**Problem**: `npx` adds startup overhead (resolving the package, checking versions) and may prompt for installation. Not suitable for production use.

#### Strategy B: Spawn the CLI binary directly (recommended)

Resolve the path to the `chroma` binary from the installed `chromadb` package and spawn it directly:

```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

function resolveChromaBinary(): string {
  const require = createRequire(import.meta.url);
  // Resolve the chromadb package.json to find the package root
  const chromadbPkgPath = require.resolve('chromadb/package.json');
  const chromadbRoot = path.dirname(chromadbPkgPath);
  // The bin entry points to dist/cli.mjs
  return path.join(chromadbRoot, 'dist', 'cli.mjs');
}

interface ServerOptions {
  persistPath: string;
  port: number;
  host?: string;
}

function startServer(options: ServerOptions): ChildProcess {
  const cliBinary = resolveChromaBinary();
  const args = [
    cliBinary,
    'run',
    '--path', options.persistPath,
    '--port', String(options.port),
  ];

  if (options.host) {
    args.push('--host', options.host);
  }

  const server = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // detached: true allows the server to outlive the parent if needed
    detached: true,
    env: {
      ...process.env,
      // Prevent the CLI's update check from interfering
      CHROMADB_VERSION: '999.999.999',
    },
  });

  return server;
}
```

**Key details**:

- We use `process.execPath` (the Node.js binary) to run the `.mjs` file directly, avoiding `npx` overhead.
- Setting `CHROMADB_VERSION` to a high value prevents the CLI's built-in version check from printing update notices.
- `detached: true` allows the server process to run independently (important for the daemon pattern).
- `stdio: ['ignore', 'pipe', 'pipe']` lets us capture stdout/stderr for readiness detection and error logging.

### 1.4 Detecting Server Readiness

The server prints a startup message to stdout before blocking on the `tokio` runtime. The key output line is:

```
Connect to Chroma at: http://localhost:{port}
```

However, this message is printed *before* the server actually starts accepting connections (it's printed in `display_run_message()` which runs before `runtime.block_on()`). Therefore, **stdout parsing alone is NOT sufficient for readiness detection**.

The reliable approach is to poll the heartbeat endpoint:

```typescript
import { ChromaClient } from 'chromadb';

async function waitForServer(
  host: string,
  port: number,
  timeoutMs: number = 30_000,
  intervalMs: number = 250,
): Promise<void> {
  const client = new ChromaClient({ host, port });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await client.heartbeat();
      return; // Server is ready
    } catch {
      // Server not ready yet -- wait and retry
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error(
    `ChromaDB server failed to become ready within ${timeoutMs}ms at ${host}:${port}`,
  );
}
```

**Exponential backoff variant** (recommended for production):

```typescript
async function waitForServerWithBackoff(
  host: string,
  port: number,
  options: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  } = {},
): Promise<void> {
  const {
    maxAttempts = 20,
    initialDelayMs = 100,
    maxDelayMs = 3_000,
  } = options;

  const client = new ChromaClient({ host, port });
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.heartbeat();
      return; // Server is ready
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(
          `ChromaDB server at ${host}:${port} not ready after ${maxAttempts} attempts. ` +
          `Last error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, maxDelayMs);
    }
  }
}
```

### 1.5 Complete Server Start-and-Wait Example

```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ChromaClient } from 'chromadb';

interface ManagedServer {
  process: ChildProcess;
  client: ChromaClient;
  pid: number;
  port: number;
}

async function startManagedServer(
  persistPath: string,
  port: number = 8100,
  host: string = 'localhost',
): Promise<ManagedServer> {
  // 1. Resolve the CLI binary
  const require = createRequire(import.meta.url);
  const chromadbPkgPath = require.resolve('chromadb/package.json');
  const cliBinary = path.join(path.dirname(chromadbPkgPath), 'dist', 'cli.mjs');

  // 2. Spawn the server process
  const serverProcess = spawn(
    process.execPath,
    [cliBinary, 'run', '--path', persistPath, '--port', String(port), '--host', host],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, CHROMADB_VERSION: '999.999.999' },
    },
  );

  // 3. Handle early exit (e.g., port conflict detected by the Rust binary)
  const earlyExitPromise = new Promise<never>((_, reject) => {
    let stderr = '';
    serverProcess.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    serverProcess.on('exit', (code, signal) => {
      reject(new Error(
        `ChromaDB server exited prematurely with code=${code} signal=${signal}. ` +
        `stderr: ${stderr.trim()}`,
      ));
    });
  });

  // 4. Wait for the server to become ready
  const client = new ChromaClient({ host, port });
  const readyPromise = (async () => {
    let delay = 100;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await client.heartbeat();
        return; // Ready
      } catch {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, 2000);
      }
    }
    throw new Error(`ChromaDB server not ready after 30 attempts`);
  })();

  // 5. Race: either the server becomes ready or it exits early
  await Promise.race([readyPromise, earlyExitPromise]);

  // 6. Detach stderr listener (no longer needed for early exit detection)
  serverProcess.stderr?.removeAllListeners('data');
  serverProcess.removeAllListeners('exit');

  return {
    process: serverProcess,
    client,
    pid: serverProcess.pid!,
    port,
  };
}
```

---

## 2. Health Check: The Heartbeat Endpoint

### 2.1 REST API Endpoint

The ChromaDB server exposes a heartbeat endpoint at:

```
GET /api/v2/heartbeat
```

**Response**: JSON object with a nanosecond timestamp:

```json
{
  "nanosecond heartbeat": 1719388800000000000
}
```

**Note on API version**: ChromaDB v3.x (server v1.x) uses `/api/v2/` routes. All `/api/v1/*` routes return a deprecation notice. The JS client v3.x uses `/api/v2/heartbeat` in its generated API client.

### 2.2 Using ChromaClient.heartbeat()

The `ChromaClient.heartbeat()` method is the preferred way to check server health:

```typescript
import { ChromaClient } from 'chromadb';

const client = new ChromaClient({ host: 'localhost', port: 8100 });

// Returns the server's nanosecond timestamp
const timestamp: number = await client.heartbeat();
console.log(`Server alive, timestamp: ${timestamp}`);
```

**Key property**: Unlike most other `ChromaClient` methods, `heartbeat()` does NOT call `this.init()` first. This means:
- It does not validate tenant/database configuration
- It can be used purely as a connectivity check without side effects
- It is the fastest way to verify the server is accepting connections

### 2.3 Using Raw HTTP (fetch)

For scenarios where instantiating a `ChromaClient` is not desired (e.g., in a health check script):

```typescript
async function checkServerHealth(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/api/v2/heartbeat`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
```

### 2.4 Error Types on Connection Failure

When the server is not running, `client.heartbeat()` throws a `ChromaConnectionError`:

```
ChromaConnectionError: Failed to connect to chromadb. Make sure your server is running...
```

The `ChromaFetch` wrapper detects offline errors by checking:
- `error.name === "TypeError"` or `error.name === "FetchError"`
- `error.message` includes `"fetch failed"`, `"Failed to fetch"`, or `"ENOTFOUND"`

HTTP status codes 502, 503, and 504 also produce `ChromaConnectionError`.

### 2.5 Other Error Types

The ChromaDB JS client defines the following error classes:

| Error Class               | HTTP Status | Description                                       |
| ------------------------- | ----------- | ------------------------------------------------- |
| `ChromaConnectionError`   | 502/503/504 | Server unreachable or network error                |
| `ChromaClientError`       | 400         | Bad request from client                            |
| `ChromaUnauthorizedError` | 401         | Missing or invalid authentication                  |
| `ChromaForbiddenError`    | 403         | Insufficient permissions                           |
| `ChromaNotFoundError`     | 404         | Resource not found                                 |
| `ChromaUniqueError`       | 409         | Duplicate resource (conflict)                      |
| `ChromaServerError`       | 500         | Internal server error                              |
| `ChromaValueError`        | 500         | Server-side ValueError (parsed from Python-style)  |
| `ChromaQuotaExceededError`| 422         | Quota or billing limit exceeded                    |
| `InvalidCollectionError`  | -           | Invalid collection reference                       |
| `InvalidArgumentError`    | -           | Invalid argument passed to client method           |

---

## 3. Graceful Shutdown via SIGTERM

### 3.1 How the Chroma Server Handles Signals

The Chroma server (Rust/axum-based) implements graceful shutdown using `axum::serve(...).with_graceful_shutdown(graceful_shutdown(system))`.

The `graceful_shutdown` function is platform-aware:

**On Unix (Linux/macOS)**:
- Listens for both `SIGTERM` and `SIGINT` using `tokio::signal::unix::signal(SignalKind::terminate())` and `signal(SignalKind::interrupt())`
- Uses `tokio::select!` to respond to whichever signal arrives first
- On receipt, logs `"Received SIGTERM, shutting down service"` (or `SIGINT`)
- Calls `system.stop().await` followed by `system.join().await` for orderly teardown

**On Windows**:
- Listens for `Ctrl+C` via `tokio::signal::windows::ctrl_c()`

### 3.2 Sending SIGTERM from Node.js

```typescript
function stopServer(serverProcess: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!serverProcess.pid) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      // Force kill if graceful shutdown takes too long
      try {
        process.kill(serverProcess.pid!, 'SIGKILL');
      } catch {
        // Process may have already exited
      }
      resolve();
    }, 10_000); // 10 second timeout

    serverProcess.on('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    serverProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    // Send SIGTERM for graceful shutdown
    try {
      process.kill(serverProcess.pid, 'SIGTERM');
    } catch (err) {
      // ESRCH: process already gone
      clearTimeout(timeout);
      resolve();
    }
  });
}
```

### 3.3 Stopping a Server by PID (when ChildProcess reference is not available)

```typescript
function stopServerByPid(pid: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      // Check if the process exists
      process.kill(pid, 0); // Signal 0 = check existence only

      // Send SIGTERM
      process.kill(pid, 'SIGTERM');

      // Poll for exit
      const interval = setInterval(() => {
        try {
          process.kill(pid, 0); // Still alive?
        } catch {
          clearInterval(interval);
          resolve(); // Process is gone
        }
      }, 200);

      // Force kill after timeout
      setTimeout(() => {
        clearInterval(interval);
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone
        }
        resolve();
      }, 10_000);
    } catch {
      // Process does not exist (ESRCH)
      resolve();
    }
  });
}
```

### 3.4 Important Note on `detached: true`

When spawning with `detached: true`, the server process runs in a new process group. To kill the entire process group (including any child processes the server may have spawned):

```typescript
// Kill process group (negative PID)
process.kill(-serverProcess.pid!, 'SIGTERM');
```

However, since the Chroma server is a single-process Rust binary (not a process tree), sending SIGTERM to the process PID directly is sufficient.

### 3.5 Cleanup on Parent Process Exit

To ensure the server is stopped if the parent CLI process exits unexpectedly:

```typescript
function registerCleanupHandlers(serverProcess: ChildProcess): void {
  const cleanup = () => {
    if (serverProcess.pid) {
      try {
        process.kill(serverProcess.pid, 'SIGTERM');
      } catch {
        // Process already exited
      }
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    cleanup();
    process.exit(1);
  });
}
```

---

## 4. Port Configuration

### 4.1 Default Port

The default port for `chroma run` is **8000**. The `ChromaClient` constructor also defaults to port 8000.

### 4.2 Recommended Port Strategy for chromactl

To avoid conflicts with standalone ChromaDB instances (which use port 8000), use a different default port:

```typescript
const CHROMACTL_DEFAULT_PORT = 8100;
```

Store the configured port in the project's `chromactl.json`:

```json
{
  "port": 8100,
  "persistPath": "./chromactl-data",
  "host": "localhost"
}
```

### 4.3 Port Conflict Detection

The Chroma server performs port validation before starting. If the port is already in use, the `chroma run` command exits with an error:

```
Address localhost:8000 is not available
```

This is the `RunError::AddressUnavailable` error. The server uses `TcpListener::bind()` to test port availability before starting the server.

You can also detect port conflicts from Node.js *before* attempting to spawn the server:

```typescript
import net from 'node:net';

function isPortAvailable(port: number, host: string = 'localhost'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}
```

### 4.4 Port-Aware Server Start

```typescript
async function startServerOnAvailablePort(
  persistPath: string,
  preferredPort: number = 8100,
  host: string = 'localhost',
): Promise<ManagedServer> {
  // Check if the preferred port is available
  const available = await isPortAvailable(preferredPort, host);

  if (!available) {
    // Check if a Chroma server is already running on that port
    const alreadyRunning = await checkServerHealth(host, preferredPort);

    if (alreadyRunning) {
      // Reuse the existing server
      const client = new ChromaClient({ host, port: preferredPort });
      return {
        process: null as any,  // No process to manage
        client,
        pid: -1,  // Unknown PID
        port: preferredPort,
      };
    }

    throw new Error(
      `Port ${preferredPort} is in use by another process (not a Chroma server). ` +
      `Configure a different port in chromactl.json.`,
    );
  }

  return startManagedServer(persistPath, preferredPort, host);
}
```

---

## 5. Error Scenarios

### 5.1 Port Conflict

**Cause**: Another process (or another Chroma instance) is bound to the configured port.

**Server behavior**: The `chroma run` binary calls `validate_host()` which attempts `TcpListener::bind()`. On failure, it returns `RunError::AddressUnavailable("localhost", 8100)` and exits with a non-zero code.

**Detection from Node.js**: The spawned process exits immediately. The stderr will contain:
```
Address localhost:8100 is not available
```

**Handling strategy**:

```typescript
serverProcess.on('exit', (code) => {
  if (code !== 0) {
    // Check stderr for specific error messages
    // "Address ... is not available" = port conflict
    // "Config file ... does not exist" = bad config path
    // "Failed to start a Chroma server" = generic startup failure
  }
});
```

### 5.2 Corrupt or Inaccessible Database

**Cause**: The `--path` directory has corrupted SQLite files, permission errors, or was created by an incompatible Chroma version.

**Server behavior**: The server may fail during `frontend_service_entrypoint_with_config()` when initializing the `Frontend` component, which configures SQLite and segment manager paths.

**Detection**: The server process exits with a non-zero code. Error details appear in stderr (since `stdout_tracing = true` is set for CLI-started servers).

**Handling strategy**:

```typescript
async function handleDatabaseError(persistPath: string, stderr: string): Promise<void> {
  if (stderr.includes('database disk image is malformed')) {
    throw new Error(
      `ChromaDB database at ${persistPath} is corrupt. ` +
      `Consider running 'chromactl reset' to reinitialize.`,
    );
  }
  if (stderr.includes('Permission denied') || stderr.includes('EACCES')) {
    throw new Error(
      `Cannot access ChromaDB data directory: ${persistPath}. Check file permissions.`,
    );
  }
}
```

### 5.3 Missing Native Bindings

**Cause**: The platform-specific native binding package was not installed (e.g., on an unsupported platform, or due to `--no-optional` flag during install).

**Server behavior**: The `bindings.ts` loader throws an error:
- `"Unsupported platform: {platform}"` for completely unsupported OS
- `"Unsupported architecture: {arch}"` for unsupported CPU architecture
- `"Unsupported Windows architecture: {arch}. Only ARM64 is supported."` specifically for Windows x64

**Detection**: The spawn will fail immediately with a module loading error.

**Handling strategy**:

```typescript
function validatePlatformSupport(): void {
  const supported: Record<string, string[]> = {
    darwin: ['arm64', 'x64'],
    linux: ['arm64', 'x64'],
    win32: ['arm64'],
  };

  const platformArchs = supported[process.platform];
  if (!platformArchs) {
    throw new Error(`ChromaDB is not supported on ${process.platform}`);
  }
  if (!platformArchs.includes(process.arch)) {
    throw new Error(
      `ChromaDB is not supported on ${process.platform}/${process.arch}. ` +
      `Supported architectures: ${platformArchs.join(', ')}`,
    );
  }
}
```

### 5.4 Server Crash Mid-Operation

**Cause**: Out-of-memory, unhandled panic in the Rust binary, or OS-level kill.

**Detection**: The `ChildProcess` emits an `'exit'` event with a non-zero code or a signal.

**Handling strategy**:

```typescript
serverProcess.on('exit', (code, signal) => {
  if (signal === 'SIGKILL') {
    // OOM killer or forced termination
    console.error('ChromaDB server was killed (possibly OOM)');
  } else if (code !== 0 && code !== null) {
    console.error(`ChromaDB server crashed with exit code ${code}`);
  }
  // Clean up PID file, mark server as not running
});
```

### 5.5 Connection Lost During Operation

**Cause**: Server crashes or becomes unresponsive while a client operation is in progress.

**Detection**: The `ChromaClient` operation throws `ChromaConnectionError`.

**Handling strategy**: Implement a retry wrapper with automatic server restart:

```typescript
async function withRetry<T>(
  operation: () => Promise<T>,
  serverManager: ServerManager,
  maxRetries: number = 1,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof Error &&
        error.constructor.name === 'ChromaConnectionError' &&
        attempt < maxRetries
      ) {
        // Server may have crashed -- restart and retry
        await serverManager.restart();
        continue;
      }
      throw error;
    }
  }
  throw new Error('Unreachable');
}
```

---

## 6. PID File Management

### 6.1 Purpose

A PID file records the process ID of a running background server, enabling:
- Detecting if a server is already running
- Stopping the server from a different CLI invocation
- Cleaning up stale processes

### 6.2 PID File Location

Store the PID file alongside the project configuration:

```
<project-root>/
  chromactl.json         # Project configuration
  .chromactl/
    server.pid           # PID of the running server
    server.port          # Port the server is using (for validation)
    server.log           # Optional: server output log
```

### 6.3 PID File Implementation

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';

interface ServerInfo {
  pid: number;
  port: number;
  startedAt: string;  // ISO timestamp
  persistPath: string;
}

const PID_DIR = '.chromactl';
const PID_FILE = 'server.json';

async function writeServerInfo(
  projectRoot: string,
  info: ServerInfo,
): Promise<void> {
  const dir = path.join(projectRoot, PID_DIR);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, PID_FILE);
  await fs.writeFile(filePath, JSON.stringify(info, null, 2) + '\n', 'utf-8');
}

async function readServerInfo(
  projectRoot: string,
): Promise<ServerInfo | null> {
  const filePath = path.join(projectRoot, PID_DIR, PID_FILE);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as ServerInfo;
  } catch {
    return null; // File doesn't exist or is unreadable
  }
}

async function deleteServerInfo(projectRoot: string): Promise<void> {
  const filePath = path.join(projectRoot, PID_DIR, PID_FILE);
  try {
    await fs.unlink(filePath);
  } catch {
    // File already deleted or doesn't exist
  }
}
```

### 6.4 Stale PID Detection

A PID file can become stale if the server crashes without cleanup. Always validate:

```typescript
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = existence check
    return true;
  } catch (err) {
    // ESRCH = no such process (stale PID)
    // EPERM = process exists but we can't signal it (still running)
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function isServerActuallyRunning(
  projectRoot: string,
): Promise<{ running: boolean; info: ServerInfo | null }> {
  const info = await readServerInfo(projectRoot);

  if (!info) {
    return { running: false, info: null };
  }

  // Check 1: Is the PID still alive?
  if (!isProcessRunning(info.pid)) {
    // Stale PID file -- clean up
    await deleteServerInfo(projectRoot);
    return { running: false, info: null };
  }

  // Check 2: Is it actually a Chroma server on the expected port?
  // (Another process could have reused the PID)
  try {
    const response = await fetch(
      `http://localhost:${info.port}/api/v2/heartbeat`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (response.ok) {
      return { running: true, info };
    }
  } catch {
    // Process exists but isn't responding on the expected port
    // This might be a PID collision -- clean up the stale file
    await deleteServerInfo(projectRoot);
    return { running: false, info: null };
  }

  return { running: false, info: null };
}
```

### 6.5 File Locking for Concurrent Access

If multiple CLI invocations might run concurrently, use advisory file locking:

```typescript
import { open } from 'node:fs/promises';

async function acquireLock(projectRoot: string): Promise<fs.FileHandle> {
  const lockPath = path.join(projectRoot, PID_DIR, 'server.lock');
  await fs.mkdir(path.join(projectRoot, PID_DIR), { recursive: true });

  const handle = await open(lockPath, 'w');

  // Use a simple atomic file existence check as a lock mechanism
  // For robust locking, consider the `proper-lockfile` npm package
  return handle;
}
```

---

## 7. Architectural Patterns: Start-per-Command vs Persistent Daemon

### 7.1 Start-per-Command Pattern

**How it works**: Each CLI command starts a fresh Chroma server, performs its operation, and stops the server.

```
chromactl search "query"
  --> start server (1-3 sec)
  --> connect, run query
  --> stop server
  --> exit
```

**Implementation**:

```typescript
async function executeWithServer<T>(
  config: ChromactlConfig,
  operation: (client: ChromaClient) => Promise<T>,
): Promise<T> {
  const server = await startManagedServer(config.persistPath, config.port);

  try {
    return await operation(server.client);
  } finally {
    await stopServer(server.process);
  }
}

// Usage:
const results = await executeWithServer(config, async (client) => {
  const collection = await client.getCollection({ name: 'docs' });
  return collection.query({
    queryTexts: ['search term'],
    nResults: 5,
  });
});
```

**Pros**:
- Simplest implementation -- no PID file management, no daemon lifecycle
- No resource leakage -- server is always cleaned up
- No stale process issues
- Each command is fully self-contained

**Cons**:
- **1-3 second overhead** per command for server startup
- Not suitable for interactive use or rapid successive commands
- Embedding model is re-loaded on each invocation (additional 1-3 seconds on first use)

**Best for**: Batch operations, CI/CD pipelines, infrequent CLI usage.

### 7.2 Persistent Daemon Pattern

**How it works**: The server is started once and stays running between commands. A PID file tracks the running instance.

```
chromactl start
  --> start server, write PID file
  --> exit (server stays running)

chromactl search "query"
  --> read PID file, check health
  --> connect to existing server
  --> run query, exit

chromactl stop
  --> read PID file, send SIGTERM
  --> delete PID file
```

**Implementation**:

```typescript
class ServerManager {
  constructor(private projectRoot: string, private config: ChromactlConfig) {}

  async ensureRunning(): Promise<ChromaClient> {
    // 1. Check for existing server
    const { running, info } = await isServerActuallyRunning(this.projectRoot);

    if (running && info) {
      return new ChromaClient({
        host: this.config.host,
        port: info.port,
      });
    }

    // 2. Start a new server
    const server = await startManagedServer(
      this.config.persistPath,
      this.config.port,
      this.config.host,
    );

    // 3. Write PID file
    await writeServerInfo(this.projectRoot, {
      pid: server.pid,
      port: server.port,
      startedAt: new Date().toISOString(),
      persistPath: this.config.persistPath,
    });

    // 4. Unref the server process so the CLI can exit without waiting
    server.process.unref();
    // Also unref stdio streams
    server.process.stdout?.unref?.();
    server.process.stderr?.unref?.();

    return server.client;
  }

  async stop(): Promise<void> {
    const info = await readServerInfo(this.projectRoot);
    if (!info) {
      return; // No server running
    }

    await stopServerByPid(info.pid);
    await deleteServerInfo(this.projectRoot);
  }
}
```

**Pros**:
- Zero overhead on subsequent commands after first start
- Embedding model stays in memory -- faster repeated operations
- Better UX for interactive workflows

**Cons**:
- PID file management complexity
- Stale process detection required
- Resource consumption even when idle (memory ~100-300 MB)
- Cleanup needed on system restart or crash
- Potential for orphaned processes

**Best for**: Interactive development, rapid iteration, frequent commands.

### 7.3 Hybrid Pattern (Recommended)

**How it works**: Auto-start the server on first command, keep it running for subsequent commands, with an optional explicit stop command. Use `process.unref()` to allow the CLI to exit while the server continues.

```
chromactl search "query"   # Auto-starts server if not running
  --> check PID file / health
  --> if not running: start server, write PID, unref
  --> connect, run query
  --> exit (server keeps running)

chromactl search "another" # Reuses existing server
  --> check PID file / health
  --> already running: connect directly
  --> run query, exit

chromactl stop             # Explicit stop when done
  --> read PID, send SIGTERM, delete PID file
```

**Implementation** (using Commander.js `preAction` hook):

```typescript
import { Command } from 'commander';

const program = new Command();
const serverManager = new ServerManager(projectRoot, config);

// Pre-action hook: ensure server is running before any DB command
function requireServer(cmd: Command): void {
  cmd.hook('preAction', async () => {
    const client = await serverManager.ensureRunning();
    // Store client on command context for action handlers
    cmd.setOptionValue('_client', client);
  });
}

// Commands that need the server
const searchCmd = program.command('search <query>')
  .description('Search documents by semantic similarity')
  .option('-n, --results <n>', 'Number of results', '5');
requireServer(searchCmd);
searchCmd.action(async (query, options) => {
  const client = options._client as ChromaClient;
  // ... perform search
});

// Commands that don't need the server
program.command('stop')
  .description('Stop the ChromaDB server')
  .action(async () => {
    await serverManager.stop();
    console.log('ChromaDB server stopped.');
  });

program.command('status')
  .description('Show server status')
  .action(async () => {
    const { running, info } = await isServerActuallyRunning(projectRoot);
    if (running && info) {
      console.log(`Server running (PID: ${info.pid}, port: ${info.port})`);
    } else {
      console.log('Server not running.');
    }
  });
```

**Pros**:
- Transparent to the user -- server management is invisible
- Fast after first command
- Explicit control available via `stop` command

**Cons**:
- Still requires PID file management
- First command has startup overhead
- More complex than start-per-command

**Best for**: General-purpose CLI tools -- balances simplicity with performance.

---

## 8. Complete Server Manager Module

This is a production-ready TypeScript module that implements the hybrid pattern:

```typescript
// server-manager.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { ChromaClient } from 'chromadb';

// --- Types ---

interface ServerInfo {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  persistPath: string;
}

interface ServerManagerConfig {
  projectRoot: string;
  persistPath: string;
  port: number;
  host: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

// --- Helpers ---

function resolveChromaBinary(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('chromadb/package.json');
  return path.join(path.dirname(pkgPath), 'dist', 'cli.mjs');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

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

// --- Server Manager ---

export class ServerManager {
  private pidDir: string;
  private pidFile: string;

  constructor(private config: ServerManagerConfig) {
    this.pidDir = path.join(config.projectRoot, '.chromactl');
    this.pidFile = path.join(this.pidDir, 'server.json');
  }

  /** Start server if not already running; return a connected ChromaClient. */
  async ensureRunning(): Promise<ChromaClient> {
    const existing = await this.getRunningServer();
    if (existing) {
      return new ChromaClient({ host: existing.host, port: existing.port });
    }
    return this.start();
  }

  /** Start a new server. Throws if one is already running. */
  async start(): Promise<ChromaClient> {
    const { persistPath, port, host } = this.config;

    // Validate port availability
    const free = await isPortFree(port, host);
    if (!free) {
      const alive = await healthCheck(host, port);
      if (alive) {
        throw new Error(
          `A ChromaDB server is already running on ${host}:${port} (not managed by chromactl).`,
        );
      }
      throw new Error(
        `Port ${port} on ${host} is in use by another process. ` +
        `Configure a different port in chromactl.json.`,
      );
    }

    // Spawn the server
    const cliBinary = resolveChromaBinary();
    const proc = spawn(
      process.execPath,
      [cliBinary, 'run', '--path', persistPath, '--port', String(port), '--host', host],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env, CHROMADB_VERSION: '999.999.999' },
      },
    );

    // Capture stderr for error reporting
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    // Detect early exit
    const earlyExitPromise = new Promise<never>((_, reject) => {
      proc.on('exit', (code, signal) => {
        reject(new Error(
          `ChromaDB server exited unexpectedly (code=${code}, signal=${signal}). ` +
          (stderr.trim() ? `stderr: ${stderr.trim()}` : 'No error output.'),
        ));
      });
    });

    // Wait for readiness
    const client = new ChromaClient({ host, port });
    const timeoutMs = this.config.startupTimeoutMs ?? 30_000;
    const readyPromise = this.pollUntilReady(client, timeoutMs);

    await Promise.race([readyPromise, earlyExitPromise]);

    // Write PID file
    const info: ServerInfo = {
      pid: proc.pid!,
      port,
      host,
      startedAt: new Date().toISOString(),
      persistPath,
    };
    await this.writeInfo(info);

    // Detach: let the CLI exit while server keeps running
    proc.stderr?.removeAllListeners();
    proc.removeAllListeners('exit');
    proc.unref();
    proc.stdout?.unref?.();
    proc.stderr?.unref?.();

    return client;
  }

  /** Stop the managed server. */
  async stop(): Promise<boolean> {
    const info = await this.readInfo();
    if (!info) return false;

    if (isProcessAlive(info.pid)) {
      try {
        process.kill(info.pid, 'SIGTERM');
      } catch {
        // Already gone
      }

      // Wait for exit
      const deadline = Date.now() + (this.config.shutdownTimeoutMs ?? 10_000);
      while (Date.now() < deadline && isProcessAlive(info.pid)) {
        await new Promise((r) => setTimeout(r, 200));
      }

      // Force kill if still alive
      if (isProcessAlive(info.pid)) {
        try {
          process.kill(info.pid, 'SIGKILL');
        } catch {
          // Already gone
        }
      }
    }

    await this.deleteInfo();
    return true;
  }

  /** Get info about the currently running server, or null. */
  async getRunningServer(): Promise<ServerInfo | null> {
    const info = await this.readInfo();
    if (!info) return null;

    if (!isProcessAlive(info.pid)) {
      await this.deleteInfo(); // Stale PID
      return null;
    }

    const alive = await healthCheck(info.host, info.port);
    if (!alive) {
      await this.deleteInfo(); // Process alive but not responding
      return null;
    }

    return info;
  }

  // --- Private ---

  private async pollUntilReady(
    client: ChromaClient,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let delay = 100;

    while (Date.now() < deadline) {
      try {
        await client.heartbeat();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, 2000);
      }
    }

    throw new Error(`ChromaDB server not ready within ${timeoutMs}ms`);
  }

  private async writeInfo(info: ServerInfo): Promise<void> {
    await fs.mkdir(this.pidDir, { recursive: true });
    await fs.writeFile(this.pidFile, JSON.stringify(info, null, 2) + '\n');
  }

  private async readInfo(): Promise<ServerInfo | null> {
    try {
      const content = await fs.readFile(this.pidFile, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private async deleteInfo(): Promise<void> {
    try {
      await fs.unlink(this.pidFile);
    } catch {
      // Already deleted
    }
  }
}
```

---

## 9. ChromaDB Server Configuration Reference

### 9.1 `chroma run` CLI Reference

```
Usage: chroma run [OPTIONS] [CONFIG_PATH]

Arguments:
  [CONFIG_PATH]  Path to a YAML config file (conflicts with --path, --host, --port)

Options:
  --path <PATH>    Persistence directory for the database
  --host <HOST>    Host to bind to [default: localhost]
  --port <PORT>    Port to listen on [default: 8000]
  -h, --help       Print help
```

### 9.2 Server Version

The server version is hardcoded to `"1.0.0"` in the TypeScript client's `SystemState` implementation and exposed via:

```
GET /api/v2/version
```

### 9.3 API Endpoint Summary

| Method | Path                                     | Description                          |
| ------ | ---------------------------------------- | ------------------------------------ |
| GET    | `/api/v2/heartbeat`                      | Health check (nanosecond timestamp)  |
| GET    | `/api/v2/version`                        | Server version                       |
| POST   | `/api/v2/reset`                          | Reset entire database (destructive)  |
| GET    | `/api/v2/tenants/{tenant}/databases`     | List databases                       |
| POST   | `/api/v2/tenants/{tenant}/databases`     | Create database                      |
| GET    | `/api/v2/.../collections`                | List collections                     |
| POST   | `/api/v2/.../collections`                | Create collection                    |
| GET    | `/api/v2/.../collections_count`          | Count collections                    |
| GET    | `/api/v2/.../collections/{id}`           | Get collection                       |
| PUT    | `/api/v2/.../collections/{id}`           | Update collection                    |
| DELETE | `/api/v2/.../collections/{id}`           | Delete collection                    |
| POST   | `/api/v2/.../collections/{id}/add`       | Add documents                        |
| POST   | `/api/v2/.../collections/{id}/upsert`    | Upsert documents                     |
| POST   | `/api/v2/.../collections/{id}/update`    | Update documents                     |
| POST   | `/api/v2/.../collections/{id}/delete`    | Delete documents                     |
| POST   | `/api/v2/.../collections/{id}/query`     | Query (semantic search)              |
| GET    | `/api/v2/.../collections/{id}/count`     | Count documents                      |
| POST   | `/api/v2/.../collections/{id}/get`       | Get documents by ID/filter           |
| ANY    | `/api/v1/{*any}`                         | Deprecated (returns notice)          |

### 9.4 ChromaClient Constructor Options (v3.x)

```typescript
interface ChromaClientParams {
  host?: string;       // Default: 'localhost'
  port?: number;       // Default: 8000
  ssl?: boolean;       // Default: false
  tenant?: string;     // Default: 'default_tenant'
  database?: string;   // Default: 'default_database'
  headers?: Record<string, string>;
  fetchOptions?: RequestInit;
  path?: string;       // Full base URL (overrides host/port/ssl)
  auth?: Record<string, string>;
}
```

**Note on `path`**: When `path` is provided (e.g., `"http://localhost:8100"`), it is used directly as `basePath` in the internal `Configuration`. When only `host`/`port` are provided, the URL is constructed as `http(s)://host:port`.

---

## 10. Key Findings and Recommendations

### 10.1 Server Startup Time

Expect **1-3 seconds** from spawn to first successful heartbeat response. The Chroma Rust binary:
1. Parses CLI arguments (~instant)
2. Validates port availability via `TcpListener::bind()` (~instant)
3. Prints the startup banner (`display_run_message`) (~instant)
4. Creates a Tokio multi-threaded runtime (~10-50ms)
5. Loads `FrontendServerConfig` and initializes the `Frontend` (~100-500ms)
6. Binds the actual HTTP server and starts accepting connections (~50ms)

The bottleneck is step 5, which includes SQLite database initialization and segment manager setup.

### 10.2 Memory Footprint

- **Server process**: ~50-100 MB baseline for the Rust binary
- **Embedding model**: ~100-200 MB when the `all-MiniLM-L6-v2` ONNX model is loaded (server-side or client-side depending on configuration)
- **Total per operation**: Expect ~200-300 MB when server and embedding model are both in memory

### 10.3 Recommended Architecture for chromactl

1. **Use the hybrid pattern** (Section 7.3): auto-start on first command, keep running, explicit stop
2. **Default port 8100** to avoid conflicts with standalone Chroma instances on port 8000
3. **PID file at `.chromactl/server.json`** with PID, port, timestamp, and persist path
4. **Exponential backoff** for readiness polling (100ms initial, 1.5x factor, 2s max, 30 attempts)
5. **Three-tier validation** for existing server: PID alive check, heartbeat check, port match
6. **SIGTERM with 10s timeout** for graceful shutdown, falling back to SIGKILL
7. **Register cleanup handlers** for `exit`, `SIGINT`, `SIGTERM`, and `uncaughtException` in the parent process (only if using start-per-command pattern)
8. **Suppress CLI update check** by setting `CHROMADB_VERSION=999.999.999` in the spawned process environment

### 10.4 API Version Note

ChromaDB v3.x JS client uses `/api/v2/*` endpoints. All `/api/v1/*` routes return a deprecation notice. Ensure health checks target `/api/v2/heartbeat`, not the old `/api/v1/heartbeat`.

---

## References

| # | Source | Description |
|---|--------|-------------|
| 1 | [ChromaDB CLI Run Docs](https://docs.trychroma.com/docs/cli/run) | Official `chroma run` command reference |
| 2 | [ChromaDB Client Docs](https://docs.trychroma.com/docs/run-chroma/clients) | JS/TS client connection guide |
| 3 | [ChromaDB TS Client Reference](https://docs.trychroma.com/reference/typescript/client) | ChromaClient API reference |
| 4 | [chromadb npm v3.4.3](https://registry.npmjs.org/chromadb/latest) | Package metadata, dependencies, bin field |
| 5 | [GitHub: cli.ts](https://github.com/chroma-core/chroma/blob/main/clients/js/packages/chromadb/src/cli.ts) | CLI entry point source code |
| 6 | [GitHub: bindings.ts](https://github.com/chroma-core/chroma/blob/main/clients/js/packages/chromadb/src/bindings.ts) | Native bindings loader |
| 7 | [GitHub: ChromaClient.ts](https://github.com/chroma-core/chroma/blob/main/clients/js/packages/chromadb-core/src/ChromaClient.ts) | Client implementation with heartbeat() |
| 8 | [GitHub: ChromaFetch.ts](https://github.com/chroma-core/chroma/blob/main/clients/js/packages/chromadb-core/src/ChromaFetch.ts) | HTTP client with error handling |
| 9 | [GitHub: Errors.ts](https://github.com/chroma-core/chroma/blob/main/clients/js/packages/chromadb-core/src/Errors.ts) | Error class definitions |
| 10 | [GitHub: run.rs](https://github.com/chroma-core/chroma/blob/main/rust/cli/src/commands/run.rs) | Rust CLI run command with port validation |
| 11 | [GitHub: server.rs](https://github.com/chroma-core/chroma/blob/main/rust/frontend/src/server.rs) | Axum server with graceful shutdown |
| 12 | [GitHub: generated api.ts](https://github.com/chroma-core/chroma/blob/main/clients/js/packages/chromadb-core/src/generated/api.ts) | Generated API client with /api/v2/heartbeat path |
| 13 | [ChromaDB Getting Started](https://docs.trychroma.com/docs/overview/getting-started) | JS/TS usage examples |
| 14 | [ChromaDB CLI Install](https://docs.trychroma.com/docs/cli/install) | CLI installation guide |
