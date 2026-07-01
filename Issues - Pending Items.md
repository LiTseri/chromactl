# Issues - Pending Items

## Pending

### [Medium] `index file` silently creates a near-empty 1-chunk entry for scanned/image-only PDFs
- **Symptom:** Indexing a scanned (image-only, no text layer) PDF prints `Warning: No text content extracted from <file>` but still reports `Indexed 1 file, created 1 chunk(s)`, adding a useless chunk with no searchable content to the collection. Encountered with `docs/client/Οικονομικά Στοιχεία απο πέλατη Παράδειγμα 2 Crow.pdf` (produced by a RICOH IM C530FB scanner; `pdftotext` yielded 4 chars over 4 pages).
- **Cause:** The extractor returns empty/whitespace text for image-only PDFs; the indexer proceeds to chunk it into a single empty chunk instead of skipping or failing.
- **Impact:** The document appears "indexed" (contributes to document counts) but is not retrievable, giving a false sense of coverage. No OCR fallback exists in the tool.
- **Next step:** Options to decide — (a) skip and report the file as "no text extracted, not indexed" with a non-zero notice, and/or (b) integrate an OCR fallback (e.g. tesseract with `ell+eng`) in the extractor for image-only PDFs. Until then, scanned PDFs must be OCR'd manually before indexing (see Completed entry for the manual procedure used).

### [Low] DefaultEmbeddingFunction warnings emitted by every command that opens a collection
- **Symptom:** `collection create`, `index file`/`index dir`, and any command that instantiates a collection print repeated `Cannot instantiate a collection with the DefaultEmbeddingFunction. Please install @chroma-core/default-embed, or provide a different embedding function`. The commands still succeed. (Originally observed only on `collection create`; confirmed 2026-07-01 to also appear on `index file`, four times per invocation.)
- **Cause:** `chromadb` v3 no longer bundles the default embedding function; it lives in the optional `@chroma-core/default-embed` package, which is not installed.
- **Next step:** Decide whether chromactl should depend on `@chroma-core/default-embed` or always require an explicit embedding function, then wire it in. Not blocking any command today, but the noisy stderr obscures real warnings (e.g. the scanned-PDF warning above).

## Completed

