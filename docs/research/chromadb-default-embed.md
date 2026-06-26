# Research: ChromaDB Default Embedding Function (`@chroma-core/default-embed`)

## Key Findings Summary

| Aspect | Detail |
|--------|--------|
| **Where embeddings run** | Client-side (in the Node.js process), NOT on the ChromaDB server |
| **Default model** | `Xenova/all-MiniLM-L6-v2` (ONNX format of `sentence-transformers/all-MiniLM-L6-v2`) |
| **Embedding dimensions** | 384 |
| **Default distance metric** | Cosine |
| **Default dtype** | `fp32` (90.4 MB ONNX file) -- or `uint8` (22.8 MB) if `quantized: true` |
| **Total download on first run** | ~91.3 MB (fp32 model + tokenizer + config) or ~23.7 MB (uint8/quantized) |
| **Cache location (Node.js)** | `<package-root>/node_modules/@huggingface/transformers/.cache/` |
| **Cache configurable** | Yes, via `env.cacheDir` from `@huggingface/transformers` |
| **Offline capable** | Yes, after first download; `env.allowRemoteModels = false` prevents network calls |
| **Pipeline caching** | None in `@chroma-core/default-embed` -- `pipeline()` is called on every `generate()` invocation |
| **Recommended pattern** | Use singleton pattern; cache the `DefaultEmbeddingFunction` instance and ideally the pipeline itself |
| **First call latency** | Model download (network-dependent) + model loading (~1-3s) + inference |
| **Subsequent call latency** | Model loading (~1-3s per `generate()` call due to lack of pipeline caching) + inference |
| **Package version** | `@chroma-core/default-embed@0.1.9` |
| **chromadb dependency** | `@chroma-core/default-embed` is a **devDependency** of `chromadb@3.4.3`, NOT a runtime dependency |

---

## 1. Embedding Architecture: Client-Side vs Server-Side

### Where Embeddings Execute

**Embeddings are generated client-side**, in the Node.js process that runs the ChromaDB client. The ChromaDB server (whether started via `npx chroma run` or running in Docker) does **not** generate embeddings. The Rust-based server is a storage and indexing engine -- it receives pre-computed embedding vectors from the client.

Evidence for this:
- ChromaDB docs state the default embedding function "runs locally on your machine"
- TypeScript users must install `@chroma-core/default-embed` as a separate npm package into their own project
- The Rust client "expects embeddings to be provided directly" (no server-side embedding support)
- Embedding function packages (`@chroma-core/openai`, `@chroma-core/cohere`, etc.) are installed in the client project, not on the server
- API keys for third-party embedding providers are read from local environment variables

### Flow When Adding Documents

```
1. Client calls collection.add({ ids, documents })
2. Client's embedding function generates vectors from documents (client-side)
3. Client sends (ids, documents, embeddings, metadata) to ChromaDB server via HTTP
4. Server stores the pre-computed vectors and indexes them
```

When `embeddings` are explicitly provided alongside `documents`, the embedding function is **bypassed entirely** -- the server stores the provided vectors as-is.

### Flow When Querying

```
1. Client calls collection.query({ queryTexts: ["search text"] })
2. Client's embedding function generates vector from query text (client-side)
3. Client sends query vector to ChromaDB server via HTTP
4. Server performs ANN search and returns results
```

### Implication for chromactl

Since embedding happens client-side, the `@chroma-core/default-embed` package must be installed in the chromactl project, not on the server. The embedding model is downloaded and cached within the chromactl process's file system context. The ChromaDB server started via `npx chroma run` has no involvement in embedding generation.

---

## 2. The `@chroma-core/default-embed` Package

### Overview

| Field | Value |
|-------|-------|
| Package name | `@chroma-core/default-embed` |
| Version | 0.1.9 |
| Unpacked size | 30.5 kB (11 files) |
| Node.js requirement | >= 20 |
| Module format | Dual CJS/ESM |
| Published by | itaichroma (itai@trychroma.com) |

### Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| `@huggingface/transformers` | ^3.5.1 | ONNX model inference runtime |
| `@chroma-core/ai-embeddings-common` | ^0.1.9 | Shared embedding interface definitions |

### What It Provides

The package exports a single class `DefaultEmbeddingFunction` that:
- Wraps `@huggingface/transformers`' `pipeline()` API for `feature-extraction`
- Uses `Xenova/all-MiniLM-L6-v2` as the default model
- Produces 384-dimensional embeddings with mean pooling and L2 normalization
- Defaults to cosine distance metric
- Supports configurable dtype (`fp32`, `uint8`, `fp16`, `q8`, `int8`, `q4`, `bnb4`, `q4f16`)

