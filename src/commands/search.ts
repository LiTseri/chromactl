import { Command } from 'commander';
import path from 'node:path';
import { ChromaClient, IncludeEnum } from 'chromadb';

import type {
  GlobalOptions,
  SearchOptions,
  SearchResult,
  ChromactlConfig,
} from '../types/index.js';
import { Formatter, createFormatter } from '../lib/output.js';
import { resolveConfig, getDbPath, getProjectDir } from '../lib/config.js';
import { ServerManager } from '../lib/server.js';
import { EmbeddingManager } from '../lib/embedding.js';
import { InvalidArgumentError, CollectionNotFoundError } from '../lib/errors.js';
import { distanceToSimilarity, noopEmbeddingFunction } from '../lib/db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve command context: config, server, formatter.
 */
async function resolveCommandContext(
  cmd: Command,
): Promise<{
  formatter: Formatter;
  client: ChromaClient;
  config: ChromactlConfig;
  projectDir: string;
}> {
  const opts = cmd.optsWithGlobals<GlobalOptions>();
  const formatter = createFormatter({
    json: opts.json,
    quiet: opts.quiet,
    verbose: opts.verbose,
  });

  const { configPath, config } = resolveConfig({
    db: opts.db,
    requireExisting: true,
  });

  const configDir = path.dirname(configPath);
  const projectDir = getProjectDir(configPath);

  const serverManager = new ServerManager({
    projectRoot: configDir,
    persistPath: getDbPath(config, configDir),
    port: config.port,
    host: config.host,
  });

  const client = await serverManager.ensureRunning();

  return { formatter, client, config, projectDir };
}

/**
 * Truncate text to a specified length, appending "..." if truncated.
 */
function makeSnippet(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength).trimEnd() + '...';
}

/**
 * Extract metadata fields, excluding auto-generated fields that are
 * represented as top-level SearchResult properties.
 */
