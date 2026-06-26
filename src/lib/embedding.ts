import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Default model used for embedding generation.
 * Produces 384-dimensional vectors.
 */
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

/**
 * Quantization dtype for the ONNX model.
 * q8 (uint8 quantized) is ~24MB vs ~91MB for fp32.
 */
const MODEL_DTYPE = 'q8';

/**
 * Number of dimensions in the embedding vectors.
 */
const EMBEDDING_DIMENSIONS = 384;

/**
 * Default cache directory relative to the working directory.
 */
const DEFAULT_CACHE_DIR = path.join('.chromactl', 'models');

/**
 * Singleton embedding manager using @huggingface/transformers directly.
 *
 * Uses a cached pipeline instance to avoid reloading the ONNX model on
 * every call (unlike ChromaDB's DefaultEmbeddingFunction which recreates
 * the pipeline each time).
 *
 * The @huggingface/transformers package is dynamically imported on first
 * use to support lazy loading and because it may only be available
 * transitively through chromadb's dependency tree.
 */
export class EmbeddingManager {
  private static instance: EmbeddingManager | null = null;

  /** Cached pipeline instance — loaded once, reused for all subsequent calls. */
  private pipelineInstance: any = null;

  /** Promise that resolves to the pipeline during initialization.
   *  Prevents concurrent callers from triggering multiple loads. */
  private loadingPromise: Promise<any> | null = null;

  /** Directory where ONNX model files are cached on disk. */
  private cacheDir: string = DEFAULT_CACHE_DIR;

  /** Number of dimensions produced by the model. */
  readonly dimensions: number = EMBEDDING_DIMENSIONS;

  private constructor() {
    // Private — use getInstance()
  }

  /**
   * Return the singleton EmbeddingManager instance.
   */
  static getInstance(): EmbeddingManager {
    if (!EmbeddingManager.instance) {
      EmbeddingManager.instance = new EmbeddingManager();
    }
    return EmbeddingManager.instance;
  }

  /**
   * Generate embeddings for an array of texts.
   *
   * On the first call the ONNX model is downloaded (if not cached) and loaded
   * into memory. Subsequent calls reuse the cached pipeline.
   *
   * Each returned vector is mean-pooled across tokens and L2-normalized
   * to a unit vector (384 dimensions).
   *
   * @param texts - Non-empty array of text strings to embed.
   * @returns Array of 384-dimensional number arrays, one per input text.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const pipe = await this.ensurePipeline();

    try {
      const output = await pipe(texts, {
        pooling: 'mean',
        normalize: true,
      });
      return output.tolist() as number[][];
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Embedding inference failed: ${message}\n` +
          'Ensure the ONNX runtime is working correctly on this platform.',
      );
    }
  }

  /**
   * Convenience method to embed a single text string.
   *
   * @param text - The text to embed.
   * @returns A single 384-dimensional number array.
   */
  async embedSingle(text: string): Promise<number[]> {
    const results = await this.embed([text]);
    return results[0];
  }

  /**
   * Check whether the ONNX model files are already present in the cache
   * directory, meaning embedding can proceed without a network download.
   */
  isModelCached(): boolean {
    // The model file name depends on dtype. For q8 the file is model_q8.onnx.
    // Also check for other common names in case the dtype resolved differently.
    const modelDir = path.resolve(
      this.cacheDir,
      'Xenova',
      'all-MiniLM-L6-v2',
      'onnx',
    );

    try {
      // Check for any ONNX model file — the exact name varies by dtype
      if (!fs.existsSync(modelDir)) {
        return false;
      }
      const entries = fs.readdirSync(modelDir);
      return entries.some((entry) => entry.endsWith('.onnx'));
    } catch {
      return false;
    }
  }

  /**
   * Set a custom directory for caching ONNX model files.
   *
   * Must be called **before** the first call to `embed()` or `embedSingle()`.
   * After the pipeline has been initialized, changing the cache directory
   * has no effect.
   *
   * @param dir - Absolute or relative path to the cache directory.
   */
  setCacheDir(dir: string): void {
    this.cacheDir = dir;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Ensure the pipeline is initialized exactly once, handling concurrent
   * callers safely via a shared loading promise.
   */
  private async ensurePipeline(): Promise<any> {
    if (this.pipelineInstance) {
      return this.pipelineInstance;
    }

    if (!this.loadingPromise) {
      this.loadingPromise = this.initPipeline();
    }

    try {
      this.pipelineInstance = await this.loadingPromise;
    } catch (err) {
      // Reset so a subsequent call can retry
      this.loadingPromise = null;
      throw err;
    }

    return this.pipelineInstance;
  }

  /**
   * Dynamically import @huggingface/transformers and create the
   * feature-extraction pipeline.
   */
  private async initPipeline(): Promise<any> {
    let transformers: any;

    try {
      // Use a variable to prevent TypeScript from resolving the module
      // at compile time — the package may only be available transitively.
      const moduleName = '@huggingface/transformers';
      transformers = await import(/* webpackIgnore: true */ moduleName);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to load @huggingface/transformers: ${message}\n` +
          'This package is required for embedding generation. ' +
          'Install it with: npm install @huggingface/transformers',
      );
    }

    const { pipeline, env } = transformers;

    // Configure cache directory before loading the model
    const resolvedCacheDir = path.resolve(this.cacheDir);
    env.cacheDir = resolvedCacheDir;

    // Ensure the cache directory exists
    fs.mkdirSync(resolvedCacheDir, { recursive: true });

    try {
      const pipe = await pipeline('feature-extraction', MODEL_NAME, {
        dtype: MODEL_DTYPE,
      });
      return pipe;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // Distinguish network errors from other failures
      if (
        message.includes('fetch') ||
        message.includes('network') ||
        message.includes('ENOTFOUND') ||
        message.includes('ECONNREFUSED') ||
        message.includes('ETIMEDOUT') ||
        message.includes('Failed to fetch')
      ) {
        throw new Error(
          `Failed to download the embedding model (${MODEL_NAME}): ${message}\n` +
            'Ensure you have network access for the initial model download (~24MB).\n' +
            'Once downloaded, the model is cached locally for offline use.',
        );
      }

      throw new Error(
        `Failed to initialize the ONNX embedding pipeline: ${message}\n` +
          'The ONNX runtime may not be supported on this platform.',
      );
    }
  }
}