### Source Code (Complete)

```typescript
import { validateConfigSchema } from "@chroma-core/ai-embeddings-common";
import { pipeline, ProgressCallback } from "@huggingface/transformers";
import { env as TransformersEnv } from "@huggingface/transformers";

export class DefaultEmbeddingFunction {
  public readonly name: string = "default";
  private readonly modelName: string;
  private readonly revision: string;
  private readonly dtype: Quantization | undefined;
  private readonly quantized: boolean;
  private readonly progressCallback: ProgressCallback | undefined = undefined;
  private readonly wasm: boolean;

  constructor(args: Partial<DefaultEmbeddingFunctionArgs & {
    progressCallback: ProgressCallback | undefined;
  }> = {}) {
    const {
      modelName = "Xenova/all-MiniLM-L6-v2",
      revision = "main",
      dtype = undefined,
      progressCallback = undefined,
      quantized = false,
      wasm = false,
    } = args;

    this.modelName = modelName;
    this.revision = revision;
    this.dtype = dtype || (quantized ? "uint8" : "fp32");
    this.quantized = quantized;
    this.progressCallback = progressCallback;
    this.wasm = wasm;
    if (this.wasm) {
      TransformersEnv.backends.onnx.backend = "wasm";
    }
  }

  public async generate(texts: string[]): Promise<number[][]> {
    const pipe = await pipeline("feature-extraction", this.modelName, {
      revision: this.revision,
      progress_callback: this.progressCallback,
      dtype: this.dtype,
    });

    const output = await pipe(texts, { pooling: "mean", normalize: true });
    return output.tolist();
  }

  // ... getConfig(), validateConfigUpdate(), defaultSpace(), supportedSpaces()
}
```

### Critical Implementation Detail: No Pipeline Caching

The `generate()` method calls `await pipeline(...)` on **every invocation**. There is no singleton pattern, no instance-level pipeline cache, and no lazy initialization of the pipeline. This means:

1. On the first call: the model is downloaded (if not cached) and loaded into memory
2. On subsequent calls: the model is loaded from disk cache into memory again (no in-memory caching)

The `@huggingface/transformers` library does cache downloaded model files to disk, so the network download only happens once. However, the ONNX model is re-loaded and the ONNX session is re-created on every `generate()` call.

**Performance implication**: Each `generate()` call incurs ~1-3 seconds of model loading overhead, even after the first run. For batch operations (like indexing many documents), this is significant.

**Recommended mitigation**: Create a wrapper that caches the pipeline instance:

```typescript
import { pipeline } from "@huggingface/transformers";

let cachedPipeline: any = null;

async function getCachedPipeline() {
  if (!cachedPipeline) {
    cachedPipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      dtype: "fp32",
    });
  }
  return cachedPipeline;
}
```

Or, when using `DefaultEmbeddingFunction`, call `generate()` with batched texts rather than one at a time to amortize the pipeline loading cost.

### Relationship to chromadb Package

- In `chromadb@3.4.3`: `@chroma-core/default-embed` is a **devDependency** (not a runtime dependency)
- In `chromadb-client@2.4.6` (older thin client): `chromadb-default-embed` (different package name) is an **optional peerDependency**
- **Users must install `@chroma-core/default-embed` explicitly** for default embedding to work
- The ChromaDB getting-started docs show: `npm install chromadb @chroma-core/default-embed`

---

## 3. Model Download and Cache Directory

### Default Cache Location

The `@huggingface/transformers` library caches downloaded models in a `.cache/` directory **relative to the package installation**:

```
<project-root>/node_modules/@huggingface/transformers/.cache/
```

The cache directory is computed at runtime as:

```javascript
const dirname__ = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const DEFAULT_CACHE_DIR = path.join(dirname__, '/.cache/');
```

This resolves to the `@huggingface/transformers` package root within `node_modules`.

### No Environment Variable Support (Unlike Python)

Unlike Python's `transformers` library which reads `HF_HOME`, `TRANSFORMERS_CACHE`, and `XDG_CACHE_HOME`, the JavaScript version does **not** check any environment variables. The cache directory is determined purely by the package's file system location.

### Customizing Cache Directory

The cache directory can be overridden programmatically:

