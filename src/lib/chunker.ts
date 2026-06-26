import { resolve } from 'node:path';

import type { TextChunk } from '../types/index.js';
import { InvalidArgumentError } from './errors.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChunkOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  noChunking?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split text into overlapping chunks with intelligent boundary detection.
 *
 * If text is empty, returns an empty array.
 * If text.length <= chunkSize or noChunking is true, returns a single chunk.
 *
 * Boundary detection prefers (in order):
 *   1. Sentence boundary (. ! ? followed by whitespace) within the chunk
 *   2. Word boundary (whitespace) within the chunk
 *   3. Hard cut at chunkSize (fallback)
 *
 * @throws {InvalidArgumentError} if chunkOverlap >= chunkSize
 */
export function chunkText(text: string, options?: ChunkOptions): TextChunk[] {
  const chunkSize = options?.chunkSize ?? 1000;
  const chunkOverlap = options?.chunkOverlap ?? 200;
  const noChunking = options?.noChunking ?? false;

  if (chunkOverlap >= chunkSize) {
    throw new InvalidArgumentError(
      `chunkOverlap (${chunkOverlap}) must be less than chunkSize (${chunkSize})`,
    );
  }

  // Empty text -> empty array
  if (text.length === 0) {
    return [];
  }

  // Single-chunk cases
  if (noChunking || text.length <= chunkSize) {
    return [
      {
        text,
        index: 0,
        startOffset: 0,
        endOffset: text.length,
      },
    ];
  }

  const chunks: TextChunk[] = [];
  let offset = 0;
  let index = 0;

  while (offset < text.length) {
    let end = Math.min(offset + chunkSize, text.length);

    if (end < text.length) {
      // Try to find a good break point within the candidate text
      const candidateText = text.slice(offset, end);

      // Strategy 1: Last sentence boundary (past halfway point)
      const sentenceBreak = findLastSentenceBoundary(candidateText);
      if (sentenceBreak > chunkSize * 0.5) {
        end = offset + sentenceBreak;
      } else {
        // Strategy 2: Last word boundary (past 30% point)
        const wordBreak = candidateText.lastIndexOf(' ');
        if (wordBreak > chunkSize * 0.3) {
          end = offset + wordBreak + 1; // Include the space
        }
        // Strategy 3: Hard cut at chunkSize (fallback -- end stays as-is)
      }
    }

    const chunkText = text.slice(offset, end);

    chunks.push({
      text: chunkText.trim(),
      index,
      startOffset: offset,
      endOffset: end,
    });

    index++;

    // Advance with overlap
    const nextOffset = end - chunkOverlap;

    // Ensure forward progress: if nextOffset hasn't moved past the
    // current chunk's start, jump to end instead.
    if (nextOffset <= offset) {
      offset = end;
    } else {
      offset = nextOffset;
    }

    if (offset >= text.length) {
      break;
    }
  }

  return chunks;
}

/**
 * Generate a ChromaDB document ID for a specific chunk.
 * Format: <absolutePath>::chunk-<index>
 */
export function makeChunkId(filePath: string, chunkIndex: number): string {
  return `${resolve(filePath)}::chunk-${chunkIndex}`;
}

/**
 * Generate a chunk ID from a base identifier and chunk index.
 * Format: <baseId>::chunk-<index>
 *
 * This is an alias-compatible form that accepts any base ID string
 * (typically an absolute file path).
 */
export function generateChunkId(baseId: string, chunkIndex: number): string {
  return `${baseId}::chunk-${chunkIndex}`;
}

/**
 * Generate a ChromaDB document ID for an unchunked document.
 * Format: <absolutePath>
 */
export function makeSingleDocId(filePath: string): string {
  return resolve(filePath);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Scan backward from end of text looking for a sentence boundary:
 * `.`, `!`, or `?` followed by whitespace or end-of-string.
 *
 * Returns the offset immediately after the sentence-ending punctuation
 * and its trailing whitespace, or -1 if no boundary found.
 */
function findLastSentenceBoundary(text: string): number {
  // Walk backward through the string looking for sentence-ending punctuation
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '.' || ch === '!' || ch === '?') {
      // Check if it's followed by whitespace or is at the very end
      const nextIdx = i + 1;
      if (nextIdx >= text.length || /\s/.test(text[nextIdx])) {
        // Find the position after the trailing whitespace
        let pos = nextIdx;
        while (pos < text.length && /\s/.test(text[pos])) {
          pos++;
        }
        return pos;
      }
    }
  }

  return -1;
}
