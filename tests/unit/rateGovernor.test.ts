import { describe, it, expect } from '@jest/globals';
import { RateGovernor, parseRules, parseState, policyForUrl } from '../../src/services/rateGovernor.js';

function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name] ?? null };
}

describe('RateGovernor', () => {
  it('classifies trade endpoints', () => {
    expect(policyForUrl('https://www.pathofexile.com/api/trade/search/Standard')).toBe('search');
    expect(policyForUrl('https://www.pathofexile.com/api/trade/fetch/a,b?query=x')).toBe('fetch');
    expect(policyForUrl('https://www.pathofexile.com/api/trade/data/leagues')).toBe('other');
  });

  it('parses rule and state headers', () => {
    expect(parseRules('8:10:60,15:60:120')).toEqual([{ max: 8, periodSec: 10 }, { max: 15, periodSec: 60 }]);
    expect(parseState('3:10:0,4:60:30')[1]).toEqual({ hits: 4, periodSec: 60, restrictedSec: 30 });
  });

  it('never uses the last slot of a tier and waits for the oldest request to age out', () => {
    let now = 0;
    const g = new RateGovernor(() => now);
    g.update('search', headers({ 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '3:10:60', 'X-Rate-Limit-Ip-State': '0:10:0' }));
    g.record('search'); now = 1000;
    expect(g.waitMs('search')).toBe(0);
    g.record('search'); now = 2000;
    // 2 of 3 used: the third (last) slot is kept free
    const wait = g.waitMs('search');
    expect(wait).toBeGreaterThan(7000);
    expect(wait).toBeLessThanOrEqual(8050);
    now = 10_100;
    expect(g.waitMs('search')).toBe(0);
  });

  it('respects the strictest of several tiers', () => {
    let now = 0;
    const g = new RateGovernor(() => now);
    g.update('search', headers({ 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '10:10:60,3:300:600', 'X-Rate-Limit-Ip-State': '0:10:0,0:300:0' }));
    g.record('search'); now += 20_000; g.record('search'); now += 20_000;
    // 2 of 3 in the 300s tier: must wait until the first ages out of 300s
    expect(g.waitMs('search')).toBeGreaterThan(250_000);
  });

  it('adopts higher hit counts the server reports (e.g. browser searches)', () => {
    let now = 0;
    const g = new RateGovernor(() => now);
    g.update('search', headers({ 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '5:10:60', 'X-Rate-Limit-Ip-State': '4:10:0' }));
    expect(g.waitMs('search')).toBeGreaterThan(9000);
  });

  it('does not let a long window count block a short window (real trade headers)', () => {
    let now = 0;
    const g = new RateGovernor(() => now);
    g.record('search');
    g.update('search', headers({
      'X-Rate-Limit-Rules': 'Ip',
      'X-Rate-Limit-Ip': '5:10:60,15:60:300,30:300:1800,600:21600:3600',
      'X-Rate-Limit-Ip-State': '1:10:0,2:60:0,4:300:0,17:21600:0',
    }));
    now = 2000;
    expect(g.waitMs('search')).toBe(0);
    // ...but the 60s tier is honoured once the server says it is nearly full
    g.update('search', headers({
      'X-Rate-Limit-Rules': 'Ip',
      'X-Rate-Limit-Ip': '5:10:60,15:60:300,30:300:1800,600:21600:3600',
      'X-Rate-Limit-Ip-State': '1:10:0,14:60:0,14:300:0,30:21600:0',
    }));
    expect(g.waitMs('search')).toBeGreaterThan(50_000);
  });

  it('pauses for a server restriction and Retry-After', () => {
    let now = 0;
    const g = new RateGovernor(() => now);
    g.update('search', headers({ 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '5:10:60', 'X-Rate-Limit-Ip-State': '6:10:60' }), 429);
    expect(g.blockedForSec()).toBe(60);
    expect(g.waitMs('fetch')).toBeGreaterThanOrEqual(60_000);
    const g2 = new RateGovernor(() => now);
    g2.update('fetch', headers({ 'Retry-After': '12' }), 429);
    expect(g2.blockedForSec()).toBe(12);
  });

  it('uses conservative defaults before any headers are seen', () => {
    let now = 0;
    const g = new RateGovernor(() => now);
    for (let i = 0; i < 4; i++) { g.record('search'); now += 100; }
    expect(g.waitMs('search')).toBeGreaterThan(0);
  });
});
