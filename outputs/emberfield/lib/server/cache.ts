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
  ): Promise<CachedValue<T>>;
}

export class MemoryTtlCache implements TtlCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly pending = new Map<string, Promise<CachedValue<unknown>>>();

  constructor(private readonly clock: () => number = Date.now) {}

  async getOrLoad<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
  ): Promise<CachedValue<T>> {
    const current = this.clock();
    const existing = this.entries.get(key) as CacheEntry<T> | undefined;
    if (existing && current < existing.expiresAt) {
      return {
        value: existing.value,
        cache: "hit",
        cachedAt: new Date(existing.cachedAt).toISOString(),
        expiresAt: new Date(existing.expiresAt).toISOString(),
      };
    }
    this.entries.delete(key);

    const pending = this.pending.get(key) as Promise<CachedValue<T>> | undefined;
    if (pending) return pending;

    const work = loader()
      .then((value) => {
        const cachedAt = this.clock();
        const expiresAt = cachedAt + Math.max(0, ttlMs);
        this.entries.set(key, { value, cachedAt, expiresAt });
        return {
          value,
          cache: "miss" as const,
          cachedAt: new Date(cachedAt).toISOString(),
          expiresAt: new Date(expiresAt).toISOString(),
        };
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, work);
    return work;
  }
}

export const sourceCache = new MemoryTtlCache();
