import fs from 'node:fs';
import path from 'node:path';
import type { ChromactlConfig } from '../types/index.js';
import { ConfigNotFoundError, ChromactlError } from './errors.js';

/**
 * Walk up directories from startDir looking for chromactl.json.
 * Returns the absolute path to the config file, or null if not found.
 */
export function findConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);

  for (;;) {
    const candidate = path.join(dir, 'chromactl.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      // Reached filesystem root
      return null;
    }
    dir = parent;
  }
}

/**
 * Load and parse chromactl.json from the given path.
 * Throws ConfigNotFoundError if file does not exist.
 * Throws ChromactlError if file is malformed JSON.
 */
export function loadConfig(configPath: string): ChromactlConfig {
  if (!fs.existsSync(configPath)) {
    throw new ConfigNotFoundError(path.dirname(configPath));
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    throw new ChromactlError(
      `Failed to read config file: ${configPath}`,
      1,
    );
  }

  try {
    return JSON.parse(raw) as ChromactlConfig;
  } catch {
    throw new ChromactlError(
      `Malformed JSON in config file: ${configPath}`,
      1,
      'Check the file for syntax errors.',
    );
  }
}

/**
 * Write the config to disk atomically (write to .tmp, rename).
 * Creates parent directories if needed.
 */
export function saveConfig(configPath: string, config: ChromactlConfig): void {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, configPath);
}

/**
 * Resolve config from multiple sources in priority order:
 * 1. --db <path> CLI flag (options.db)
 * 2. CHROMACTL_DB environment variable
 * 3. Walk up from cwd to find chromactl.json
 * 4. Default: chromactl.json in cwd
 *
 * Returns both the config and the resolved config file path.
 * Throws ConfigNotFoundError if no config found and requireExisting is true.
 */
export function resolveConfig(options: {
  db?: string;
  requireExisting?: boolean;
}): { configPath: string; config: ChromactlConfig } {
  // Priority 1: --db <path> CLI flag
  if (options.db) {
    const configPath = path.resolve(options.db, 'chromactl.json');
    if (fs.existsSync(configPath)) {
      return { configPath, config: loadConfig(configPath) };
    }
    if (options.requireExisting) {
      throw new ConfigNotFoundError(options.db);
    }
    return { configPath, config: getDefaultConfig() };
  }

  // Priority 2: CHROMACTL_DB environment variable
  const envDb = process.env['CHROMACTL_DB'];
  if (envDb) {
    const configPath = path.resolve(envDb, 'chromactl.json');
    if (fs.existsSync(configPath)) {
      return { configPath, config: loadConfig(configPath) };
    }
    if (options.requireExisting) {
      throw new ConfigNotFoundError(envDb);
    }
    return { configPath, config: getDefaultConfig() };
  }

  // Priority 3: Walk up from cwd
  const found = findConfigFile(process.cwd());
  if (found) {
    return { configPath: found, config: loadConfig(found) };
  }

  // Priority 4: Default location
  const configPath = path.resolve(process.cwd(), 'chromactl.json');
  if (fs.existsSync(configPath)) {
    return { configPath, config: loadConfig(configPath) };
  }
  if (options.requireExisting) {
    throw new ConfigNotFoundError(process.cwd());
  }
  return { configPath, config: getDefaultConfig() };
}

/**
 * Return a ChromactlConfig populated with all default values.
 */
export function getDefaultConfig(): ChromactlConfig {
  return {
    version: '1.0',
    dbPath: '.chromactl/chroma-data',
    defaultCollection: 'default',
    port: 8100,
    host: 'localhost',
    chunkSize: 1000,
    chunkOverlap: 200,
    schemas: {},
    collectionSchemas: {},
  };
}

/**
 * Resolve the dbPath from config (which may be relative) to an absolute path
 * anchored at the directory containing chromactl.json.
 */
export function getDbPath(config: ChromactlConfig, configDir: string): string {
  return path.resolve(configDir, config.dbPath);
}

/**
 * Resolve the absolute path to the .chromactl directory
 * (the parent of chroma-data, server.json, models/).
 */
export function getProjectDir(configPath: string): string {
  return path.join(path.dirname(configPath), '.chromactl');
}
