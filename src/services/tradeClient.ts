import Bottleneck from 'bottleneck';
import { getPoeSessionId } from '../utils/poeSession.js';
import { RateGovernor, policyForUrl } from './rateGovernor.js';
import {
  TradeQuery,
  SearchResult,
  FetchResult,
  LeagueData,
  RateLimitInfo,
  CacheEntry,
  ItemListing,
} from '../types/tradeTypes.js';

/** 4xx or 429: retrying the identical request will not fix it. */
class FinalApiError extends Error {}

/**
 * Client for interacting with the Path of Exile Trade API
 *
 * Features:
 * - Polite by default: one request per 2s, every limit tier pathofexile.com
 *   publishes is respected before it is reached (RateGovernor), a per-question
 *   request budget, 429s are never retried, and the session cookie is only
 *   sent to pathofexile.com
 * - Response caching with TTL
 * - Automatic retry with exponential backoff
 * - Rate limit header parsing
 */
export class TradeApiClient {
  private readonly baseUrl = 'https://www.pathofexile.com/api/trade';
  private readonly limiter: Bottleneck;
  // Bounded LRU: entries are TTL-expiring listings/results, but TTL expiry
  // only happens on read — a client that searches many distinct queries
  // would otherwise accumulate cache entries for its whole lifetime.
  private static readonly MAX_CACHE_ENTRIES = 200;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly defaultCacheTTL: number;
  private rateLimitInfo: RateLimitInfo | null = null;
  // Transient failures (connection reset, timeout, 5xx) are retried with
  // exponential backoff. 429 is NOT retried here: the limiter hook honours
  // the server's Retry-After instead. Search POSTs are cheap and idempotent
  // in effect (a duplicate search costs one query, listings are read-only).
  private readonly retryMaxAttempts: number;
  private readonly retryBaseDelayMs: number;

  private readonly governor: RateGovernor;
  /** Network requests allowed per AI tool call (cache hits are free). */
  private readonly maxRequestsPerCall: number;
  private requestsLeft = Infinity;
  /** Longest pause we accept before giving up and asking the user to retry. */
  private readonly maxWaitMs: number;

  constructor(options?: {
    requestsPerSecond?: number;
    cacheTTL?: number;
    maxRetries?: number;
    retryBaseDelayMs?: number;
    maxRequestsPerCall?: number;
    maxWaitMs?: number;
    governor?: RateGovernor;
  }) {
    // Default pace: one request every 2 seconds. The governor below adds the
    // server's own multi-tier limits on top of this.
    const requestsPerSecond = options?.requestsPerSecond && options.requestsPerSecond > 0 ? options.requestsPerSecond : 0.5;
    this.defaultCacheTTL = (options?.cacheTTL || 300) * 1000; // Convert to ms
    this.retryMaxAttempts = 1 + Math.max(0, options?.maxRetries ?? 2);
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? 500;
    this.maxRequestsPerCall = options?.maxRequestsPerCall ?? 16;
    this.maxWaitMs = options?.maxWaitMs ?? 45_000;
    this.governor = options?.governor ?? new RateGovernor();

    this.limiter = new Bottleneck({
      maxConcurrent: 1, // One request at a time
      minTime: Math.ceil(1000 / requestsPerSecond), // Minimum time between requests
    });

    this.limiter.on('retry', (_error, jobInfo) => {
      console.error(`[TradeAPI] Retrying request (attempt ${jobInfo.retryCount + 1})`);
    });
  }

  /**
   * Search for items matching the given query
   */
  async searchItems(league: string, query: TradeQuery): Promise<SearchResult> {
    const cacheKey = `search:${league}:${JSON.stringify(query)}`;
    const cached = this.getFromCache<SearchResult>(cacheKey);
    if (cached) {
      return cached;
    }

    const url = `${this.baseUrl}/search/${encodeURIComponent(league)}`;
    const result = await this.limiter.schedule(() =>
      this.makeRequest<SearchResult>('POST', url, query)
    );

    this.putInCache(cacheKey, result, this.defaultCacheTTL);
    return result;
  }