```typescript
import { env } from "@huggingface/transformers";
env.cacheDir = "/path/to/custom/cache/";
```

This must be set **before** any model loading occurs.

### Cache Directory Structure

When `Xenova/all-MiniLM-L6-v2` is downloaded, the cache contains:

```
.cache/
  Xenova/
    all-MiniLM-L6-v2/
      onnx/
        model.onnx              (90.4 MB for fp32)
        model_quantized.onnx    (23 MB for uint8)
      config.json               (650 B)
      tokenizer.json            (712 KB)
      tokenizer_config.json     (366 B)
      special_tokens_map.json   (125 B)
      vocab.txt                 (232 KB)
```

### Download Sizes by Dtype

| dtype | ONNX file | Approx. total with tokenizer |
|-------|-----------|------------------------------|
| `fp32` (default) | `model.onnx` -- 90.4 MB | ~91.3 MB |
| `fp16` | `model_fp16.onnx` -- 45.3 MB | ~46.2 MB |
| `int8` | `model_int8.onnx` -- 23 MB | ~23.9 MB |
| `uint8` (quantized) | `model_uint8.onnx` -- 22.8 MB | ~23.7 MB |
| `q4` | `model_q4.onnx` -- 54.6 MB | ~55.5 MB |
| `q4f16` | `model_q4f16.onnx` -- 30 MB | ~30.9 MB |
| `bnb4` | `model_bnb4.onnx` -- 53.9 MB | ~54.8 MB |

The tokenizer and config files (~1 MB total) are always downloaded regardless of dtype.

---

## 4. First-Run Behavior

### What Happens on the Very First Embedding Call

1. `DefaultEmbeddingFunction.generate()` is called
2. `pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", ...)` is invoked
3. The library checks `env.cacheDir` for cached model files
4. **Cache miss**: Files are downloaded from `https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/`
5. Downloaded files are stored in the cache directory
6. The ONNX model is loaded into memory and an ONNX Runtime inference session is created
7. Embeddings are computed and returned

### Download Progress

The `DefaultEmbeddingFunction` constructor accepts a `progressCallback` parameter:

```typescript
const ef = new DefaultEmbeddingFunction({
  progressCallback: (progress) => {
    // progress object contains download progress info
    console.log(progress);
  },
});
```

The `progress_callback` from `@huggingface/transformers` provides events during model loading, including file download progress with percentage and bytes transferred. However, the specific format of the progress object varies by version.

If no `progressCallback` is provided (the default), the download happens silently -- there is no built-in console output or progress bar.

### Estimated First-Run Timing

| Phase | Duration (estimate) |
|-------|---------------------|
| Model download (fp32, ~91 MB) | 5-30s (network-dependent) |
| Model download (uint8, ~24 MB) | 2-10s (network-dependent) |
| ONNX model loading | 1-3s |
| ONNX session creation | 0.5-1s |
| Embedding inference (single text) | 50-200ms |
| **Total first call (fp32)** | **~7-35s** |
| **Total first call (uint8)** | **~4-15s** |

### Interrupted Downloads

