import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

import {
  chunkText,
  makeChunkId,
  generateChunkId,
  makeSingleDocId,
} from '../../src/lib/chunker.js';

describe('chunkText', () => {
  it('returns empty array for empty text', () => {
    const result = chunkText('');
    expect(result).toEqual([]);
  });

  it('returns single chunk when text is shorter than chunkSize', () => {
    const text = 'Hello world';
    const result = chunkText(text, { chunkSize: 100, chunkOverlap: 10 });
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Hello world');
    expect(result[0].index).toBe(0);
    expect(result[0].startOffset).toBe(0);
    expect(result[0].endOffset).toBe(text.length);
  });

  it('returns single chunk when text equals chunkSize', () => {
    const text = 'a'.repeat(100);
    const result = chunkText(text, { chunkSize: 100, chunkOverlap: 10 });
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(text);
  });

  it('splits text into multiple overlapping chunks', () => {
    // Create text long enough to require multiple chunks.
    // Use simple words without sentence boundaries so we get word-boundary splits.
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    const chunkSize = 50;
    const chunkOverlap = 10;

    const result = chunkText(text, { chunkSize, chunkOverlap });

    expect(result.length).toBeGreaterThan(1);

    // Verify indexes are sequential
    for (let i = 0; i < result.length; i++) {
      expect(result[i].index).toBe(i);
    }

    // Verify every chunk is non-empty
    for (const chunk of result) {
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it('detects sentence boundaries when splitting', () => {
    // Build text with clear sentence boundaries
    const sentence1 = 'This is the first sentence.';
    const sentence2 = ' This is the second sentence.';
    const sentence3 = ' This is the third sentence that is quite long.';
    const text = sentence1 + sentence2 + sentence3;

    // chunkSize such that at least sentence1 + sentence2 fit, but not all three
    const chunkSize = sentence1.length + sentence2.length + 5;
    const result = chunkText(text, { chunkSize, chunkOverlap: 5 });

    expect(result.length).toBeGreaterThan(1);

    // First chunk should end at a sentence boundary (after the period + space)
    // It should NOT cut in the middle of a word
    const firstChunk = result[0].text;
    // The chunk should end with a sentence boundary
    expect(firstChunk).toMatch(/[.!?]\s*$/);
  });

  it('throws InvalidArgumentError when chunkOverlap >= chunkSize', () => {
    expect(() =>
      chunkText('some text', { chunkSize: 10, chunkOverlap: 10 }),
    ).toThrow('chunkOverlap (10) must be less than chunkSize (10)');

    expect(() =>
      chunkText('some text', { chunkSize: 10, chunkOverlap: 15 }),
    ).toThrow('chunkOverlap (15) must be less than chunkSize (10)');
  });

  it('returns single chunk when noChunking is true regardless of text length', () => {
    const text = 'a'.repeat(5000);
    const result = chunkText(text, {
      chunkSize: 100,
      chunkOverlap: 10,
      noChunking: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(text);
    expect(result[0].index).toBe(0);
    expect(result[0].startOffset).toBe(0);
    expect(result[0].endOffset).toBe(text.length);
  });

  it('uses default chunkSize=1000 and chunkOverlap=200', () => {
    // Text longer than 1000 chars should be chunked
    const text = 'a'.repeat(1500);
    const result = chunkText(text);
    expect(result.length).toBeGreaterThan(1);
  });

  it('handles text with only whitespace (returns single chunk preserving text)', () => {
    const text = '   ';
    const result = chunkText(text, { chunkSize: 100, chunkOverlap: 10 });
    expect(result).toHaveLength(1);
    // Single-chunk path preserves text as-is (trim only applies in multi-chunk loop)
    expect(result[0].text).toBe('   ');
    expect(result[0].index).toBe(0);
  });

  it('produces chunks covering the full text', () => {
    const text = 'a'.repeat(300);
    const result = chunkText(text, { chunkSize: 100, chunkOverlap: 20 });

    // Verify each character of the original text appears in at least one chunk
    // by checking that start/end offsets collectively cover [0, text.length)
    const covered = new Set<number>();
    for (const chunk of result) {
      for (let i = chunk.startOffset; i < chunk.endOffset; i++) {
        covered.add(i);
      }
    }
    for (let i = 0; i < text.length; i++) {
      expect(covered.has(i)).toBe(true);
    }
  });
});

describe('makeChunkId', () => {
  it('generates ID in format absolutePath::chunk-index', () => {
    const id = makeChunkId('relative/path/file.txt', 3);
    const expected = `${resolve('relative/path/file.txt')}::chunk-3`;
    expect(id).toBe(expected);
  });

  it('resolves relative paths to absolute', () => {
    const id = makeChunkId('./doc.md', 0);
    expect(id).toContain('::chunk-0');
    // Should be an absolute path (starts with /)
    expect(id.startsWith('/')).toBe(true);
  });
});

describe('generateChunkId', () => {
  it('appends chunk index to the base ID', () => {
    const id = generateChunkId('/abs/path/file.pdf', 5);
    expect(id).toBe('/abs/path/file.pdf::chunk-5');
  });

  it('works with any base string', () => {
    const id = generateChunkId('custom-id', 0);
    expect(id).toBe('custom-id::chunk-0');
  });
});

describe('makeSingleDocId', () => {
  it('resolves path to absolute', () => {
    const id = makeSingleDocId('relative/file.txt');
    expect(id).toBe(resolve('relative/file.txt'));
    expect(id.startsWith('/')).toBe(true);
  });

  it('returns unchanged absolute path', () => {
    const id = makeSingleDocId('/absolute/path/file.md');
    expect(id).toBe('/absolute/path/file.md');
  });
});
