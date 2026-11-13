/**
 * Keeps trade API traffic inside the limits pathofexile.com publishes.
 *
 * Every trade response carries its rate-limit policy, e.g.
 *   X-Rate-Limit-Policy: trade-search-request-limit
 *   X-Rate-Limit-Rules:  Ip,Account
 *   X-Rate-Limit-Ip:       8:10:60,15:60:120,60:300:1800   (max:periodSec:penaltySec)
 *   X-Rate-Limit-Ip-State: 1:10:0,1:60:0,1:300:0          (hits:periodSec:restrictedSec)
 *
 * The governor remembers when we sent each request per policy and, before the
 * next one, waits until every tier still has headroom (it never uses the last
 * slot of a tier). It also adopts the server's own hit counts, so requests
 * made elsewhere (e.g. the trade site in your browser) are accounted for, and
 * honours restrictions / Retry-After by pausing until they expire.
 */

export interface RateRule {
  max: number;
  periodSec: number;
}

type HeaderGetter = { get(name: string): string | null };

/** Conservative limits used until the server has told us its real ones. */
const DEFAULT_RULES: Record<string, RateRule[]> = {
  search: [{ max: 5, periodSec: 10 }, { max: 12, periodSec: 60 }, { max: 40, periodSec: 300 }],
  fetch: [{ max: 8, periodSec: 4 }, { max: 12, periodSec: 12 }],
  other: [{ max: 5, periodSec: 10 }],
};

export function policyForUrl(url: string): string {
  if (url.includes('/api/trade/search/')) return 'search';
  if (url.includes('/api/trade/fetch/')) return 'fetch';
  return 'other';
}

export function parseRules(value: string | null): RateRule[] {
  if (!value) return [];
  return value.split(',').map((part) => {
    const [max, period] = part.split(':').map(Number);
    return { max, periodSec: period };
  }).filter((r) => r.max > 0 && r.periodSec > 0);
}

export function parseState(value: string | null): { hits: number; periodSec: number; restrictedSec: number }[] {
  if (!value) return [];
  return value.split(',').map((part) => {
    const [hits, period, restricted] = part.split(':').map(Number);
    return { hits: hits || 0, periodSec: period || 0, restrictedSec: restricted || 0 };
  });
}

export class RateGovernor {
  private readonly history = new Map<string, number[]>();
  private readonly rules = new Map<string, RateRule[]>();
  private blockedUntil = 0;

  constructor(private readonly now: () => number = () => Date.now(), private readonly headroom = 1) {}

  private rulesFor(policy: string): RateRule[] {
    return this.rules.get(policy) ?? DEFAULT_RULES[policy] ?? DEFAULT_RULES.other;
  }

  private stamps(policy: string): number[] {
    let list = this.history.get(policy);
    if (!list) { list = []; this.history.set(policy, list); }
    const longest = Math.max(...this.rulesFor(policy).map((r) => r.periodSec), 1) * 1000;
    const cutoff = this.now() - longest;
    while (list.length && list[0] <= cutoff) list.shift();
    return list;
  }

  /** Milliseconds to wait before a request under this policy is safe. */
  waitMs(policy: string): number {
    const now = this.now();
    let wait = Math.max(0, this.blockedUntil - now);
    const list = this.stamps(policy);
    for (const rule of this.rulesFor(policy)) {
      const allowed = Math.max(1, rule.max - this.headroom);
      const windowStart = now - rule.periodSec * 1000;
      const inWindow = list.filter((t) => t > windowStart);
      if (inWindow.length >= allowed) {
        // The request that must age out of the window before we may send.
        const mustExpire = inWindow[inWindow.length - allowed];
        wait = Math.max(wait, mustExpire + rule.periodSec * 1000 - now + 50);
      }
    }
    return wait;
  }

  /** Record that a request is being sent now. */
  record(policy: string): void {
    this.stamps(policy).push(this.now());
  }

  /** Learn limits and current usage from a trade API response. */
  update(policy: string, headers: HeaderGetter, status?: number): void {
    const now = this.now();
    const ruleNames = (headers.get('X-Rate-Limit-Rules') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const learned: RateRule[] = [];
    for (const name of ruleNames) {
      const rules = parseRules(headers.get(`X-Rate-Limit-${name}`));
      const state = parseState(headers.get(`X-Rate-Limit-${name}-State`));
      learned.push(...rules);
      for (const s of state) {
        if (s.restrictedSec > 0) this.blockedUntil = Math.max(this.blockedUntil, now + s.restrictedSec * 1000);
        // Adopt the server's count when it has seen more requests than we sent.
        const list = this.stamps(policy);
        const ours = list.filter((t) => t > now - s.periodSec * 1000).length;
        for (let i = ours; i < s.hits; i++) list.push(now);
        list.sort((a, b) => a - b);
      }
    }
    if (learned.length) this.rules.set(policy, learned);
    const retryAfter = Number(headers.get('Retry-After'));
    if (retryAfter > 0) this.blockedUntil = Math.max(this.blockedUntil, now + retryAfter * 1000);
    if (status === 429 && !(retryAfter > 0)) this.blockedUntil = Math.max(this.blockedUntil, now + 60_000);
  }

  /** Seconds until any server-imposed block ends (0 when not blocked). */
  blockedForSec(): number {
    return Math.max(0, Math.ceil((this.blockedUntil - this.now()) / 1000));
  }
}
