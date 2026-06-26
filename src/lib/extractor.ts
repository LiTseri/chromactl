import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { MissingDependency } from '../types/index.js';
import { ExtractionError, DependencyError } from './errors.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB
const TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Supported file extensions for text extraction.
 */
export const SUPPORTED_EXTENSIONS: readonly string[] = [
  '.txt',
  '.md',
  '.pdf',
  '.docx',
  '.html',
] as const;

// ---------------------------------------------------------------------------
// Extension-to-strategy mapping
// ---------------------------------------------------------------------------

interface ExtractionStrategy {
  method: 'fs' | 'exec';
  tool: string | null;
  args: (filePath: string) => string[];
}

const EXTRACTION_STRATEGIES: Record<string, ExtractionStrategy> = {
  '.txt': { method: 'fs', tool: null, args: () => [] },
  '.md': { method: 'fs', tool: null, args: () => [] },
  '.pdf': { method: 'exec', tool: 'pdftotext', args: (f) => [f, '-'] },
  '.docx': { method: 'exec', tool: 'pandoc', args: (f) => [f, '-t', 'plain'] },
  '.html': { method: 'exec', tool: 'pandoc', args: (f) => [f, '-t', 'plain'] },
};

const INSTALL_HINTS: Record<string, string> = {
  pdftotext: 'apt install poppler-utils',
  pandoc: 'apt install pandoc',
};

// ---------------------------------------------------------------------------
// Dependency cache (per-process, never re-checks)
// ---------------------------------------------------------------------------

const dependencyCache = new Map<string, string | null>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a system tool is installed and available on PATH.
 * Returns the tool path if found, null otherwise.
 * Results are cached per process.
 */
export async function checkDependency(
  toolName: string,
): Promise<string | null> {
  if (dependencyCache.has(toolName)) {
    return dependencyCache.get(toolName)!;
  }

  try {
    const { stdout } = await execFile('which', [toolName]);
    const toolPath = stdout.trim();
    dependencyCache.set(toolName, toolPath);
    return toolPath;
  } catch {
    dependencyCache.set(toolName, null);
    return null;
  }
}

/**
 * Given a list of file extensions that will be processed,
 * check that all required system tools are available.
 * Returns an array of missing tool descriptions.
 */
export async function validateDependencies(
  extensions: string[],
): Promise<MissingDependency[]> {
  const needed = new Map<string, string[]>(); // tool -> extensions that need it

  for (const ext of extensions) {
    const strategy = EXTRACTION_STRATEGIES[ext];
    if (strategy?.tool) {
      const existing = needed.get(strategy.tool) ?? [];
      existing.push(ext);
      needed.set(strategy.tool, existing);
    }
  }

  const missing: MissingDependency[] = [];

  for (const [tool, exts] of needed) {
    const found = await checkDependency(tool);
    if (!found) {
      missing.push({
        tool,
        requiredFor: exts.join(', ') + ' files',
        installHint: INSTALL_HINTS[tool] ?? `Install '${tool}'`,
      });
    }
  }

  return missing;
}

/**
 * Check if a file extension is supported for extraction.
 */
export function isSupportedExtension(ext: string): boolean {
  return ext.toLowerCase() in EXTRACTION_STRATEGIES;
}

/**
 * Return the list of supported file extensions.
 */
export function getSupportedExtensions(): string[] {
  return [...SUPPORTED_EXTENSIONS];
}

/**
 * Check if a file is supported for extraction (by its full path).
 */
export function isSupported(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return isSupportedExtension(ext);
}

/**
 * Extract text content from a file based on its extension.
 * Dispatches to the appropriate extraction strategy.
 *
 * @throws {ExtractionError} on extraction failure or unsupported format
 * @throws {DependencyError} if required system tool is not installed
 */
export async function extractText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  const strategy = EXTRACTION_STRATEGIES[ext];

  if (!strategy) {
    throw new ExtractionError(filePath, `Unsupported file type: ${ext}`);
  }

  if (strategy.method === 'fs') {
    return extractViaFs(filePath);
  }

  // strategy.method === 'exec'
  return extractViaExec(filePath, strategy);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function extractViaFs(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new ExtractionError(filePath, 'File not found');
    }
    throw new ExtractionError(filePath, err.message ?? String(error));
  }
}

async function extractViaExec(
  filePath: string,
  strategy: ExtractionStrategy,
): Promise<string> {
  const tool = strategy.tool!;

  // Check that the tool is installed (result is cached)
  const toolPath = await checkDependency(tool);
  if (toolPath === null) {
    throw new DependencyError(
      tool,
      INSTALL_HINTS[tool] ?? `Install '${tool}'`,
    );
  }

  try {
    const { stdout } = await execFile(tool, strategy.args(filePath), {
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS,
      encoding: 'utf-8',
    });
    return stdout;
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException & {
      killed?: boolean;
      stderr?: string;
      code?: string | number | null;
    };

    if (err.killed) {
      throw new ExtractionError(
        filePath,
        'Extraction timed out after 30 seconds',
      );
    }

    if (err.code === 'ENOENT') {
      throw new ExtractionError(filePath, 'File not found');
    }

    // Non-zero exit code -- include stderr content if available
    const stderrContent = err.stderr?.trim();
    const message = stderrContent
      ? `${tool} failed: ${stderrContent}`
      : err.message ?? String(error);

    throw new ExtractionError(filePath, message);
  }
}
