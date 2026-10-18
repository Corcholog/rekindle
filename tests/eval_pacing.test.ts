import { describe, it, expect } from 'vitest';

// Free tiers cap requests per minute; pacing keeps a run under the cap instead of hitting 429s.
describe('provider pacing in eval configs', () => {
  it('spaces consecutive calls by at least minIntervalMs', async () => {
    const { ConfiguredProvider } = await import('../evals/runner/chainSpec');
    const starts: number[] = [];
    const inner = { name: 'gemini', model: 'm', async complete() { starts.push(Date.now()); return { data: {} }; } };
    const paced = new ConfiguredProvider(inner as any, {}, 120);

    await paced.complete('s', 'u', {} as any);
    await paced.complete('s', 'u', {} as any);
    await paced.complete('s', 'u', {} as any);

    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(115);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(115);
  });

  it('does not delay the first call or unpaced providers', async () => {
    const { ConfiguredProvider } = await import('../evals/runner/chainSpec');
    const inner = { name: 'ollama', model: 'm', async complete() { return { data: {} }; } };
    const started = Date.now();
    await new ConfiguredProvider(inner as any, {}, 0).complete('s', 'u', {} as any);
    await new ConfiguredProvider(inner as any, {}, 5000).complete('s', 'u', {} as any);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('forwards the fixed options', async () => {
    const { ConfiguredProvider } = await import('../evals/runner/chainSpec');
    let seen: unknown;
    const inner = { name: 'deepseek', model: 'm', async complete(_s: string, _u: string, _sc: unknown, o: unknown) { seen = o; return { data: {} }; } };
    await new ConfiguredProvider(inner as any, { thinking: false }).complete('s', 'u', {} as any, { thinking: true });
    expect(seen).toEqual({ thinking: false });
  });
});
