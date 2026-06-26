# ChromaDB JavaScript/TypeScript Client API Reference

> **Package:** `chromadb` (npm)
> **Current Version:** 3.4.3 (as of June 2026)
> **Server Compatibility:** ChromaDB server v1.x
> **Language:** TypeScript / JavaScript (ESM and CJS)

---

## Table of Contents

1. [Installation](#1-installation)
2. [Client Initialization](#2-client-initialization)
3. [Collection Management](#3-collection-management)
   - [createCollection](#createcollection)
   - [getOrCreateCollection](#getorcreatecollection)
   - [getCollection](#getcollection)
   - [listCollections](#listcollections)
   - [listCollectionsAndMetadata](#listcollectionsandmetadata)
   - [countCollections](#countcollections)
   - [deleteCollection](#deletecollection)
4. [Document Operations](#4-document-operations)
   - [collection.add()](#collectionadd)
   - [collection.upsert()](#collectionupsert)
   - [collection.update()](#collectionupdate)
   - [collection.delete()](#collectiondelete)
5. [Query Operations](#5-query-operations)
   - [collection.query()](#collectionquery)
   - [collection.get()](#collectionget)
   - [collection.count()](#collectioncount)
   - [collection.peek()](#collectionpeek)
6. [Where Filter Syntax](#6-where-filter-syntax)
   - [Comparison Operators](#comparison-operators)
   - [Logical Operators](#logical-operators)
   - [Set Operators](#set-operators)
   - [Array Metadata Operators](#array-metadata-operators)
   - [WhereDocument Filters](#wheredocument-filters)
   - [Combining Filters](#combining-where-and-wheredocument)
7. [Metadata Types](#7-metadata-types)
8. [Include Options](#8-include-options)
9. [Distance-to-Similarity Score Conversion](#9-distance-to-similarity-score-conversion)
10. [Error Handling Patterns](#10-error-handling-patterns)
11. [TypeScript Type Definitions](#11-typescript-type-definitions)
12. [ChromaDB v3.x (npm) vs v2.x Differences](#12-chromadb-v3x-npm-vs-v2x-differences)
13. [References](#13-references)

---

## 1. Installation

```bash
npm install chromadb
# or
pnpm add chromadb
# or
yarn add chromadb
```

The `chromadb` npm package (v3.x) re-exports everything from the internal `@internal/chromadb-core` package. Its only runtime dependency is `semver`.

If you need automatic embedding generation (e.g., using the default sentence transformer), also install:

```bash
npm install @chroma-core/default-embed
```

For other embedding providers, install the corresponding package (e.g., `@chroma-core/openai`, `@chroma-core/cohere`).

---

## 2. Client Initialization

### ChromaClient Constructor

```typescript
import { ChromaClient } from "chromadb";

// Default connection: http://localhost:8000
const client = new ChromaClient();

// Custom connection
const client = new ChromaClient({
  path: "http://localhost:8000",  // Full URL (overrides host/port)
  tenant: "default_tenant",
  database: "default_database",
  fetchOptions: {},               // Additional RequestInit options
  auth: undefined,                // Auth options (token-based, basic, etc.)
});
```

### ChromaClientParams Type

```typescript
type ChromaClientParams = {
  path?: string;           // Base URL, defaults to "http://localhost:8000"
  fetchOptions?: RequestInit;
  auth?: AuthOptions;
  tenant?: string;         // Defaults to "default_tenant"
  database?: string;       // Defaults to "default_database"
};
```

### Constructor with Host/Port (Reference API Docs)

The official reference documentation also shows these constructor parameters for more granular control:

```typescript
const client = new ChromaClient({
  host: "localhost",    // Defaults to "localhost"
  port: 8000,           // Defaults to 8000
  ssl: false,           // Defaults to false
  tenant: "default_tenant",
  database: "default_database",
  headers: {},          // Additional HTTP headers
  fetchOptions: {},     // Additional fetch options
});
```

> **Note:** In the actual source code (v3.x), the constructor uses `path` as the base URL
> (e.g., `"http://localhost:8000"`). The reference docs show `host`/`port`/`ssl` as
> separate parameters. Both patterns are supported -- when `host`/`port`/`ssl` are used,
> they are combined into a URL internally. When `path` is used, it takes precedence.

### CloudClient (for Chroma Cloud)

```typescript
import { CloudClient } from "chromadb";

const client = new CloudClient({
  apiKey: "your-api-key",
  tenant: "your-tenant-id",
  database: "your-database-name",
});

// Or using env vars: CHROMA_API_KEY, CHROMA_TENANT, CHROMA_DATABASE
const client = new CloudClient();
```

### Utility Methods

```typescript
// Check server connectivity
const heartbeat: number = await client.heartbeat();
// Returns nanosecond heartbeat timestamp

// Get server version
const version: string = await client.version();

// Reset database (destructive -- deletes everything)
await client.reset();
```

---

## 3. Collection Management

### createCollection

Creates a new collection. Throws an error if a collection with the same name already exists.

```typescript
type CreateCollectionParams = {
  name: string;
  metadata?: CollectionMetadata;
  embeddingFunction?: IEmbeddingFunction;
  configuration?: CreateCollectionConfiguration;
};

const collection = await client.createCollection({
  name: "my_collection",
});
```

**With metadata and embedding function:**

```typescript
import { OpenAIEmbeddingFunction } from "@chroma-core/openai";

const collection = await client.createCollection({
  name: "my_collection",
  embeddingFunction: new OpenAIEmbeddingFunction({
    apiKey: process.env.OPENAI_API_KEY,
    modelName: "text-embedding-3-small",
  }),
  metadata: {
    description: "Product descriptions for search",
    created: new Date().toISOString(),
  },
});
```

**Without an embedding function (self-managed embeddings):**

```typescript
const collection = await client.createCollection({
  name: "my_collection",
  embeddingFunction: null,
});
```

**With distance metric configuration:**

```typescript
const collection = await client.createCollection({
  name: "my_collection",
  configuration: {
    hnsw: {
      space: "cosine",          // "l2" (default) | "cosine" | "ip"
      ef_construction: 200,     // Build-time candidate list size
    },
  },
});
```

### getOrCreateCollection

Gets an existing collection or creates it if it does not exist. If the collection already exists, extra arguments like `metadata` are **ignored** (they do not overwrite existing values).

```typescript
type GetOrCreateCollectionParams = CreateCollectionParams;

const collection = await client.getOrCreateCollection({
  name: "my_collection",
  metadata: { description: "..." },
});
```

### getCollection

Retrieves an existing collection by name. Throws `ChromaNotFoundError` if it does not exist.

```typescript
type GetCollectionParams = {
  name: string;
  embeddingFunction?: IEmbeddingFunction;
};

const collection = await client.getCollection({
  name: "my_collection",
});

// With explicit embedding function (required for older servers that
// don't store the embedding function config server-side)
const collection = await client.getCollection({
  name: "my_collection",
  embeddingFunction: myEmbeddingFunction,
});
```

### listCollections

Lists all collection names in the current database.

```typescript
type ListCollectionsParams = {
  limit?: PositiveInteger;
  offset?: PositiveInteger;
};

// Returns string[] of collection names
const collectionNames: string[] = await client.listCollections();

// With pagination
const firstBatch = await client.listCollections({ limit: 100 });
const secondBatch = await client.listCollections({ limit: 100, offset: 100 });
```

> **Important:** In the source code (v3.x), `listCollections()` returns `Promise<string[]>` --
> an array of collection name strings only. This is a mapping over the API response that
> extracts `.name` from each collection object.

### listCollectionsAndMetadata

Returns collection names, IDs, and optional metadata.

```typescript
const collections = await client.listCollectionsAndMetadata();
// Returns: Array<{ name: string; id: string; metadata?: CollectionMetadata }>

for (const col of collections) {
  console.log(col.name, col.id, col.metadata);
}
```

### countCollections

Returns the total number of collections.

```typescript
const count: number = await client.countCollections();
```

### deleteCollection

Deletes a collection and all its data. This is **destructive and irreversible**.

```typescript
type DeleteCollectionParams = { name: string };

await client.deleteCollection({ name: "my_collection" });
```

### Collection Name Constraints

- Must be between 3 and 512 characters
- Must start and end with a lowercase letter or digit
- May contain dots, dashes, and underscores in between
- No two consecutive dots allowed
- Cannot be a valid IP address
- Names must be unique within a database

---

## 4. Document Operations

### collection.add()

Adds new records to the collection. Every record requires a unique string `id`. You must provide either `documents`, `embeddings`, or both.

```typescript
type AddRecordsParams = {
  ids: ID | IDs;                    // string | string[]
  embeddings?: Embedding | Embeddings;  // number[] | number[][]
  metadatas?: Metadata | Metadatas;     // Record | Record[]
  documents?: Document | Documents;     // string | string[]
};

// Add with documents (auto-embeds via collection's embedding function)
await collection.add({
  ids: ["id1", "id2", "id3"],
  documents: [
    "This is document one about machine learning",
    "This is document two about natural language processing",
    "This is document three about computer vision",
  ],
  metadatas: [
    { chapter: 1, topic: "ML", published: true },
    { chapter: 2, topic: "NLP", published: true },
    { chapter: 3, topic: "CV", published: false },
  ],
});

// Add with pre-computed embeddings (no embedding function needed)
await collection.add({
  ids: ["id1", "id2"],
  embeddings: [
    [1.1, 2.3, 3.2],
    [4.5, 6.9, 4.4],
  ],
  documents: ["doc1", "doc2"],
  metadatas: [{ source: "web" }, { source: "pdf" }],
});

// Add a single record
await collection.add({
  ids: "single-id",
  documents: "A single document",
  metadatas: { type: "note" },
});
```

**Key behaviors:**
- Duplicate IDs are silently ignored (no error thrown, but the record is not inserted).
- If embeddings are provided with documents, Chroma stores both as-is without re-embedding.
- If only documents are provided, Chroma auto-generates embeddings using the collection's embedding function.
- Embedding dimension mismatch throws an exception.

### collection.upsert()

Inserts new records or updates existing ones. Same parameters as `add()`.

```typescript
type UpsertRecordsParams = AddRecordsParams;

await collection.upsert({
  ids: ["id1", "id2", "id3"],
  embeddings: [
    [1.1, 2.3, 3.2],
    [4.5, 6.9, 4.4],
    [1.1, 2.3, 3.2],
  ],
  metadatas: [
    { chapter: "3", verse: "16" },
    { chapter: "3", verse: "5" },
    { chapter: "29", verse: "11" },
  ],
  documents: ["doc1", "doc2", "doc3"],
});
```

**Behavior:**
| Scenario | upsert behavior |
|----------|----------------|
| ID exists | Updates the record (like `update`) |
| ID does not exist | Creates a new record (like `add`) |

### collection.update()

Updates existing records. Only modifies the fields you provide.

```typescript
type UpdateRecordsParams = {
  ids: ID | IDs;
  embeddings?: Embedding | Embeddings;
  metadatas?: Metadata | Metadatas;
  documents?: Document | Documents;
};

await collection.update({
  ids: ["id1", "id2"],
  documents: ["updated doc1", "updated doc2"],
  metadatas: [
    { chapter: 4, verse: 1 },
    { chapter: 5, verse: 2 },
  ],
});
```

**Key behaviors:**
- If an ID is not found, an error is **logged** (not thrown) and the update for that ID is skipped.
- When documents are updated without embeddings, the embeddings are **recomputed** using the collection's embedding function.
- Embedding dimension mismatch throws an exception.

### collection.delete()

Deletes records from the collection. Can filter by IDs, metadata (`where`), or document content (`whereDocument`).

```typescript
type DeleteParams = {
  ids?: ID | IDs;
  where?: Where;
  whereDocument?: WhereDocument;
};

// Delete by IDs
await collection.delete({
  ids: ["id1", "id2", "id3"],
});

// Delete by metadata filter
await collection.delete({
  where: { chapter: "20" },
});

// Delete by document content
await collection.delete({
  whereDocument: { $contains: "deprecated" },
});

// Combine filters
await collection.delete({
  where: { status: "archived" },
  whereDocument: { $contains: "old" },
});
```

> **Warning:** Deletion is permanent and cannot be undone.

---

## 5. Query Operations

### collection.query()

Performs nearest-neighbor similarity search. Returns results ranked by distance (lower = more similar for L2 and cosine spaces).

```typescript
type QueryRecordsParams = {
  queryTexts?: string | string[];       // Text to search for
  queryEmbeddings?: Embedding | Embeddings; // Direct embedding vectors
  nResults?: PositiveInteger;           // Default: 10
  ids?: ID | IDs;                       // Constrain to specific IDs
  where?: Where;                        // Metadata filter
  whereDocument?: WhereDocument;        // Document content filter
  include?: IncludeEnum[];              // Fields to include in response
};

// Query by text
const results = await collection.query({
  queryTexts: ["What is machine learning?"],
  nResults: 5,
});

// Query by multiple texts (batch query)
const results = await collection.query({
  queryTexts: ["query one", "query two"],
  nResults: 10,
});

// Query by embedding
const results = await collection.query({
  queryEmbeddings: [[1.1, 2.3, 3.2]],
  nResults: 5,
});

// Query with filters
const results = await collection.query({
  queryTexts: ["search term"],
  nResults: 5,
  where: { topic: "ML" },
  whereDocument: { $contains: "neural" },
  include: [IncludeEnum.Documents, IncludeEnum.Metadatas, IncludeEnum.Distances],
});

// Constrain to specific IDs
const results = await collection.query({
  queryTexts: ["search text"],
  nResults: 10,
  ids: ["id1", "id2", "id3"],
});
```

**Return type -- MultiQueryResponse (column-major format, grouped by input query):**

```typescript
type MultiQueryResponse = {
  ids: string[][];                        // ids[queryIndex][resultIndex]
  embeddings: Embeddings[] | null;        // embeddings[queryIndex][resultIndex]
  documents: (string | null)[][];         // documents[queryIndex][resultIndex]
  metadatas: (Metadata | null)[][];       // metadatas[queryIndex][resultIndex]
  distances: number[][] | null;           // distances[queryIndex][resultIndex]
  included: IncludeEnum[];
};
```

**Iterating results:**

```typescript
const results = await collection.query({
  queryTexts: ["first query", "second query"],
});

// Access by index
const firstQueryResults = {
  ids: results.ids[0],
  documents: results.documents[0],
  distances: results.distances?.[0],
};

// Using the rows() helper (if available in your version)
for (const batch of results.rows()) {
  for (const row of batch) {
    console.log(row.id, row.document, row.metadata, row.distance);
  }
}
```

### collection.get()

Retrieves records by ID and/or filters without similarity ranking.

```typescript
type BaseGetParams = {
  ids?: ID | IDs;
  where?: Where;
  limit?: PositiveInteger;
  offset?: PositiveInteger;
  include?: IncludeEnum[];
  whereDocument?: WhereDocument;
};

// Get by IDs
const results = await collection.get({
  ids: ["id1", "id2"],
});

// Get all with pagination
const results = await collection.get({
  limit: 100,
  offset: 0,
});

// Get with metadata filter
const results = await collection.get({
  where: { topic: "ML" },
  limit: 50,
});

// Get with document content filter
const results = await collection.get({
  whereDocument: { $contains: "machine learning" },
  include: [IncludeEnum.Documents, IncludeEnum.Metadatas],
});

// Get everything (no filters)
const results = await collection.get();
```

**Return type -- GetResponse (flat arrays):**

```typescript
type GetResponse = {
  ids: string[];
  embeddings: Embeddings | null;
  documents: (string | null)[];
  metadatas: (Metadata | null)[];
  included: IncludeEnum[];
};
```

**Iterating results:**

```typescript
const results = await collection.get();

// Direct index access
for (let i = 0; i < results.ids.length; i++) {
  console.log(results.ids[i], results.documents[i], results.metadatas[i]);
}

// Using rows() helper
for (const row of results.rows()) {
  console.log(row.id, row.document, row.metadata);
}
```

**TypeScript generics for metadata type inference:**

```typescript
const results = await collection.get<{ page: number; title: string }>({
  ids: ["id1", "id2"],
});

results.rows().forEach((row) => {
  console.log(row.id, row.metadata?.page);  // page is typed as number
});
```

### collection.count()

Returns the total number of records in the collection.

```typescript
const count: number = await collection.count();
console.log(`Collection has ${count} documents`);
```

### collection.peek()

Returns a preview of records (default limit: 10).

```typescript
type PeekParams = { limit?: PositiveInteger };

// Default: first 10 records
const sample = await collection.peek();

// Custom limit
const sample = await collection.peek({ limit: 5 });
```

Returns the same `GetResponse` type as `collection.get()`.

---

## 6. Where Filter Syntax

ChromaDB supports two filter systems: `where` for metadata filtering and `whereDocument` for document content filtering.

### Comparison Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `$eq`    | Equal (default) | `{ field: { $eq: "value" } }` |
| `$ne`    | Not equal | `{ field: { $ne: "value" } }` |
| `$gt`    | Greater than | `{ field: { $gt: 10 } }` |
| `$gte`   | Greater than or equal | `{ field: { $gte: 10 } }` |
| `$lt`    | Less than | `{ field: { $lt: 100 } }` |
| `$lte`   | Less than or equal | `{ field: { $lte: 100 } }` |

```typescript
// Direct equality (shorthand for $eq)
await collection.query({
  queryTexts: ["search"],
  where: { status: "active" },
});

// Explicit $eq (equivalent to above)
await collection.query({
  queryTexts: ["search"],
  where: { status: { $eq: "active" } },
});

// Numeric comparison
await collection.query({
  queryTexts: ["search"],
  where: { page: { $gt: 10 } },
});

// Range query using $and
await collection.query({
  queryTexts: ["search"],
  where: {
    $and: [
      { price: { $gte: 10 } },
      { price: { $lte: 100 } },
    ],
  },
});
```

### Logical Operators

| Operator | Description |
|----------|-------------|
| `$and`   | All conditions must match |
| `$or`    | Any condition can match |

```typescript
// $and -- all conditions must match
await collection.query({
  queryTexts: ["search"],
  where: {
    $and: [
      { page: { $gte: 5 } },
      { page: { $lte: 10 } },
    ],
  },
});

// $or -- any condition can match
await collection.get({
  where: {
    $or: [
      { color: "red" },
      { color: "blue" },
    ],
  },
});

// Nested logical operators
await collection.get({
  where: {
    $and: [
      {
        $or: [
          { category: "tech" },
          { category: "science" },
        ],
      },
      { published: true },
    ],
  },
});
```

### Set Operators

| Operator | Description |
|----------|-------------|
| `$in`    | Value is in the provided list |
| `$nin`   | Value is not in the provided list (also matches if key is absent) |

```typescript
// $in -- matches any value in the list
await collection.get({
  where: { author: { $in: ["Rowling", "Fitzgerald", "Herbert"] } },
});

// $nin -- excludes values in the list
await collection.get({
  where: { status: { $nin: ["draft", "deleted"] } },
});
```

### Array Metadata Operators

Chroma supports metadata values that are arrays (of strings, numbers, or booleans). These can be filtered with `$contains` and `$not_contains`.

```typescript
// Adding documents with array metadata
await collection.add({
  ids: ["m1", "m2", "m3"],
  embeddings: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  metadatas: [
    { genres: ["action", "comedy"], year: 2020 },
    { genres: ["drama"], year: 2021 },
    { genres: ["action", "thriller"], year: 2022 },
  ],
});

// Filter by array contents
await collection.get({
  where: { genres: { $contains: "action" } },
});

await collection.get({
  where: { genres: { $not_contains: "action" } },
});

// Combine with other filters
await collection.get({
  where: {
    $and: [
      { genres: { $contains: "action" } },
      { year: { $gte: 2021 } },
    ],
  },
});
```

**Array constraints:**
- All elements must be the same type (string, int, float, or boolean)
- Empty arrays are not allowed
- Nesting is not supported

### WhereDocument Filters

Filter by document content using `whereDocument`.

| Operator | Description |
|----------|-------------|
| `$contains` | Document contains the specified string (case-sensitive) |
| `$not_contains` | Document does not contain the string |
| `$regex` | Document matches the regex pattern |
| `$not_regex` | Document does not match the regex pattern |

```typescript
// Contains
await collection.get({
  whereDocument: { $contains: "machine learning" },
});

// Not contains
await collection.get({
  whereDocument: { $not_contains: "deprecated" },
});

// Regex
await collection.get({
  whereDocument: {
    $regex: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$",
  },
});

// Logical operators within whereDocument
await collection.query({
  queryTexts: ["search"],
  whereDocument: {
    $and: [
      { $contains: "neural" },
      { $regex: "[a-z]+" },
    ],
  },
});

await collection.query({
  queryTexts: ["search"],
  whereDocument: {
    $or: [
      { $contains: "machine learning" },
      { $not_contains: "deprecated" },
    ],
  },
});
```

### Combining where and whereDocument

Both `query()` and `get()` support using `where` and `whereDocument` simultaneously:

```typescript
await collection.query({
  queryTexts: ["doc10", "thus spake zarathustra"],
  nResults: 10,
  where: { metadata_field: "is_equal_to_this" },
  whereDocument: { $contains: "search_string" },
});
```

### K() Expression Builder (New in v3.x)

ChromaDB v3.x also provides a type-safe `K()` factory function for building where filters:

```typescript
import { K } from "chromadb";

// Metadata comparisons
K("category").eq("tech");
K("year").gte(2020);
K("price").gt(100);
K("count").ne(0);
K("stock").lt(10);
K("discount").lte(0.25);

// Set operators
K("category").isIn(["tech", "ai"]);
K("status").notIn(["draft", "deleted"]);

// Array operators
K("tags").contains("action");
K("tags").notContains("draft");

// Document filters
K.DOCUMENT.contains("search string");
K.DOCUMENT.notContains("deprecated");
K.DOCUMENT.regex("^quantum\\s+\\w+");
K.DOCUMENT.notRegex("^draft");

// ID filtering
K.ID.isIn(["id1", "id2"]);

// Logical composition
K("status").eq("active").and(K("year").gte(2020));
K("status").eq("draft").or(K("status").eq("archived"));
```

---

## 7. Metadata Types

### Supported Types

Metadata values can be:
- **string** -- `"hello"`
- **number** (integer or float) -- `42`, `3.14`
- **boolean** -- `true`, `false`
- **Arrays** of the above types -- `["a", "b"]`, `[1, 2, 3]`, `[true, false]`

```typescript
type Metadata = Record<string, string | number | boolean>;

// Example metadata
const metadata: Metadata = {
  title: "Introduction to ML",
  chapter: 3,
  published: true,
};
```

### Collection Metadata

Collection-level metadata follows the same type:

```typescript
type CollectionMetadata = Record<string, boolean | number | string>;
```

### Array Metadata Constraints

| Type | Example | Valid |
|------|---------|-------|
| String array | `["a", "b"]` | Yes |
| Integer array | `[1, 2, 3]` | Yes |
| Float array | `[1.5, 2.5]` | Yes |
| Boolean array | `[true, false]` | Yes |
| Mixed types | `["a", 1]` | No -- all elements must be the same type |
| Empty array | `[]` | No -- empty arrays are disallowed |
| Nested arrays | `[["a"]]` | No -- nesting is not supported |

### Metadata Limitations

- Keys must be strings
- Values cannot be `null` or `undefined`
- Objects/nested structures are not supported as values
- There is no schema enforcement -- different records can have different metadata keys

---

## 8. Include Options

The `include` parameter controls which data fields are returned in query and get results. IDs are **always** returned regardless of the include setting.

### IncludeEnum Values

```typescript
enum IncludeEnum {
  Documents = "documents",
  Embeddings = "embeddings",
  Metadatas = "metadatas",
  Distances = "distances",   // Only valid for query(), not get()
  Uris = "uris",
}
```

### Default Includes

| Method | Default includes |
|--------|-----------------|
| `query()` | `["documents", "metadatas", "distances"]` |
| `get()` | `["documents", "metadatas"]` |

### Usage Examples

```typescript
import { IncludeEnum } from "chromadb";

// Query with specific includes
const results = await collection.query({
  queryTexts: ["search text"],
  include: [IncludeEnum.Documents, IncludeEnum.Metadatas, IncludeEnum.Embeddings],
});

// Get with minimal includes
const results = await collection.get({
  include: [IncludeEnum.Documents],
});

// Query requesting distances only
const results = await collection.query({
  queryTexts: ["search text"],
  include: [IncludeEnum.Distances],
});

// Using string literals instead of enum
const results = await collection.query({
  queryTexts: ["search text"],
  include: ["documents", "metadatas", "distances"] as IncludeEnum[],
});
```

> **Note:** Requesting `IncludeEnum.Distances` with `get()` is not valid because `get()`
> does not perform similarity search. Distances are only computed during `query()`.

---

## 9. Distance-to-Similarity Score Conversion

### Distance Metrics

ChromaDB supports three distance metrics, configured at collection creation time via the `space` parameter in HNSW configuration:

| Metric | Config Value | Description | Default |
|--------|-------------|-------------|---------|
| Squared L2 | `"l2"` | Euclidean distance squared | Yes (default) |
| Cosine | `"cosine"` | 1 - cosine_similarity | No |
| Inner Product | `"ip"` | Negative inner product | No |

```typescript
const collection = await client.createCollection({
  name: "cosine_collection",
  configuration: {
    hnsw: {
      space: "cosine",
    },
  },
});
```

### Converting Distance to Similarity

**L2 (Squared Euclidean) Distance:**

L2 distance ranges from 0 (identical) to infinity. Convert to a similarity score in `[0, 1]`:

```typescript
function l2DistanceToSimilarity(distance: number): number {
  return 1 / (1 + distance);
}

// Examples:
// distance = 0    -> similarity = 1.0  (identical)
// distance = 1    -> similarity = 0.5
// distance = 9    -> similarity = 0.1
// distance = 99   -> similarity ~ 0.01
```

**Cosine Distance:**

ChromaDB's cosine distance = `1 - cosine_similarity`. It ranges from 0 (identical direction) to 2 (opposite direction). Convert back to cosine similarity:

```typescript
function cosineDistanceToSimilarity(distance: number): number {
  return 1 - distance;
}

// Examples:
// distance = 0    -> similarity = 1.0   (identical direction)
// distance = 0.5  -> similarity = 0.5
// distance = 1.0  -> similarity = 0.0   (orthogonal)
// distance = 2.0  -> similarity = -1.0  (opposite direction)
```

**Inner Product Distance:**

ChromaDB uses negative inner product as distance. Convert to similarity:

```typescript
function ipDistanceToSimilarity(distance: number): number {
  return -distance;
}

// Lower (more negative) distance = higher similarity
```

### Practical Example

```typescript
const results = await collection.query({
  queryTexts: ["What is machine learning?"],
  nResults: 5,
  include: [IncludeEnum.Documents, IncludeEnum.Distances],
});

// Convert distances to similarity scores
const queryResults = results.ids[0].map((id, i) => ({
  id,
  document: results.documents[0][i],
  distance: results.distances![0][i],
  // For L2 (default):
  similarity: 1 / (1 + results.distances![0][i]),
  // For cosine (if using cosine space):
  // similarity: 1 - results.distances![0][i],
}));

// Sort by similarity (highest first) -- already sorted by distance (lowest first)
console.log(queryResults);
```

### HNSW Tuning Parameters

| Parameter | Default | Modifiable After Creation | Effect |
|-----------|---------|--------------------------|--------|
| `space` | `"l2"` | No | Distance metric |
| `ef_construction` | `100` | No | Build-time quality (higher = better recall, slower build) |
| `ef_search` | `100` | Yes (via `modify()`) | Query-time quality (higher = better recall, slower query) |
| `max_neighbors` | `16` | No | Graph connectivity (higher = more memory, better recall) |
| `num_threads` | CPU count | Yes | Parallel threads for operations |
| `batch_size` | `100` | Yes | Vectors per processing batch |
| `sync_threshold` | `1000` | Yes | When to sync to persistent storage |
| `resize_factor` | `1.2` | Yes | Growth factor on resize |

---

## 10. Error Handling Patterns

### Error Classes

The `chromadb` package exports the following error classes (all extend `Error`):

| Error Class | `.name` Property | When Thrown |
|-------------|-----------------|------------|
| `ChromaError` | *(custom)* | Generic Chroma error (base) |
| `ChromaConnectionError` | `"ChromaConnectionError"` | Server unreachable, network failure |
| `ChromaServerError` | `"ChromaServerError"` | Server-side processing error (5xx) |
| `ChromaClientError` | `"ChromaClientError"` | Bad request from client (4xx) |
| `ChromaUnauthorizedError` | `"ChromaAuthError"` | Missing or invalid authentication |
| `ChromaForbiddenError` | `"ChromaForbiddenError"` | Insufficient permissions |
| `ChromaNotFoundError` | `"ChromaNotFoundError"` | Collection or resource not found |
| `ChromaValueError` | `"ChromaValueError"` | Invalid parameter value |
| `InvalidCollectionError` | `"InvalidCollectionError"` | Invalid collection state or config |
| `InvalidArgumentError` | `"InvalidArgumentError"` | Invalid argument passed to method |
| `ChromaUniqueError` | `"ChromaUniqueError"` | Uniqueness constraint violation |
| `ChromaQuotaExceededError` | `"ChromaQuotaExceededError"` | Quota or rate limit exceeded |

All error constructors accept `(message: string, cause?: unknown)`.

### Error Handling Examples

```typescript
import {
  ChromaClient,
  ChromaConnectionError,
  ChromaNotFoundError,
  ChromaClientError,
  ChromaServerError,
  InvalidCollectionError,
} from "chromadb";

const client = new ChromaClient();

// Handle collection not found
async function getCollectionSafe(name: string) {
  try {
    return await client.getCollection({ name });
  } catch (error) {
    if (error instanceof ChromaNotFoundError) {
      console.error(`Collection "${name}" does not exist`);
      return null;
    }
    throw error;
  }
}

// Handle connection errors
async function connectWithRetry(maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await client.heartbeat();
      console.log("Connected to ChromaDB");
      return;
    } catch (error) {
      if (error instanceof ChromaConnectionError) {
        console.error(`Connection attempt ${i + 1} failed: ${error.message}`);
        if (i < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        }
      } else {
        throw error;
      }
    }
  }
  throw new Error("Failed to connect after retries");
}

// Handle embedding dimension mismatch
async function addDocumentsSafe(collection: any, params: any) {
  try {
    await collection.add(params);
  } catch (error) {
    if (error instanceof ChromaClientError) {
      console.error(`Client error: ${error.message}`);
      // Common cause: embedding dimension mismatch
    } else if (error instanceof ChromaServerError) {
      console.error(`Server error: ${error.message}`);
    }
    throw error;
  }
}

// Comprehensive error handler
async function safeOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ChromaConnectionError) {
      console.error("Cannot reach ChromaDB server");
    } else if (error instanceof ChromaNotFoundError) {
      console.error("Resource not found");
    } else if (error instanceof ChromaClientError) {
      console.error("Invalid request:", error.message);
    } else if (error instanceof ChromaServerError) {
      console.error("Server error:", error.message);
    } else if (error instanceof InvalidCollectionError) {
      console.error("Invalid collection:", error.message);
    }
    throw error;
  }
}
```

### Common Error Scenarios

| Scenario | Error Type | Notes |
|----------|-----------|-------|
| Server is down | `ChromaConnectionError` | Check server URL and port |
| Collection does not exist | `ChromaNotFoundError` | Use `getOrCreateCollection` to avoid |
| Duplicate collection name | `ChromaUniqueError` | Use `getOrCreateCollection` instead of `createCollection` |
| Embedding dimension mismatch | `ChromaClientError` | All embeddings in a collection must have the same dimensions |
| Invalid metadata (null, nested object) | `ChromaClientError` or `ChromaValueError` | Only string/number/boolean allowed |
| Empty where filter `{}` | `ChromaClientError` | Since v0.5.17, empty filters are rejected -- omit the parameter instead |
| Duplicate IDs in `add()` | Silently ignored | The record is not inserted; use `upsert()` to overwrite |
| ID not found in `update()` | Logged warning | Error is logged but not thrown; update is skipped for that ID |

---

## 11. TypeScript Type Definitions

### Core Types

```typescript
// Primitives
type ID = string;
type IDs = string[];
type Embedding = number[];
type Embeddings = Embedding[];
type Document = string;
type Documents = Document[];
type Metadata = Record<string, string | number | boolean>;
type Metadatas = Metadata[];
type PositiveInteger = number;

// Collection metadata
type CollectionMetadata = Record<string, boolean | number | string>;
```

### Filter Types

```typescript
// Where filter types
type LiteralValue = string | number | boolean;
type ListLiteralValue = LiteralValue[];
type WhereOperator = "$gt" | "$gte" | "$lt" | "$lte" | "$ne" | "$eq";
type InclusionOperator = "$in" | "$nin";
type LogicalOperator = "$and" | "$or";

type OperatorExpression = {
  [key in WhereOperator | InclusionOperator | LogicalOperator]?:
    | LiteralValue
    | ListLiteralValue;
};

type BaseWhere = {
  [key: string]: LiteralValue | OperatorExpression;
};

type LogicalWhere = {
  [key in LogicalOperator]?: Where[];
};

type Where = BaseWhere | LogicalWhere;

// WhereDocument filter types
type WhereDocumentOperator = "$contains" | "$not_contains" | LogicalOperator;

type WhereDocument = {
  [key in WhereDocumentOperator]?:
    | LiteralValue
    | number
    | WhereDocument[];
};
```

### Response Types

```typescript
// Get response (flat arrays)
type GetResponse = {
  ids: IDs;
  embeddings: Embeddings | null;
  documents: (Document | null)[];
  metadatas: (Metadata | null)[];
  included: IncludeEnum[];
};

// Query response (nested arrays -- one per input query)
type MultiQueryResponse = {
  ids: IDs[];
  embeddings: Embeddings[] | null;
  documents: (Document | null)[][];
  metadatas: (Metadata | null)[][];
  distances: number[][] | null;
  included: IncludeEnum[];
};

// Include enum
enum IncludeEnum {
  Documents = "documents",
  Embeddings = "embeddings",
  Metadatas = "metadatas",
  Distances = "distances",
  Uris = "uris",
}
```

### Parameter Types

```typescript
// Client parameters
type ChromaClientParams = {
  path?: string;
  fetchOptions?: RequestInit;
  auth?: AuthOptions;
  tenant?: string;
  database?: string;
};

// Collection CRUD parameters
type CreateCollectionParams = {
  name: string;
  metadata?: CollectionMetadata;
  embeddingFunction?: IEmbeddingFunction;
  configuration?: CreateCollectionConfiguration;
};

type GetOrCreateCollectionParams = CreateCollectionParams;
type GetCollectionParams = { name: string; embeddingFunction?: IEmbeddingFunction };
type DeleteCollectionParams = { name: string };
type ListCollectionsParams = { limit?: PositiveInteger; offset?: PositiveInteger };

// Record operation parameters
type AddRecordsParams = {
  ids: ID | IDs;
  embeddings?: Embedding | Embeddings;
  metadatas?: Metadata | Metadatas;
  documents?: Document | Documents;
};

type UpsertRecordsParams = AddRecordsParams;

type UpdateRecordsParams = {
  ids: ID | IDs;
  embeddings?: Embedding | Embeddings;
  metadatas?: Metadata | Metadatas;
  documents?: Document | Documents;
};

type DeleteParams = {
  ids?: ID | IDs;
  where?: Where;
  whereDocument?: WhereDocument;
};

// Query parameters
type QueryRecordsParams = {
  queryTexts?: string | string[];
  queryEmbeddings?: Embedding | Embeddings;
  nResults?: PositiveInteger;
  ids?: ID | IDs;
  where?: Where;
  whereDocument?: WhereDocument;
  include?: IncludeEnum[];
};

// Get parameters
type BaseGetParams = {
  ids?: ID | IDs;
  where?: Where;
  limit?: PositiveInteger;
  offset?: PositiveInteger;
  include?: IncludeEnum[];
  whereDocument?: WhereDocument;
};

// Peek parameters
type PeekParams = { limit?: PositiveInteger };

// Modify parameters
type ModifyCollectionParams = {
  name?: string;
  metadata?: CollectionMetadata;
};
```

### Collection Class Interface

```typescript
class Collection {
  public name: string;
  public id: string;
  public metadata: CollectionMetadata | undefined;
  public embeddingFunction: IEmbeddingFunction;
  public configuration: CollectionConfiguration | undefined;

  async add(params: AddRecordsParams): Promise<void>;
  async upsert(params: UpsertRecordsParams): Promise<void>;
  async update(params: UpdateRecordsParams): Promise<void>;
  async delete(params?: DeleteParams): Promise<void>;
  async query(params: QueryRecordsParams): Promise<MultiQueryResponse>;
  async get(params?: BaseGetParams): Promise<GetResponse>;
  async count(): Promise<number>;
  async peek(params?: PeekParams): Promise<GetResponse>;
  async modify(params: ModifyCollectionParams): Promise<CollectionParams>;
  async fork(params: ForkCollectionParams): Promise<Collection>;
}
```

---

## 12. ChromaDB v3.x (npm) vs v2.x Differences

### Versioning Context

The `chromadb` npm package versioning does **not** directly correspond to the ChromaDB server versioning:
- **npm package:** Went from v1.x to v2.x to current v3.x (3.4.3 as of June 2026)
- **Server:** Follows semantic versioning from 0.x.x to 1.x.x

The npm v3.x package corresponds to ChromaDB server v1.x.

### Key Changes in npm v3.x

**1. New Search API**

v3.x introduces a `collection.search()` method with expression builders, supporting hybrid search, RRF (Reciprocal Rank Fusion), and advanced ranking:

```typescript
// New in v3.x
const results = await collection.search({
  searches: { ... },
  readLevel: "...",
});
```

**2. K() Expression Builder**

New type-safe filter builder replaces raw objects for complex queries:

```typescript
import { K } from "chromadb";

// v3.x expression builder
K("status").eq("active").and(K("year").gte(2020));
K.DOCUMENT.contains("search text");
K.ID.isIn(["id1", "id2"]);
```

**3. Embedding Function Server-Side Storage**

Starting with client v3.0.4+ and server v1.1.13+, the embedding function configuration is stored server-side. You no longer need to pass the embedding function when calling `getCollection()` on newer servers.

**4. `listCollections()` Return Type Changes**

The return value has changed across versions:
- **v0.5.x (pre-1.0):** Returned `Collection[]` objects
- **v0.6.0:** Changed to return `string[]` (names only)
- **v1.0.0 / npm v3.x:** Source code shows it returns `string[]` (names only), with `listCollectionsAndMetadata()` available for full details

**5. Fork Collection**

v3.x adds `collection.fork({ newName })` to create a copy of an existing collection.

**6. `getCollections()` Batch Method**

New method to retrieve multiple collections at once:

```typescript
const [col1, col2] = client.getCollections(["col1", "col2"]);
```

**7. `countCollections()` Method**

New method to get the total count of collections without listing them.

**8. `modify()` Expanded**

`collection.modify()` now supports updating collection configuration in addition to name and metadata:

```typescript
await collection.modify({
  name: "new-name",
  metadata: { description: "updated" },
  configuration: { /* UpdateCollectionConfiguration */ },
});
```

### Breaking Changes from Server v0.5.x to v1.x

These affect the npm v3.x client:

**1. Empty Filters Rejected (since v0.5.17)**
```typescript
// No longer valid
collection.get({ ids: ["id1"], where: {} });

// Correct -- omit the parameter
collection.get({ ids: ["id1"] });
```

**2. `$ne` and `$nin` Behavior Change (since v0.5.12)**
- Previously: Only matched records that had the specified key
- Now: Also matches records that don't have the key at all (true complement)

**3. `$not_contains` in whereDocument (since v0.5.12)**
- Previously: Only matched records that had a document field
- Now: Also matches records without a document field

**4. `get()` Ordering (since v0.5.11)**
- Results are now ordered by internal IDs, not user-provided IDs
- Newer documents have larger internal IDs
- This affects `limit` and `offset` behavior

**5. `getOrCreateCollection` Behavior (since v0.5.11)**
- Previously: Calling with metadata on an existing collection would overwrite metadata
- Now: Extra arguments (including metadata) are ignored for existing collections

**6. Built-in Auth Removed (v1.0.0)**
- Built-in authentication implementations are no longer provided in the server
- Use token-based auth via headers instead

**7. Docker Data Path Change (v1.0.0)**
- Default data path changed from `/chroma/chroma` to `/data`

### Migration Checklist for v2.x to v3.x

1. Update the package: `npm install chromadb@latest`
2. Review `listCollections()` usage -- it returns `string[]`, not `Collection[]`
3. Remove empty `where: {}` and `whereDocument: {}` from all calls
4. Test `$ne`, `$nin`, and `$not_contains` queries for changed behavior
5. If using `getOrCreateCollection`, do not rely on metadata overwrite
6. Update any Docker volume mounts from `/chroma/chroma` to `/data`
7. If using built-in auth, migrate to header-based token auth

---

## 13. References

- [ChromaDB Official Documentation](https://docs.trychroma.com/)
- [ChromaDB Getting Started](https://docs.trychroma.com/docs/overview/getting-started)
- [ChromaDB Managing Collections](https://docs.trychroma.com/docs/collections/manage-collections)
- [ChromaDB Adding Data](https://docs.trychroma.com/docs/collections/add-data)
- [ChromaDB Updating Data](https://docs.trychroma.com/docs/collections/update-data)
- [ChromaDB Deleting Data](https://docs.trychroma.com/docs/collections/delete-data)
- [ChromaDB Collection Configuration](https://docs.trychroma.com/docs/collections/configure)
- [ChromaDB Query and Get](https://docs.trychroma.com/docs/querying-collections/query-and-get)
- [ChromaDB Metadata Filtering](https://docs.trychroma.com/docs/querying-collections/metadata-filtering)
- [ChromaDB Full-Text Search](https://docs.trychroma.com/docs/querying-collections/full-text-search)
- [ChromaDB Client-Server Mode](https://docs.trychroma.com/docs/run-chroma/client-server)
- [ChromaDB Clients Reference](https://docs.trychroma.com/docs/run-chroma/clients)
- [ChromaDB Migration Guide](https://docs.trychroma.com/docs/overview/migration)
- [TypeScript Client Reference](https://docs.trychroma.com/reference/typescript/client)
- [TypeScript Collection Reference](https://docs.trychroma.com/reference/typescript/collection)
- [TypeScript Where Filter Reference](https://docs.trychroma.com/reference/typescript/where-filter)
- [TypeScript Schema Reference](https://docs.trychroma.com/reference/typescript/schema)
- [chromadb npm package](https://www.npmjs.com/package/chromadb)
- [ChromaDB GitHub Repository](https://github.com/chroma-core/chroma)
- [JS Client Source (chromadb-core)](https://github.com/chroma-core/chroma/tree/main/clients/js/packages/chromadb-core/src)
