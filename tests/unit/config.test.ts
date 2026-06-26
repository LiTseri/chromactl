import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  getDefaultConfig,
  loadConfig,
  saveConfig,
  findConfigFile,
  resolveConfig,
} from '../../src/lib/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chromactl-config-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Clean up any env var we may have set
  delete process.env['CHROMACTL_DB'];
});

// ---------------------------------------------------------------------------
// getDefaultConfig
// ---------------------------------------------------------------------------

describe('getDefaultConfig', () => {
  it('returns valid defaults with expected fields', () => {
    const config = getDefaultConfig();

    expect(config.version).toBe('1.0');
    expect(config.dbPath).toBe('.chromactl/chroma-data');
    expect(config.defaultCollection).toBe('default');
    expect(config.chunkSize).toBe(1000);
    expect(config.chunkOverlap).toBe(200);
    expect(config.schemas).toEqual({});
    expect(config.collectionSchemas).toEqual({});
    expect(config.port).toBe(8100);
    expect(config.host).toBe('localhost');
  });

  it('returns a new object on each call', () => {
    const a = getDefaultConfig();
    const b = getDefaultConfig();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  it('reads and parses valid JSON config', () => {
    const configPath = path.join(tmpDir, 'chromactl.json');
    const data = getDefaultConfig();
    data.defaultCollection = 'my-collection';
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');

    const loaded = loadConfig(configPath);
    expect(loaded.defaultCollection).toBe('my-collection');
    expect(loaded.version).toBe('1.0');
  });

  it('throws ConfigNotFoundError on missing file', () => {
    const configPath = path.join(tmpDir, 'does-not-exist.json');
    expect(() => loadConfig(configPath)).toThrow('No chromactl database found');
  });

  it('throws ChromactlError on malformed JSON', () => {
    const configPath = path.join(tmpDir, 'chromactl.json');
    fs.writeFileSync(configPath, '{ invalid json !!!', 'utf-8');
    expect(() => loadConfig(configPath)).toThrow('Malformed JSON');
  });
});

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------

describe('saveConfig', () => {
  it('writes config and can be loaded back', () => {
    const configPath = path.join(tmpDir, 'chromactl.json');
    const config = getDefaultConfig();
    config.defaultCollection = 'saved-collection';

    saveConfig(configPath, config);

    const loaded = loadConfig(configPath);
    expect(loaded.defaultCollection).toBe('saved-collection');
  });

  it('writes atomically (tmp file then rename)', () => {
    const configPath = path.join(tmpDir, 'chromactl.json');
    saveConfig(configPath, getDefaultConfig());

    // After save, the .tmp file should not remain
    expect(fs.existsSync(configPath + '.tmp')).toBe(false);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('creates parent directories if they do not exist', () => {
    const nested = path.join(tmpDir, 'deep', 'nested', 'dir');
    const configPath = path.join(nested, 'chromactl.json');

    saveConfig(configPath, getDefaultConfig());

    expect(fs.existsSync(configPath)).toBe(true);
    const loaded = loadConfig(configPath);
    expect(loaded.version).toBe('1.0');
  });
});

// ---------------------------------------------------------------------------
// findConfigFile
// ---------------------------------------------------------------------------

describe('findConfigFile', () => {
  it('finds chromactl.json in the start directory', () => {
    const configPath = path.join(tmpDir, 'chromactl.json');
    fs.writeFileSync(configPath, '{}', 'utf-8');

    const found = findConfigFile(tmpDir);
    expect(found).toBe(configPath);
  });

  it('walks up to parent directories to find config', () => {
    const configPath = path.join(tmpDir, 'chromactl.json');
    fs.writeFileSync(configPath, '{}', 'utf-8');

    const child = path.join(tmpDir, 'child', 'grandchild');
    fs.mkdirSync(child, { recursive: true });

    const found = findConfigFile(child);
    expect(found).toBe(configPath);
  });

  it('returns null when no config exists in the tree', () => {
    // Use a temp dir without any chromactl.json in its ancestry
    // (our tmpDir is fresh and has no chromactl.json unless we create one)
    const found = findConfigFile(tmpDir);
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

describe('resolveConfig', () => {
  it('uses --db flag as highest priority', () => {
    const dbDir = path.join(tmpDir, 'db-flag');
    fs.mkdirSync(dbDir, { recursive: true });
    const configPath = path.join(dbDir, 'chromactl.json');
    const config = getDefaultConfig();
    config.defaultCollection = 'from-db-flag';
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8');

    const result = resolveConfig({ db: dbDir });
    expect(result.config.defaultCollection).toBe('from-db-flag');
    expect(result.configPath).toBe(configPath);
  });

  it('uses CHROMACTL_DB env var when --db is not provided', () => {
    const envDir = path.join(tmpDir, 'env-dir');
    fs.mkdirSync(envDir, { recursive: true });
    const configPath = path.join(envDir, 'chromactl.json');
    const config = getDefaultConfig();
    config.defaultCollection = 'from-env';
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8');

    process.env['CHROMACTL_DB'] = envDir;

    const result = resolveConfig({});
    expect(result.config.defaultCollection).toBe('from-env');
  });

  it('--db takes priority over CHROMACTL_DB', () => {
    // Set up env var config
    const envDir = path.join(tmpDir, 'env-dir');
    fs.mkdirSync(envDir, { recursive: true });
    const envConfig = getDefaultConfig();
    envConfig.defaultCollection = 'from-env';
    fs.writeFileSync(
      path.join(envDir, 'chromactl.json'),
      JSON.stringify(envConfig),
      'utf-8',
    );
    process.env['CHROMACTL_DB'] = envDir;

    // Set up --db config
    const dbDir = path.join(tmpDir, 'db-dir');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbConfig = getDefaultConfig();
    dbConfig.defaultCollection = 'from-db';
    fs.writeFileSync(
      path.join(dbDir, 'chromactl.json'),
      JSON.stringify(dbConfig),
      'utf-8',
    );

    const result = resolveConfig({ db: dbDir });
    expect(result.config.defaultCollection).toBe('from-db');
  });

  it('returns default config when no config exists and requireExisting is false', () => {
    const dbDir = path.join(tmpDir, 'empty-db');
    fs.mkdirSync(dbDir, { recursive: true });

    const result = resolveConfig({ db: dbDir });
    expect(result.config.version).toBe('1.0');
    expect(result.config.defaultCollection).toBe('default');
  });

  it('throws ConfigNotFoundError when requireExisting is true and no config found', () => {
    const dbDir = path.join(tmpDir, 'no-config');
    fs.mkdirSync(dbDir, { recursive: true });

    expect(() =>
      resolveConfig({ db: dbDir, requireExisting: true }),
    ).toThrow('No chromactl database found');
  });
});
