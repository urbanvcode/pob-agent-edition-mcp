import { describe, it, expect } from '@jest/globals';
import { evaluateCandidate } from '../../src/handlers/upgradePlanHandler.js';
import { tradeItemToPoBText, priceInChaos } from '../../src/services/tradeItemText.js';

const base = { CombinedDPS: 1000, TotalEHP: 10000, Life: 4000, FireResist: 75, ColdResist: 75, LightningResist: 75, ChaosResist: 20, Str: 100, ReqStr: 90, Dex: 100, ReqDex: 0, Int: 100, ReqInt: 0, ManaUnreserved: 50 };

describe('evaluateCandidate', () => {
  it('rewards DPS and EHP gains', () => {
    const ev = evaluateCandidate(base, { ...base, CombinedDPS: 1100, TotalEHP: 10500, Life: 4100 }, 'balanced');
    expect(ev.dpsPct).toBeCloseTo(10);
    expect(ev.ehpPct).toBeCloseTo(5);
    expect(ev.lifeDelta).toBe(100);
    expect(ev.score).toBeGreaterThan(10);
    expect(ev.warnings).toHaveLength(0);
  });

  it('warns and penalises when a resistance drops below the cap', () => {
    const ev = evaluateCandidate(base, { ...base, CombinedDPS: 1050, FireResist: 60 }, 'balanced');
    expect(ev.warnings.join(' ')).toMatch(/Fire res drops to 60%/);
    expect(ev.score).toBeLessThan(0);
  });

  it('flags unmet attribute requirements', () => {
    const ev = evaluateCandidate(base, { ...base, CombinedDPS: 1200, Str: 80 }, 'dps');
    expect(ev.warnings.join(' ')).toMatch(/Str requirement not met/);
  });

  it('notes resistance fixes', () => {
    const low = { ...base, ColdResist: 60 };
    const ev = evaluateCandidate(low, { ...low, ColdResist: 75 }, 'defence');
    expect(ev.resNotes.join(' ')).toMatch(/Cold res 60% -> 75%/);
  });
});

describe('trade item conversion', () => {
  it('builds PoB item text with sockets, implicits and crafted mods', () => {
    const text = tradeItemToPoBText({
      frameType: 2, name: 'Doom Visor', typeLine: 'Lacquered Helmet', ilvl: 84,
      properties: [{ name: 'Quality', values: [['+20%', 1]] }],
      sockets: [{ group: 0, sColour: 'R' }, { group: 0, sColour: 'G' }, { group: 1, sColour: 'B' }],
      implicitMods: ['+1 to Level of Socketed Gems'],
      explicitMods: ['+80 to maximum Life', '+40% to [Resistances|Fire Resistance]'],
      craftedMods: ['+25% to Cold Resistance'],
      corrupted: true,
    } as never);
    expect(text).toContain('Rarity: RARE');
    expect(text).toContain('Doom Visor\nLacquered Helmet');
    expect(text).toContain('Quality: +20%');
    expect(text).toContain('Sockets: R-G B');
    expect(text).toContain('Implicits: 1');
    expect(text).toContain('+40% to Fire Resistance');
    expect(text).toContain('{crafted}+25% to Cold Resistance');
    expect(text.endsWith('Corrupted')).toBe(true);
  });

  it('converts prices to chaos', () => {
    const rates = new Map([['Chaos Orb', 1], ['Divine Orb', 200]]);
    expect(priceInChaos({ amount: 2, currency: 'divine' }, rates)).toBe(400);
    expect(priceInChaos({ amount: 15, currency: 'chaos' }, rates)).toBe(15);
    expect(priceInChaos({ amount: 1, currency: 'unknown-orb' }, rates)).toBeUndefined();
  });
});