### [High] `search`, `stats`, and `collection list` broken by chromadb v3 API migration (fixed 2026-07-01)
- **Symptoms:**
  - `search` aborted with `Error: e.every is not a function` — no results ever returned (semantic search, the tool's primary purpose, was non-functional).
  - `stats <collection>` aborted with `Error: Expected 'include' items to be strings`.
  - `stats` (database-level) and `collection list` aborted with `The requested resource could not be found`.
- **Root causes (all chromadb v3.4.3 API changes, hidden because the build uses `tsup`/esbuild which is transpile-only — `pnpm typecheck` was never gating the build and had ~20 pre-existing errors):**
  1. **`IncludeEnum` member casing changed.** v1/v2 exposed capitalized members (`IncludeEnum.Documents`, `.Metadatas`, `.Distances`); v3's members are lowercase (`documents`, `metadatas`, `distances`). The capitalized accessors resolved to `undefined` at runtime, so `include` arrays became `[undefined, ...]` → `stats` "items must be strings"; the enum type is also no longer accepted (the SDK now types `include` as the non-exported string-literal `Include` union).
  2. **`queryEmbeddings` dimensionality.** `search.ts` passed a 1-D `number[]` (from `embedSingle`) but v3 requires `number[][]` (one row per query). chromadb iterated the flat array and called `.every()` on each *number* → `e.every is not a function`.
  3. **`listCollections()` return shape.** v3 returns `Collection[]` objects, not `string[]`. `stats` (db-level) and `collection list` treated each element as a name string and passed the whole object to `getCollection({ name })`, producing a 404 (`resource not found`).
  4. **Renamed/removed type exports.** `IEmbeddingFunction` → `EmbeddingFunction`; `where` params are now typed `Where`; query/get results now expose nullable fields (`distances: (number|null)[][]`).
- **Fix (see `git diff` for `src/lib/db.ts`, `src/commands/search.ts`, `src/commands/stats.ts`, `src/commands/collection.ts`):**
  - Replaced all `IncludeEnum.*` usage with lowercase string-literal include values. Since chromadb does not export its internal `Include` union, added an exported `IncludeField` string-literal type in `src/lib/db.ts` (structurally identical to `Include`, so assignable to the SDK params) and used it across `search`/`stats`/`db`.
  - `search.ts`: pass `queryEmbeddings: [queryEmbedding]` (2-D) and typed the query params with `Where` + `IncludeField[]`.
  - `db.ts` `listCollections()`, `stats.ts` `showDatabaseStats`, and `collection.ts` list: map `listCollections()` results to `.name`.
  - `db.ts`: `noopEmbeddingFunction` retyped to `EmbeddingFunction`; `where` casts to `Where`; nullable `distances` normalized to `0`; removed the now-unused `toIncludeEnum` helper.
- **Verification (2026-07-01):**
  - `pnpm typecheck` now exits clean (0 errors, down from ~20); `pnpm build` succeeds; `pnpm test` → 117/117 pass.
  - Runtime against the `shipping_docs` collection: `search "Crow Navigation total assets"` returns ranked results with snippets; `search ... --filter '{"client_name":"Crow"}'` (Where clause) works; `stats shipping_docs` shows Documents/Chunks/unique-source/file-type/metadata breakdowns; `stats` (db-level) and `collection list` both list `shipping_docs` with counts.
- **Note:** The build pipeline (`tsup`) does not run type checking, so this class of SDK-drift bug will recur silently. Recommend wiring `pnpm typecheck` into the build/CI step (tracked implicitly here). The pre-existing `collection.ts` `getCollection` cast and other v3 type errors surfaced during this fix were also resolved so `typecheck` is green.

### [Medium] Scanned Crow PDF indexed as empty 1-chunk entry — resolved via manual OCR + re-index (fixed 2026-07-01)
- **Symptom:** `docs/client/Οικονομικά Στοιχεία απο πέλατη Παράδειγμα 2 Crow.pdf` initially indexed into `shipping_docs` as only 1 chunk with a `No text content extracted` warning — an image-only scan (RICOH IM C530FB, 4 pages) with no text layer, so its content was not searchable.
- **Resolution (manual OCR, since `ocrmypdf` needs ghostscript which is absent on this machine):**
  1. `pdftoppm -png -r 300 <pdf> page` — rendered the 4 pages to PNG images.
  2. `tesseract imagelist.txt <out> -l ell+eng pdf` — OCR'd the images into a searchable multi-page PDF (Greek + English language packs; `tesseract` and both `ell`/`eng` packs are installed under `/opt/homebrew`).
  3. Verified with `pdftotext`: 5002 characters of real content extracted (CROW NAVIGATION INC balance sheet as at 31-Dec-2025) vs. 4 chars before.
  4. Backed up the original to the session scratchpad, replaced the file in place (same absolute path), then re-ran the original `index file` command with the same metadata `{"doc_type":"client","client_name":"Crow","year":2026}`.
- **Result:** Re-index reported `created 8 chunk(s)` (up from 1). Because chunk IDs are deterministic (`<absPath>::chunk-<n>`, see `src/lib/chunker.ts:120`) and the collection uses `upsert` (`src/commands/index-cmd.ts:303`), the stale `chunk-0` was overwritten and no orphan chunk remained (new count 8 > old count 1).
- **Note:** Could not verify via `search`/`stats` because both are currently broken (see Pending [High] items); verification relied on the index output and the OCR text-extraction check.

### [High] `collection create` failed with "Could not resolve the chromadb package. Is it installed?" (fixed 2026-07-01)

### [High] `collection create` failed with "Could not resolve the chromadb package. Is it installed?" (fixed 2026-07-01)
- **Symptom:** `node dist/index.js collection create ... --db <path>` aborted with `Could not resolve the chromadb package. Is it installed?` even though `chromadb@3.4.3` was installed.
- **Root cause:** `resolveChromaBinary()` in `src/lib/server.ts` located the CLI via `require.resolve('chromadb/package.json')`. `chromadb` v3 ships an `exports` map that only exposes `.` (main entry) and does not declare the `./package.json` subpath. Node's modern resolver therefore throws `ERR_PACKAGE_PATH_NOT_EXPORTED`, which the surrounding `try/catch` swallowed and mis-reported as "package not installed".
- **Fix:** Resolve the package's main entry (`require.resolve('chromadb')`, allowed by the exports map) and walk up parent directories to the folder whose `package.json` has `name === 'chromadb'` — that is the package root. Derive the CLI path from that package.json's `bin` field (`bin.chroma`, falling back to `dist/cli.mjs`) instead of hardcoding. See `src/lib/server.ts` `resolveChromaBinary()`.
- **Verification:** `pnpm build` succeeds and the original command now creates the collection: `Created collection 'shipping_docs' with schema 'shipping_doc'.`