function extractUserMetadata(
  metadata: Record<string, string | number | boolean> | null,
): Record<string, string | number | boolean> {
  if (!metadata) return {};

  const autoFields = new Set([
    'source_path',
    'file_type',
    'indexed_at',
    'file_size_bytes',
    'content_length',
    'chunk_index',
  ]);

  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!autoFields.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Search Action
// ---------------------------------------------------------------------------

async function searchAction(
  query: string,
  options: SearchOptions,
  cmd: Command,
): Promise<void> {
  const { formatter, client, config, projectDir } = await resolveCommandContext(cmd);

  // Parse options
  const nResults = options.results ? parseInt(options.results, 10) : 5;
  if (isNaN(nResults) || nResults < 1) {
    throw new InvalidArgumentError(
      'Number of results must be a positive integer.',
      'Example: --results 10',
    );
  }
  if (nResults > 50) {
    throw new InvalidArgumentError(
      'Maximum number of results is 50.',
      'Use --results with a value between 1 and 50.',
    );
  }

  const snippetLength = options.snippetLength ? parseInt(options.snippetLength, 10) : 200;
  if (isNaN(snippetLength) || snippetLength < 1) {
    throw new InvalidArgumentError(
      'Snippet length must be a positive integer.',
    );
  }

  let minScore: number | undefined;
  if (options.minScore) {
    minScore = parseFloat(options.minScore);
    if (isNaN(minScore) || minScore < 0 || minScore > 1) {
      throw new InvalidArgumentError(
        'Minimum score must be a number between 0.0 and 1.0.',
        'Example: --min-score 0.5',
      );
    }
  }

  let whereFilter: Record<string, unknown> | undefined;
  if (options.filter) {
    try {
      whereFilter = JSON.parse(options.filter) as Record<string, unknown>;
    } catch (err) {
      throw new InvalidArgumentError(
        `Invalid filter JSON: ${(err as Error).message}`,
        'Example: --filter \'{"author":"Smith"}\'',
      );
    }
  }

  // Resolve collection
  const collectionName = options.collection ?? config.defaultCollection;

  let collection;
  try {
    collection = await client.getCollection({
      name: collectionName,
      embeddingFunction: noopEmbeddingFunction,
    });
  } catch {
    throw new CollectionNotFoundError(collectionName);
  }

  // Embed the query
  formatter.verbose(`Embedding query: "${query}"`);
  const embeddingManager = EmbeddingManager.getInstance();
  embeddingManager.setCacheDir(path.join(projectDir, 'models'));
  const queryEmbedding = await embeddingManager.embedSingle(query);

  // Query the collection
  formatter.verbose(
    `Querying collection "${collectionName}" for ${nResults} results...`,
  );

  const queryParams: {
    queryEmbeddings: number[];
    nResults: number;
    where?: Record<string, unknown>;
    include: IncludeEnum[];
  } = {
    queryEmbeddings: queryEmbedding,
    nResults,
    include: [
      IncludeEnum.Documents,
      IncludeEnum.Metadatas,
      IncludeEnum.Distances,
    ],
  };

  if (whereFilter) {
    queryParams.where = whereFilter;
  }

  const queryResponse = await collection.query(queryParams);

  // Extract results from the nested MultiQueryResponse (index [0] for single query)
  const resultIds = queryResponse.ids[0] ?? [];
  const resultDocuments = queryResponse.documents[0] ?? [];
  const resultMetadatas = queryResponse.metadatas[0] ?? [];
  const resultDistances = (queryResponse.distances?.[0]) ?? [];

  if (resultIds.length === 0) {
    if (formatter.isJson) {
      formatter.json([]);
    } else {
      formatter.info('No results found.');
    }
    return;
  }

  // Build SearchResult array
  const searchResults: SearchResult[] = [];

  for (let i = 0; i < resultIds.length; i++) {
    const distance = resultDistances[i] ?? 0;
    const similarity = distanceToSimilarity(distance);

    // Apply min-score filter
    if (minScore !== undefined && similarity < minScore) {
      continue;
    }

    const metadata = resultMetadatas[i] as Record<string, string | number | boolean> | null;
    const document = resultDocuments[i] ?? '';

    const sourcePath = metadata?.['source_path'] as string ?? 'unknown';
    const chunkIndex = metadata?.['chunk_index'] as number | undefined;

    const searchResult: SearchResult = {
      rank: searchResults.length + 1,
      similarity: Math.round(similarity * 10000) / 10000,
      sourcePath,
      chunkIndex,
      snippet: options.fullText ? document : makeSnippet(document, snippetLength),
      metadata: extractUserMetadata(metadata),
    };

    if (options.fullText) {
      searchResult.fullText = document;
    }

    searchResults.push(searchResult);
  }

  // Output results
  if (formatter.isJson) {
    formatter.json(searchResults);
    return;
  }

  if (searchResults.length === 0) {
    formatter.info('No results matched the minimum score threshold.');
    return;
  }

  formatter.info(`Found ${searchResults.length} result(s):\n`);

  for (const result of searchResults) {
    const chunkLabel = result.chunkIndex !== undefined
      ? `  chunk ${result.chunkIndex}`
      : '';

    formatter.raw(
      `[${result.rank}] (${result.similarity.toFixed(4)}) ${result.sourcePath}${chunkLabel}`,
    );

    // Show text (snippet or full)
    const textToShow = options.fullText && result.fullText
      ? result.fullText
      : result.snippet;

    // Indent the text for readability
    const indented = textToShow
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    formatter.raw(indented);

    // Show user metadata
    const metaEntries = Object.entries(result.metadata);
    if (metaEntries.length > 0) {
      const metaStr = metaEntries
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ');
      formatter.raw(`    [${metaStr}]`);
    }

    formatter.raw('');
  }
}

// ---------------------------------------------------------------------------
// Register Command
// ---------------------------------------------------------------------------

export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .argument('<query>', 'Search query text')
    .description('Search documents by semantic similarity')
    .option('--collection <name>', 'Target collection (default: from config)')
    .option('-n, --results <number>', 'Number of results (default: 5, max: 50)')
    .option('--filter <json>', 'Metadata filter as JSON (ChromaDB where clause)')
    .option('--min-score <number>', 'Minimum similarity score (0.0 to 1.0)')
    .option('--snippet-length <number>', 'Snippet length in characters (default: 200)')
    .option('--full-text', 'Show full document text instead of snippet')
    .addHelpText(
      'after',
      `
Examples:
  $ chromactl search "machine learning techniques"
  $ chromactl search "neural networks" -n 10 --collection papers
  $ chromactl search "deep learning" --filter '{"author":"Smith"}'
  $ chromactl search "query" --json | jq .`,
    )
    .action(searchAction);
}
