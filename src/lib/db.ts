import {
  ChromaClient,
  IncludeEnum,
} from 'chromadb';
import type { Collection, IEmbeddingFunction } from 'chromadb';
import {
  ChromaDBError,
  CollectionNotFoundError,
} from './errors.js';

/**
 * No-op embedding function for collections managed by chromactl.
 * ChromaDB's getCollection requires an IEmbeddingFunction, but chromactl
 * manages embeddings externally via EmbeddingManager. This stub satisfies
 * the type requirement without triggering any model downloads or computation.
 */
export const noopEmbeddingFunction: IEmbeddingFunction = {
  generate: async () => [],
};

/**
 * Create and return a ChromaClient connected to the given host:port.
 */
export function createChromaClient(host: string, port: number): ChromaClient {
  return new ChromaClient({ path: `http://${host}:${port}` });
}

/**
 * Return list of collection names.
 */
export async function listCollections(client: ChromaClient): Promise<string[]> {
  try {
    return await client.listCollections();
  } catch (error) {
    throw wrapChromaError(error, 'Failed to list collections');
  }
}

/**
 * Create a new collection (no embedding function -- we manage embeddings ourselves).
 */
export async function createCollection(
  client: ChromaClient,
  name: string,
): Promise<void> {
  try {
    await client.createCollection({ name });
  } catch (error) {
    throw wrapChromaError(error, `Failed to create collection '${name}'`);
  }
}

/**
 * Get or create a collection without an embedding function.
 * Collections are always created without an embeddingFunction because
 * chromactl manages embeddings via EmbeddingManager.
 */
export async function getOrCreateCollection(
  client: ChromaClient,
  name: string,
): Promise<Collection> {
  try {
    return await client.getOrCreateCollection({ name });
  } catch (error) {
    throw wrapChromaError(error, `Failed to get or create collection '${name}'`);
  }
}

/**
 * Delete a collection by name.
 */
export async function deleteCollection(
  client: ChromaClient,
  name: string,
): Promise<void> {
  try {
    await client.deleteCollection({ name });
  } catch (error) {
    if (isChromaNotFound(error)) {
      throw new CollectionNotFoundError(name);
    }
    throw wrapChromaError(error, `Failed to delete collection '${name}'`);
  }
}

/**
 * Get collection name, document count, and metadata.
 */
export async function getCollectionInfo(
  client: ChromaClient,
  name: string,
): Promise<{ name: string; count: number; metadata: Record<string, unknown> }> {
  let collection: Collection;
  try {
    collection = await client.getCollection({ name } as Parameters<typeof client.getCollection>[0]);
  } catch (error) {
    if (isChromaNotFound(error)) {
      throw new CollectionNotFoundError(name);
    }
    throw wrapChromaError(error, `Failed to get collection '${name}'`);
  }

  const count = await collection.count();
  return {
    name: collection.name,
    count,
    metadata: (collection.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * Add/upsert documents with pre-computed embeddings into a collection.
 */
export async function addDocuments(
  collection: Collection,
  params: {
    ids: string[];
    documents: string[];
    metadatas: Record<string, string | number | boolean>[];
    embeddings: number[][];
  },
): Promise<void> {
  try {
    await collection.upsert({
      ids: params.ids,
      documents: params.documents,
      metadatas: params.metadatas,
      embeddings: params.embeddings,
    });
  } catch (error) {
    throw wrapChromaError(error, 'Failed to add documents');
  }
}

/**
 * Query a collection with pre-computed query embeddings.
 */
export async function queryCollection(
  collection: Collection,
  params: {
    queryEmbeddings: number[][];
    nResults: number;
    where?: Record<string, unknown>;
    include?: string[];
  },
): Promise<{
  ids: string[];
  documents: (string | null)[];
  metadatas: (Record<string, string | number | boolean> | null)[];
  distances: number[];
}> {
  try {
    const includeEnums = params.include
      ? params.include.map(toIncludeEnum)
      : [IncludeEnum.Documents, IncludeEnum.Metadatas, IncludeEnum.Distances];

    const response = await collection.query({
      queryEmbeddings: params.queryEmbeddings,
      nResults: params.nResults,
      where: params.where as Record<string, unknown> | undefined,
      include: includeEnums,
    });

    // ChromaDB returns MultiQueryResponse with nested arrays (one per query).
    // Extract the first query's results.
    const ids = response.ids[0] ?? [];
    const documents = response.documents[0] ?? [];
    const metadatas = response.metadatas[0] ?? [];
    const distances = response.distances?.[0] ?? [];

    return {
      ids,
      documents,
      metadatas: metadatas as (Record<string, string | number | boolean> | null)[],
      distances,
    };
  } catch (error) {
    throw wrapChromaError(error, 'Failed to query collection');
  }
}

/**
 * Get documents from a collection.
 */
export async function getCollectionDocuments(
  collection: Collection,
  params?: {
    where?: Record<string, unknown>;
    limit?: number;
    include?: string[];
  },
): Promise<{
  ids: string[];
  documents: (string | null)[];
  metadatas: (Record<string, string | number | boolean> | null)[];
}> {
  try {
    const includeEnums = params?.include
      ? params.include.map(toIncludeEnum)
      : [IncludeEnum.Metadatas];

    const response = await collection.get({
      where: params?.where as Record<string, unknown> | undefined,
      limit: params?.limit,
      include: includeEnums,
    });

    return {
      ids: response.ids,
      documents: response.documents,
      metadatas: response.metadatas as (Record<string, string | number | boolean> | null)[],
    };
  } catch (error) {
    throw wrapChromaError(error, 'Failed to get collection documents');
  }
}

/**
 * Convert L2 distance to similarity score: 1 / (1 + distance).
 */
export function distanceToSimilarity(distance: number): number {
  return 1 / (1 + distance);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a string include value to the chromadb IncludeEnum.
 */
function toIncludeEnum(value: string): IncludeEnum {
  switch (value) {
    case 'documents':
      return IncludeEnum.Documents;
    case 'embeddings':
      return IncludeEnum.Embeddings;
    case 'metadatas':
      return IncludeEnum.Metadatas;
    case 'distances':
      return IncludeEnum.Distances;
    default:
      return value as IncludeEnum;
  }
}

/**
 * Check if an error is a ChromaDB "not found" error.
 */
function isChromaNotFound(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.constructor.name === 'ChromaNotFoundError' ||
      error.message.toLowerCase().includes('not found') ||
      error.message.toLowerCase().includes('does not exist')
    );
  }
  return false;
}

/**
 * Wrap a ChromaDB error in a ChromaDBError for consistent error handling.
 * Passes through errors that are already chromactl error classes.
 */
function wrapChromaError(error: unknown, context: string): Error {
  if (error instanceof ChromaDBError || error instanceof CollectionNotFoundError) {
    return error;
  }

  if (error instanceof Error) {
    // Check for connection errors
    if (
      error.constructor.name === 'ChromaConnectionError' ||
      error.message.includes('ECONNREFUSED') ||
      error.message.includes('fetch failed')
    ) {
      return new ChromaDBError(
        `${context}: ${error.message}`,
        "Ensure the ChromaDB server is running. Run 'chromactl server start'.",
      );
    }

    return new ChromaDBError(`${context}: ${error.message}`);
  }

  return new ChromaDBError(`${context}: ${String(error)}`);
}
