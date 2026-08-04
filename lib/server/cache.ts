export const CACHE_TTLS = {
  firms: 10 * 60 * 1_000,
  nwsPointMapping: 24 * 60 * 60 * 1_000,
  nwsObservations: 30 * 60 * 1_000,
  airnow: 60 * 60 * 1_000,
  wfigs: 5 * 60 * 1_000,
} as const;

export interface CachedValue<T> {
  value: T;
  cache: "hit" | "miss";
  cachedAt: string;
  expiresAt: string;
}

export interface CacheLoadOptions {
  signal?: AbortSignal;
  refresh?: boolean;
}

interface CacheEntry<T> {
  value: T;
  cachedAt: number;
  expiresAt: number;
}

export interface TtlCache {
  getOrLoad<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    options?: CacheLoadOptions,
  ): Promise<CachedValue<T>>;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function waitWithSignal<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class MemoryTtlCache implements TtlCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly pending = new Map<string, Promise<CachedValue<unknown>>>();
  private readonly generations = new Map<string, number>();

  constructor(private readonly clock: () => number = Date.now) {}

  async getOrLoad<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    options: CacheLoadOptions = {},
  ): Promise<CachedValue<T>> {
    throwIfAborted(options.signal);
    const currentGeneration = this.generations.get(key) ?? 0;
    const generation = options.refresh
      ? currentGeneration + 1
      : currentGeneration;
    if (options.refresh) this.generations.set(key, generation);
    const current = this.clock();
    const existing = this.entries.get(key) as CacheEntry<T> | undefined;
    if (!options.refresh && existing && current < existing.expiresAt) {
      return {
        value: existing.value,
        cache: "hit",
        cachedAt: new Date(existing.cachedAt).toISOString(),
        expiresAt: new Date(existing.expiresAt).toISOString(),
      };
    }
    if (!options.refresh) this.entries.delete(key);

    const pending = this.pending.get(key) as Promise<CachedValue<T>> | undefined;
    if (!options.refresh && pending) {
      return waitWithSignal(pending, options.signal);
    }

    const work: Promise<CachedValue<T>> = Promise.resolve()
      .then(() => {
        throwIfAborted(options.signal);
        return loader();
      })
      .then((value) => {
        throwIfAborted(options.signal);
        const cachedAt = this.clock();
        const expiresAt = cachedAt + Math.max(0, ttlMs);
        if ((this.generations.get(key) ?? 0) === generation) {
          this.entries.set(key, { value, cachedAt, expiresAt });
        }
        return {
          value,
          cache: "miss" as const,
          cachedAt: new Date(cachedAt).toISOString(),
          expiresAt: new Date(expiresAt).toISOString(),
        };
      })
      .catch((error: unknown) => {
        throwIfAborted(options.signal);
        if (options.refresh && existing && current < existing.expiresAt) {
          return {
            value: existing.value,
            cache: "hit" as const,
            cachedAt: new Date(existing.cachedAt).toISOString(),
            expiresAt: new Date(existing.expiresAt).toISOString(),
          };
        }
        throw error;
      })
      .finally(() => {
        if (this.pending.get(key) === work) this.pending.delete(key);
      });
    if (!options.refresh) this.pending.set(key, work);
    return waitWithSignal(work, options.signal);
  }
}

export const sourceCache = new MemoryTtlCache();
