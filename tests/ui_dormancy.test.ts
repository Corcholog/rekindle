import { describe, it, expect } from 'vitest';
import { heatOf, sortProjects, rekindles, DORMANT_AFTER_DAYS } from '../web/src/lib/dormancy';
import { DORMANT_AFTER_DAYS as SERVER_DORMANT_AFTER_DAYS } from '../src/vault/dormancy';

const project = (title: string, idleDays: number | null, active: number) => ({
  title, idleDays, isDormant: idleDays !== null && idleDays >= 14,
  counts: { pending: active, accepted: 0, discarded: 0, tentative: 0, active, total: active },
});

describe('ember logic in the web UI', () => {
  it('uses the same dormancy cutoff as the server', () => {
    expect(DORMANT_AFTER_DAYS).toBe(SERVER_DORMANT_AFTER_DAYS);
  });

  it('heats up with idle days', () => {
    expect([heatOf(null), heatOf(0), heatOf(6), heatOf(7), heatOf(13), heatOf(14), heatOf(90)])
      .toEqual(['ash', 'ash', 'ash', 'warm', 'warm', 'hot', 'hot']);
  });

  it('lists dormant projects with something to review first', () => {
    const sorted = sortProjects([
      project('Activo con mucho', 1, 5),
      project('Dormido sin nada', 60, 0),
      project('Dormido con una', 30, 1),
      project('Sin fecha', null, 0),
    ]).map(p => p.title);
    expect(sorted).toEqual(['Dormido con una', 'Activo con mucho', 'Dormido sin nada', 'Sin fecha']);
  });

  it('marks a suggestion as rekindling only when the project was dormant when evaluated', () => {
    expect([rekindles(null), rekindles(13), rekindles(14), rekindles(40)]).toEqual([false, false, true, true]);
  });
});
