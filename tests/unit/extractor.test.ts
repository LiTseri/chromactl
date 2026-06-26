import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  isSupported,
  getSupportedExtensions,
  extractText,
  isSupportedExtension,
} from '../../src/lib/extractor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// isSupported
// ---------------------------------------------------------------------------

describe('isSupported', () => {
  it('returns true for .txt files', () => {
    expect(isSupported('document.txt')).toBe(true);
  });

  it('returns true for .md files', () => {
    expect(isSupported('README.md')).toBe(true);
  });

  it('returns true for .pdf files', () => {
    expect(isSupported('paper.pdf')).toBe(true);
  });

  it('returns true for .docx files', () => {
    expect(isSupported('report.docx')).toBe(true);
  });

  it('returns true for .html files', () => {
    expect(isSupported('page.html')).toBe(true);
  });

  it('returns false for .jpg files', () => {
    expect(isSupported('image.jpg')).toBe(false);
  });

  it('returns false for .exe files', () => {
    expect(isSupported('program.exe')).toBe(false);
  });

  it('returns false for .csv files', () => {
    expect(isSupported('data.csv')).toBe(false);
  });

  it('returns false for .png files', () => {
    expect(isSupported('photo.png')).toBe(false);
  });

  it('returns false for files with no extension', () => {
    expect(isSupported('Makefile')).toBe(false);
  });

  it('handles uppercase extensions (case insensitive)', () => {
    expect(isSupported('file.TXT')).toBe(true);
    expect(isSupported('file.PDF')).toBe(true);
    expect(isSupported('file.MD')).toBe(true);
  });

  it('handles paths with directories', () => {
    expect(isSupported('/some/path/to/file.txt')).toBe(true);
    expect(isSupported('/some/path/to/file.jpg')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSupportedExtension
// ---------------------------------------------------------------------------

describe('isSupportedExtension', () => {
  it('returns true for supported extensions', () => {
    expect(isSupportedExtension('.txt')).toBe(true);
    expect(isSupportedExtension('.md')).toBe(true);
    expect(isSupportedExtension('.pdf')).toBe(true);
    expect(isSupportedExtension('.docx')).toBe(true);
    expect(isSupportedExtension('.html')).toBe(true);
  });

  it('returns false for unsupported extensions', () => {
    expect(isSupportedExtension('.jpg')).toBe(false);
    expect(isSupportedExtension('.xlsx')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getSupportedExtensions
// ---------------------------------------------------------------------------

describe('getSupportedExtensions', () => {
  it('returns the correct list of supported extensions', () => {
    const extensions = getSupportedExtensions();
    expect(extensions).toContain('.txt');
    expect(extensions).toContain('.md');
    expect(extensions).toContain('.pdf');
    expect(extensions).toContain('.docx');
    expect(extensions).toContain('.html');
    expect(extensions).toHaveLength(5);
  });

  it('returns a new array each time (not the internal reference)', () => {
    const a = getSupportedExtensions();
    const b = getSupportedExtensions();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// extractText
// ---------------------------------------------------------------------------

describe('extractText', () => {
  it('reads .txt files directly', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'Hello from a text file', 'utf-8');

    const text = await extractText(filePath);
    expect(text).toBe('Hello from a text file');
  });

  it('reads .md files directly', async () => {
    const filePath = path.join(tmpDir, 'readme.md');
    const content = '# Title\n\nSome **markdown** content.';
    fs.writeFileSync(filePath, content, 'utf-8');

    const text = await extractText(filePath);
    expect(text).toBe(content);
  });

  it('preserves UTF-8 content in text files', async () => {
    const filePath = path.join(tmpDir, 'unicode.txt');
    const content = 'Greek: Ελληνικά, Japanese: 日本語, Emoji: ✨';
    fs.writeFileSync(filePath, content, 'utf-8');

    const text = await extractText(filePath);
    expect(text).toBe(content);
  });

  it('throws ExtractionError for non-existent files', async () => {
    const filePath = path.join(tmpDir, 'nonexistent.txt');
    await expect(extractText(filePath)).rejects.toThrow('File not found');
  });

  it('throws ExtractionError for unsupported file types', async () => {
    const filePath = path.join(tmpDir, 'image.jpg');
    fs.writeFileSync(filePath, 'not really an image', 'utf-8');

    await expect(extractText(filePath)).rejects.toThrow('Unsupported file type');
  });

  it('reads empty .txt files', async () => {
    const filePath = path.join(tmpDir, 'empty.txt');
    fs.writeFileSync(filePath, '', 'utf-8');

    const text = await extractText(filePath);
    expect(text).toBe('');
  });
});