If the download is interrupted:
- The partially downloaded files remain in the cache directory
- On the next attempt, the library will detect incomplete/corrupted files and re-download
- There is a known issue (#1548 in transformers.js) with concurrent downloads causing partial file reads, which was fixed in v4

---

## 5. Offline Error Handling

### Model Already Cached (Offline Works)

If the model files are present in the cache directory and the machine is offline:
- The library loads from disk cache successfully
- No network requests are made
- Embeddings work normally

### Model Not Cached (Offline Fails)

If the model has never been downloaded and the machine is offline:
- The `pipeline()` call will throw a network error (fetch failure)
- The error will propagate as an unhandled promise rejection from `generate()`
- The `DefaultEmbeddingFunction` has **no explicit error handling** for this case
- The error message will be a generic fetch/network error, not a user-friendly message

### Forcing Offline Mode

To prevent any network requests (useful after pre-downloading):

```typescript
import { env } from "@huggingface/transformers";
env.allowRemoteModels = false;
```

When `allowRemoteModels` is `false` and models are not cached locally, the library throws an error indicating the model cannot be found.

### Forcing Local-Only Mode with Custom Path

```typescript
import { env } from "@huggingface/transformers";
env.localModelPath = "/path/to/local/models/";
env.allowRemoteModels = false;
env.allowLocalModels = true;
```

---

## 6. Pre-Downloading the Model

### Programmatic Pre-Download

There is no dedicated "download-only" API. The recommended approach is to call `pipeline()` once to trigger the download:

```typescript
import { pipeline } from "@huggingface/transformers";

// Pre-download by creating the pipeline (discarding the result is fine)
const pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
  dtype: "fp32",
  progress_callback: (progress) => {
    console.log(`Downloading: ${JSON.stringify(progress)}`);
  },
});
// pipe is now loaded and the model is cached
```

### CLI Pre-Download

There is no CLI command in `@huggingface/transformers` to pre-download models (unlike Python's `huggingface-cli download`). A custom script must be used.

### Bundling with npm Package

Models can be bundled by:
1. Pre-downloading to a known directory
2. Setting `env.localModelPath` to that directory
3. Setting `env.allowRemoteModels = false`

However, this adds ~23-91 MB to the package size, which is impractical for npm distribution.

### CI Caching (ChromaDB's Approach)

ChromaDB's CI (PR #7201, merged June 2026) pre-downloads the model to `~/.cache/chroma/onnx_models/all-MiniLM-L6-v2` with SHA256 verification and GitHub Actions caching. This is for the Python ecosystem's default model, but the same pattern can be adapted for the JS ecosystem.

---

## 7. Cache Persistence

### Across ChromaDB Server Restarts

The model cache is **completely independent** of the ChromaDB server. Since embeddings are generated client-side, the ONNX model cache lives in the client's file system (within `node_modules`). ChromaDB server restarts have no effect on the model cache.

### Across Node.js Process Restarts

- **Disk cache**: Persists across process restarts. Once the model is downloaded, it stays in `.cache/` until manually deleted or `node_modules` is cleaned.
- **In-memory model**: Does NOT persist. The ONNX model must be re-loaded from disk on each process start (and on each `generate()` call due to the lack of pipeline caching in `DefaultEmbeddingFunction`).

### Shared Across Applications

The cache is located inside the `@huggingface/transformers` package directory within `node_modules`. Therefore:
- **Same project**: Shared (same `node_modules`)
- **Different projects**: NOT shared by default (each has its own `node_modules`)
- **Global install**: If `@huggingface/transformers` is globally installed, the cache would be shared

To share cache across projects, set `env.cacheDir` to a common directory in all projects.

### Cache Corruption

If the cache directory is deleted:
- The model will be re-downloaded on the next `pipeline()` call
- No error is thrown for cache deletion -- it gracefully falls back to downloading

If cache files are corrupted (partial download, manual editing):
- The ONNX Runtime may throw parsing errors ("Protobuf parsing failed" -- issue #1228)
- Deleting the cache directory and re-downloading resolves the issue

---

## 8. Performance Characteristics

### Model Loading (Per `generate()` Call)

Due to the lack of pipeline caching in `DefaultEmbeddingFunction`, every call to `generate()` incurs model loading overhead:

| Operation | Duration |
|-----------|----------|
| Pipeline creation (model from disk cache) | ~1-3s |
| ONNX session initialization | ~0.5-1s |
| **Total per generate() call overhead** | **~1.5-4s** |

### Inference Performance

| Batch Size | Duration (after model is loaded) |
|------------|----------------------------------|
| 1 text | ~50-200ms |
| 10 texts | ~200-500ms |
| 100 texts | ~1-3s |
| 1000 texts | ~5-15s |

These are rough estimates for `all-MiniLM-L6-v2` on a modern CPU. Performance varies by hardware.

### Memory Footprint

| State | Memory Usage |
|-------|-------------|
| Before model loading | Baseline Node.js process |
| Model loaded (fp32) | +100-200 MB |
| Model loaded (uint8/quantized) | +50-100 MB |
| During inference (batch of 100) | Additional ~50-100 MB temporary |

### CPU vs GPU

- `onnxruntime-node` (used by `@huggingface/transformers` in Node.js) runs on **CPU by default**
- GPU support is available via `onnxruntime-gpu` but requires manual setup and CUDA/cuDNN
- For `all-MiniLM-L6-v2` (22.7M parameters), CPU inference is fast enough for most use cases
- WASM backend is available via the `wasm: true` option in `DefaultEmbeddingFunction` (uses `onnxruntime-web`)

### Batch vs Individual Processing

Given the `generate()` overhead, batching is critical:

```
// BAD: 100 individual calls = 100 x pipeline load = 150-400s overhead
for (const text of texts) {
  await ef.generate([text]);
}

// GOOD: 1 batched call = 1 x pipeline load = 1.5-4s overhead
await ef.generate(texts);
```

---

## 9. Server-Side Embedding Details

### ChromaDB Server Capabilities

The ChromaDB server (Rust-based, started via `npx chroma run`) is a **storage and indexing engine**. It does NOT have built-in embedding generation capability. The server:
- Receives pre-computed embedding vectors via its HTTP API
- Stores vectors in HNSW index
- Performs ANN (approximate nearest neighbor) search
- Returns results

### What Happens Without Client-Side Embedding

If `@chroma-core/default-embed` is NOT installed and no embedding function is provided:

- **Python client**: Has built-in default embedding -- works without extra packages
- **TypeScript client (`chromadb`)**: Collection creation succeeds, but `add()` with only documents (no embeddings) will fail because there is no embedding function to generate vectors
- **Rust client**: Always requires explicit embeddings -- no default embedding function exists

### The Two TypeScript Packages

| Package | `@chroma-core/default-embed` status | Includes native bindings | CLI binary |
|---------|--------------------------------------|--------------------------|------------|
| `chromadb` | devDependency (NOT installed for users) | Yes (optional) | Yes (`chroma`) |
| `chromadb-client` | `chromadb-default-embed` as optional peerDependency | No | No |

**Key insight**: Neither package automatically installs the default embedding function for end users. It must be explicitly installed: `npm install @chroma-core/default-embed`.

---

## 10. Key Findings for CLI Development (chromactl)

### Must-Do Items

1. **Explicitly install `@chroma-core/default-embed`** as a runtime dependency of chromactl. It will NOT be automatically available from `chromadb`.

2. **Implement pipeline caching**. The `DefaultEmbeddingFunction.generate()` method re-creates the pipeline on every call. For indexing operations (many documents), this is unacceptable. Either:
   - Cache the pipeline instance in a wrapper
   - Use `@huggingface/transformers` `pipeline()` directly with a singleton pattern
   - Batch all texts into a single `generate()` call per indexing operation

3. **Handle first-run model download gracefully**:
   - Show a progress indicator during model download (use `progressCallback`)
   - Inform the user that a one-time ~23-91 MB download is required
   - Handle network errors with clear error messages
   - Consider using `uint8` dtype to reduce download size from 91 MB to 24 MB with minimal quality loss

4. **Handle offline scenarios**:
   - Check if model is cached before attempting embedding
   - Provide clear error message if model is not cached and network is unavailable
   - Consider a `chromactl download-model` command to pre-download the model

### Recommended Approach for chromactl

```typescript
import { pipeline, env, ProgressCallback } from "@huggingface/transformers";

// Configure cache directory (optional -- customize location)
// env.cacheDir = path.join(projectRoot, ".chromactl", "models");

class EmbeddingManager {
  private pipeline: any = null;
  private loading: Promise<any> | null = null;

  async ensureModel(progressCallback?: ProgressCallback): Promise<void> {
    if (!this.pipeline) {
      if (!this.loading) {
        this.loading = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
          dtype: "fp32", // or "uint8" for smaller download
          progress_callback: progressCallback,
        });
      }
      this.pipeline = await this.loading;
    }
  }

  async generate(texts: string[]): Promise<number[][]> {
    await this.ensureModel();
    const output = await this.pipeline(texts, { pooling: "mean", normalize: true });
    return output.tolist();
  }

  isModelCached(): boolean {
    // Check if model files exist in cache directory
    const cacheDir = env.cacheDir;
    // Check for model.onnx in expected location
    // ...
  }
}
```

### Architecture Decisions

| Decision | Recommendation | Rationale |
|----------|---------------|-----------|
| Use `DefaultEmbeddingFunction` directly | No | No pipeline caching; re-loads model on every call |
| Use `@huggingface/transformers` pipeline directly | Yes | Full control over caching, progress, error handling |
| Default dtype | `fp32` or `uint8` | fp32 for quality, uint8 for smaller download |
| Cache directory | Default (inside node_modules) or custom | Custom allows persistence across npm installs |
| Pre-download command | Yes (`chromactl init` or `chromactl download-model`) | Better UX than silent download on first index |
| Batch size for indexing | All texts in single `generate()` call | Avoids repeated pipeline loading |

### Risk Items

1. **Cache inside `node_modules`**: Default cache is inside `node_modules/@huggingface/transformers/.cache/`. Running `npm install`, `npm ci`, or deleting `node_modules` will wipe the cache, requiring re-download. Consider setting `env.cacheDir` to a location outside `node_modules`.

2. **Concurrent process access**: Issue #1544 in transformers.js identified problems when multiple Node.js processes access the cache simultaneously. This was fixed in a subsequent release (#1548), but care should be taken if chromactl runs multiple processes.

3. **CJS compatibility**: Earlier versions of `@huggingface/transformers` v3 had a bug (#997) where the CJS build hardcoded the CI runner's cache path. This was fixed in PR #1012. Ensure you use a version >= 3.1.0 if using CommonJS.

4. **Model size in CI**: The 91 MB (fp32) or 24 MB (uint8) download adds to CI setup time. Consider caching the model directory in CI workflows (similar to ChromaDB's PR #7201 approach).

---

## References

| # | Source | URL | What was learned |
|---|--------|-----|-----------------|
| 1 | ChromaDB Docs - Embedding Functions | https://docs.trychroma.com/docs/embeddings/embedding-functions | Default embedding uses all-MiniLM-L6-v2; runs locally; TS requires @chroma-core/default-embed |
| 2 | ChromaDB Docs - Add Data | https://docs.trychroma.com/docs/collections/add-data | When only documents are provided, collection's embedding function generates vectors automatically |
| 3 | ChromaDB Docs - Configure | https://docs.trychroma.com/docs/collections/configure | Embedding functions are persisted in collection config; API keys read from local env vars (client-side) |
| 4 | ChromaDB Docs - Getting Started | https://docs.trychroma.com/docs/overview/getting-started | TS client requires @chroma-core/default-embed alongside chromadb |
| 5 | @chroma-core/default-embed npm | https://registry.npmjs.org/@chroma-core/default-embed/latest | v0.1.9, depends on @huggingface/transformers ^3.5.1, 30.5 kB unpacked |
| 6 | @chroma-core/default-embed source | https://unpkg.com/@chroma-core/default-embed@0.1.9/src/index.ts | Full implementation -- no pipeline caching in generate() |
| 7 | chromadb npm | https://registry.npmjs.org/chromadb/latest | v3.4.3; @chroma-core/default-embed is devDependency, not runtime |
| 8 | chromadb-client npm | https://registry.npmjs.org/chromadb-client/latest | v2.4.6; chromadb-default-embed as optional peerDependency |
| 9 | @huggingface/transformers npm | https://registry.npmjs.org/@huggingface/transformers/latest | v4.2.0; depends on onnxruntime-node@1.24.3 |
| 10 | transformers.js env.js source (v3) | https://github.com/huggingface/transformers.js/blob/v3/src/env.js | Cache dir = package_root/.cache/; no env var support |
| 11 | transformers.js env API docs | https://huggingface.co/docs/transformers.js/en/api/env | env.cacheDir, env.allowRemoteModels, env.localModelPath configuration |
| 12 | transformers.js hub API docs | https://huggingface.co/docs/transformers.js/en/api/utils/hub | PretrainedOptions: cache_dir, local_files_only, progress_callback |
| 13 | transformers.js Node.js tutorial | https://huggingface.co/docs/transformers.js/tutorials/node | Singleton pattern recommendation; cache in node_modules/.cache/ |
| 14 | Xenova/all-MiniLM-L6-v2 model page | https://huggingface.co/Xenova/all-MiniLM-L6-v2 | 384-dim embeddings; 2.9M monthly downloads |
| 15 | Xenova/all-MiniLM-L6-v2 ONNX files | https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/main/onnx | model.onnx=90.4MB, model_quantized.onnx=23MB, model_uint8.onnx=22.8MB |
| 16 | ChromaDB GH Issue #2039 | https://github.com/chroma-core/chroma/issues/2039 | Feature request for local_files_only support (closed) |
| 17 | ChromaDB GH PR #7201 | https://github.com/chroma-core/chroma/pull/7201 | CI preload of ONNX model with caching at ~/.cache/chroma/onnx_models/ |
| 18 | transformers.js GH Issue #997 | https://github.com/huggingface/transformers.js/issues/997 | CJS build had hardcoded absolute cache path (fixed in PR #1012) |
| 19 | transformers.js GH Issue #1544 | https://github.com/huggingface/transformers.js/issues/1544 | Concurrent process access to cache fails (fixed in #1548) |
