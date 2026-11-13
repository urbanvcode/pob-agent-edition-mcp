import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getProfile, updateProfile, markLearned, normalizeProfile, answerRules, profileSummaryLine } from '../../src/utils/playerProfile.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pob-profile-'));
const file = path.join(dir, 'AgentEdition.json');
const savedEnv = process.env.POB_AGENT_SETTINGS;

describe('player profile', () => {
  beforeEach(() => {
    process.env.POB_AGENT_SETTINGS = file;
    fs.writeFileSync(file, JSON.stringify({ POESESSID: 'secret123' }));
  });
  afterAll(() => {
    if (savedEnv === undefined) delete process.env.POB_AGENT_SETTINGS; else process.env.POB_AGENT_SETTINGS = savedEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns defaults when no profile is stored', () => {
    const { profile, stored } = getProfile();
    expect(stored).toBe(false);
    expect(profile).toMatchObject({ playMode: 'trade', explanationMode: 'teach', experience: 'poe2', league: '', goals: [], learnedTopics: [] });
  });

  it('normalizes bad values', () => {
    const p = normalizeProfile({ playMode: 'hc', currency: { chaos: '12.6', divine: -3 }, goals: ['a', 'A', ' ', 'b'] });
    expect(p.playMode).toBe('trade');
    expect(p.currency).toMatchObject({ chaos: 13, divine: 0 });
    expect(p.goals).toEqual(['a', 'b']);
  });

  it('updates only given fields and keeps the POESESSID', () => {
    const r = updateProfile({ playMode: 'ssf', currency: { chaos: 300 }, add_goals: ['farm maps'] });
    expect(r.changed.sort()).toEqual(['currency', 'goals', 'playMode']);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data.POESESSID).toBe('secret123');
    expect(data.profile.playMode).toBe('ssf');
    expect(data.profile.currency.chaos).toBe(300);
    expect(data.profile.currency.updated).toBeDefined();
    expect(updateProfile({ playMode: 'ssf' }).changed).toEqual([]);
    expect(updateProfile({ hardcore: true }).changed).toEqual(['hardcore']);
    expect(getProfile().profile.hardcore).toBe(true);
  });

  it('rejects invalid enums', () => {
    expect(() => updateProfile({ explanationMode: 'verbose' })).toThrow(/explanationMode/);
  });

  it('marks learned topics once (case-insensitive) and resets them', () => {
    expect(markLearned(['Pantheon', 'flasks']).added).toEqual(['Pantheon', 'flasks']);
    expect(markLearned(['pantheon']).added).toEqual([]);
    expect(getProfile().profile.learnedTopics).toEqual(['Pantheon', 'flasks']);
    updateProfile({ reset_learned: true });
    expect(getProfile().profile.learnedTopics).toEqual([]);
  });

  it('answer rules change with play mode and explanation mode', () => {
    const base = normalizeProfile({});
    const ssfDeep = normalizeProfile({ playMode: 'ssf', explanationMode: 'deep' });
    expect(answerRules(base).join(' ')).toMatch(/TRADE/);
    expect(answerRules(base).join(' ')).toMatch(/TEACH/);
    expect(answerRules(ssfDeep).join(' ')).toMatch(/Do NOT suggest buying/);
    expect(answerRules(ssfDeep).join(' ')).toMatch(/DEEP DIVE/);
    expect(profileSummaryLine(ssfDeep)).toMatch(/SSF Softcore \| explanations: Deep dive/);
    expect(answerRules(base).join(' ')).not.toMatch(/HARDCORE/);
    expect(answerRules(normalizeProfile({ hardcore: true })).join(' ')).toMatch(/HARDCORE: one death/);
  });
});