  /**
   * Fetch full item details for the given item IDs.
   * The Trade API caps one fetch request at 10 ids; larger lists are
   * batched into sequential requests (rate limiter already serializes them).
   */
  async fetchItems(itemIds: string[], queryId?: string): Promise<ItemListing[]> {
    if (itemIds.length === 0) {
      return [];
    }

    if (itemIds.length > 10) {
      const all: ItemListing[] = [];
      for (let i = 0; i < itemIds.length; i += 10) {
        all.push(...(await this.fetchItems(itemIds.slice(i, i + 10), queryId)));
      }
      return all;
    }

    const cacheKey = `fetch:${itemIds.join(',')}`;
    const cached = this.getFromCache<ItemListing[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const idsParam = itemIds.join(',');
    const url = queryId
      ? `${this.baseUrl}/fetch/${idsParam}?query=${queryId}`
      : `${this.baseUrl}/fetch/${idsParam}`;

    const result = await this.limiter.schedule(() =>
      this.makeRequest<FetchResult>('GET', url)
    );

    const items = result.result || [];
    this.putInCache(cacheKey, items, this.defaultCacheTTL);
    return items;
  }

  /**
   * Get available leagues
   * This data changes infrequently, so we cache it for 1 hour
   */
  async getLeagues(): Promise<LeagueData> {
    const cacheKey = 'leagues:all';
    const cached = this.getFromCache<LeagueData>(cacheKey, 3600000); // 1 hour
    if (cached) {
      return cached;
    }

    const url = `${this.baseUrl}/data/leagues`;
    const result = await this.limiter.schedule(() =>
      this.makeRequest<LeagueData>('GET', url)
    );

    this.putInCache(cacheKey, result, 3600000); // Cache for 1 hour
    return result;
  }

  // ========================================
  // Private Methods
  // ========================================

  /**
   * Start a new AI tool call: resets the per-call request budget so one
   * question can never fire an unbounded number of trade requests.
   */
  beginCall(): void {
    this.requestsLeft = this.maxRequestsPerCall;
  }

  /** Waits until the request fits every published limit, then reserves it. */
  private async awaitSlot(url: string): Promise<void> {
    if (this.requestsLeft <= 0) {
      throw new FinalApiError(
        `Stopped after ${this.maxRequestsPerCall} trade requests for this question to stay well inside pathofexile.com's limits. ` +
        `Results so far are above; ask again to continue.`,
      );
    }
    const policy = policyForUrl(url);
    const wait = this.governor.waitMs(policy);
    if (wait > this.maxWaitMs) {
      throw new FinalApiError(
        `pathofexile.com asks for a pause of about ${Math.ceil(wait / 1000)}s before more ${policy} requests. ` +
        `Nothing is wrong with your account; try again after that.`,
      );
    }
    if (wait > 0) {
      console.error(`[TradeAPI] pausing ${wait}ms to stay inside the ${policy} rate limit`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.governor.record(policy);
    this.requestsLeft--;
  }

  private async makeRequest<T>(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown
  ): Promise<T> {
    // The session cookie only ever goes to pathofexile.com itself.
    const sessionId = new URL(url).hostname === 'www.pathofexile.com' ? getPoeSessionId() : undefined;
    const policy = policyForUrl(url);
    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'pob-mcp-server/1.0',
        // The official Trade API rejects anonymous weighted-sum searches
        ...(sessionId ? { Cookie: `POESESSID=${sessionId}` } : {}),
      },
      // The 30s timeout lives on the per-attempt signal: without one, a
      // stalled connection blocked the whole queue (limiter maxConcurrent 1).
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    for (let attempt = 1; ; attempt++) {
      try {
        // Fresh timeout per attempt: an AbortSignal.timeout fires once, and a
        // reused (expired) signal would fail every retry instantly.
        await this.awaitSlot(url);
        options.signal = AbortSignal.timeout(30_000);
        const response = await fetch(url, options);

        // Parse rate limit headers
        this.updateRateLimitInfo(response);
        this.governor.update(policy, response.headers, response.status);

        // Handle rate limiting: never retried automatically
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10) * 1000;
          this.rateLimitInfo = {
            limit: this.rateLimitInfo?.limit || 0,
            remaining: 0,
            retryAfter,
          };
          throw new FinalApiError(`pathofexile.com asked us to slow down; pausing trade requests for ${Math.ceil(retryAfter / 1000)}s.`);
        }

        if (response.status >= 500) {
          // Cloudflare/origin flakes on the trade API are common; worth another attempt.
          const errorText = await response.text();
          throw new Error(`Trade API request failed (${response.status}): ${errorText}`);
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new FinalApiError(`Trade API request failed (${response.status}): ${errorText}`);
        }

        return await response.json() as T;
      } catch (error) {
        // Network/timeout rejections (fetch throws TypeError/TimeoutError) and
        // 5xx arrive here as retryable; 4xx/429 are FinalApiError.
        if (error instanceof FinalApiError || attempt >= this.retryMaxAttempts) {
          throw error;
        }
        const delayMs = this.retryBaseDelayMs * 2 ** (attempt - 1);
        console.error(`[TradeAPI] transient failure (${error instanceof Error ? error.message : String(error)}), retrying in ${delayMs}ms (attempt ${attempt}/${this.retryMaxAttempts})`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private updateRateLimitInfo(response: Response): void {
    const limitHeader = response.headers.get('X-Rate-Limit-Ip');
    const stateHeader = response.headers.get('X-Rate-Limit-Ip-State');
    const retryAfterHeader = response.headers.get('Retry-After');

    if (limitHeader && stateHeader) {
      // Parse format: "limit:max:period"
      const [, maxRequests] = limitHeader.split(':').map(Number);
      // Parse format: "current:max:period"
      const [current] = stateHeader.split(':').map(Number);

      this.rateLimitInfo = {
        limit: maxRequests || 0,
        remaining: Math.max(0, (maxRequests || 0) - (current || 0)),
        retryAfter: retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : undefined,
      };
    }
  }

  private getFromCache<T>(key: string, customTTL?: number): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    const now = Date.now();
    const expiresAt = customTTL !== undefined ? entry.timestamp + customTTL : entry.expiresAt;
    if (now > expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Map iteration order is insertion order: re-inserting on hit makes the
    // eviction below drop stale-by-use entries instead of stale-by-insertion.
    this.cache.delete(key);
    this.cache.set(key, entry);

    // The key encodes the request shape, so hits always hold this T; the cache
    // itself only stores `unknown` envelopes.
    return entry.data as T;
  }

  private putInCache<T>(key: string, data: T, ttl: number): void {
    const now = Date.now();
    this.cache.set(key, {
      data,
      timestamp: now,
      expiresAt: now + ttl,
    });
    while (this.cache.size > TradeApiClient.MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}
