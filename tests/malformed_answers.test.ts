import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { z } from 'zod';

// A model answer that is not JSON is retried and then handed to the next provider. To find out why
// it happens, each failure is described without any of its text (telemetry and logs never hold
// model text), and with LLM_DEBUG_DIR set, the whole answer is saved locally for the owner.

const schema = z.object({ verdict: z.string(), reasoning: z.string() });
const SECRET = 'faro-de-la-isla';

describe('describing a malformed answer', () => {
  it('tells the common failures apart, without keeping any text', async () => {
    const { describeMalformed } = await import('../src/ai/types');
    const describe = (text: string, finishReason?: string) => {
      try { JSON.parse(text); } catch (e) { return describeMalformed(text, e, finishReason); }
      throw new Error('expected invalid JSON');
    };

    // A quote the model forgot to escape ends the string early; the parser stops on the next word
    const unescaped = describe(`{"verdict":"actionable","reasoning":"cita "${SECRET}" literal"}`);
    expect(unescaped).toMatchObject({ parseError: 'expected_delimiter', errorChar: 'letter', startsWithBrace: true, endsWithBrace: true });
    // An answer cut off in the middle of a string, with the provider saying it ran out of tokens
    expect(describe(`{"verdict":"actionable","reasoning":"${SECRET}`, 'length')).toMatchObject({ parseError: 'unterminated_string', endsWithBrace: false, finishReason: 'length' });
    // Cut off after a value
    expect(describe('{"verdict":"actionable"')).toMatchObject({ parseError: 'expected_delimiter', errorChar: 'end', errorAt: 1 });
    // Text after the object
    expect(describe(`{"verdict":"x","reasoning":"y"} ${SECRET}`)).toMatchObject({ parseError: 'unexpected_token', endsWithBrace: false });
    // A raw line break inside a string
    expect(describe(`{"verdict":"x","reasoning":"una\nlínea"}`)).toMatchObject({ parseError: 'bad_control_character', errorChar: 'newline' });

    for (const d of [unescaped, describe(`{"verdict":"actionable","reasoning":"${SECRET}`)]) {
      expect(JSON.stringify(d)).not.toContain(SECRET);
      expect(d.errorAt === null || (d.errorAt >= 0 && d.errorAt <= 1)).toBe(true);
    }
  });

  it('parseModelJson attaches the description, and the chain keeps it on the attempt', async () => {
    const { parseModelJson, ProviderError } = await import('../src/ai/types');
    let caught: any;
    try { parseModelJson('{"verdict":"x","reasoning":"sin cerrar', schema, { finishReason: 'stop' }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught.kind).toBe('invalid_json');
    expect(caught.malformed).toMatchObject({ parseError: 'unterminated_string', finishReason: 'stop' });

    const { runChain } = await import('../src/ai/chain');
    const broken = { name: 'deepseek', model: 'm', complete: async () => { throw caught; } } as any;
    const good = { name: 'gemini', model: 'g', complete: async () => ({ data: { verdict: 'x', reasoning: 'y' } }) } as any;
    const result = await runChain([broken, good], 's', 'u', schema);
    expect(result.attempts.filter(a => a.provider === 'deepseek').map(a => a.malformed?.parseError)).toEqual(['unterminated_string', 'unterminated_string']);
    expect(result.attempts.at(-1)).toMatchObject({ provider: 'gemini', ok: true });
  });
});

describe('LLM_DEBUG_DIR', () => {
  let server: http.Server;
  let baseUrl: string;
  let replies: any[];
  let dir: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(replies.shift()));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-llm-debug-'));
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  beforeEach(() => { replies = []; });

  const broken = (content: string, finish = 'stop') => ({ choices: [{ message: { content }, finish_reason: finish }], usage: {} });
  const provider = async () => {
    const { DeepSeekProvider } = await import('../src/ai/providers/deepseek');
    return new DeepSeekProvider({ apiKey: 'k', baseUrl, model: 'deepseek-flash' });
  };

  it('saves nothing unless it is set', async () => {
    vi.stubEnv('LLM_DEBUG_DIR', '');
    replies.push(broken(`{"verdict":"${SECRET}`));
    await expect((await provider()).complete('s', 'u', schema)).rejects.toMatchObject({ kind: 'invalid_json' });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('saves the whole failed answer with its description when set', async () => {
    vi.stubEnv('LLM_DEBUG_DIR', dir);
    const raw = `{"verdict":"actionable","reasoning":"cita "${SECRET}" literal"}`;
    replies.push(broken(raw, 'stop'));
    await expect((await provider()).complete('s', 'u', schema)).rejects.toMatchObject({ kind: 'invalid_json', malformed: { parseError: 'expected_delimiter', finishReason: 'stop' } });
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    const saved = JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf-8'));
    expect(saved).toMatchObject({ provider: 'deepseek', kind: 'invalid_json', raw, malformed: { parseError: 'expected_delimiter' } });
    // A valid answer saves nothing
    replies.push(broken('{"verdict":"x","reasoning":"y"}'));
    await (await provider()).complete('s', 'u', schema);
    expect(await fs.readdir(dir)).toHaveLength(1);
  });
});

describe('repairing the early-closed object', () => {
  // The shape DeepSeek wrote in all 6 failures of a diagnostic run (made-up text): the action closes
  // right after its steps, its last two fields land at the top level, and one "}" too many follows
  const broken = JSON.stringify({
    verdict: 'actionable', confidenceScore: 0.85, connection: 'Conecta con el capítulo 3.', gap: null,
    action: { actionType: 'evidence_citation', observation: 'Aporta datos.', suggestedAction: 'Sumar los datos', steps: [{ note: 'a.md', where: null, change: 'Añadir.', text: 'Cita "con comillas".' }] },
    targetFile: 'a.md', targetIsNew: false,
  }) + '}';
  const actionSchema = z.object({
    verdict: z.string(), confidenceScore: z.number(), connection: z.string(), gap: z.string().nullish(),
    action: z.object({
      actionType: z.string(), observation: z.string(), suggestedAction: z.string(),
      steps: z.array(z.object({ note: z.string().nullish(), where: z.string().nullish(), change: z.string(), text: z.string().nullish() })).nullish(),
      targetFile: z.string().nullish(), targetIsNew: z.boolean().nullish(),
    }).nullable(),
  });

  it('drops the extra brace and moves the fields back into the action', async () => {
    const { parseModelJson } = await import('../src/ai/types');
    let repaired: string[] = [];
    const data = parseModelJson(broken, actionSchema, { onRepair: r => { repaired = r; } });
    expect(data.action).toMatchObject({ targetFile: 'a.md', targetIsNew: false, steps: [{ text: 'Cita "con comillas".' }] });
    expect(data).not.toHaveProperty('targetFile');
    expect(repaired).toEqual(['extra_closing_brace', 'moved:action.targetFile', 'moved:action.targetIsNew']);
  });

  it('repairs nothing else', async () => {
    const { parseModelJson } = await import('../src/ai/types');
    const fails = (text: string) => expect(() => parseModelJson(text, actionSchema)).toThrow(expect.objectContaining({ kind: 'invalid_json' }));
    fails(broken + '}');                          // two extra braces
    fails(broken.slice(0, -1) + ' fin');           // trailing text, not a brace
    fails(broken.replace('"targetFile":"a.md"', '"targetFile":"a.md","otro":1').slice(0, 40) + '}'); // cut off
    // A field the schema has nowhere is not moved, and the answer must still pass the schema
    const stray = JSON.stringify({ verdict: 'x', confidenceScore: 'alta', connection: 'c', action: null }) + '}';
    fails(stray);
    // A field the inner object already has is not overwritten
    const both = JSON.stringify({ ...JSON.parse(broken.slice(0, -1)), action: { ...JSON.parse(broken.slice(0, -1)).action, targetFile: 'b.md' } }) + '}';
    expect(parseModelJson(both, actionSchema).action?.targetFile).toBe('b.md');
  });

  it('the chain records the repair on the attempt, and the triage schema accepts it', async () => {
    const { runChain } = await import('../src/ai/chain');
    const { parseModelJson } = await import('../src/ai/types');
    const { triageSchema } = await import('../src/evaluator/triagePrompt');
    const schemaEs = triageSchema({ prompt: 'es', output: 'es' });
    const provider = {
      name: 'deepseek', model: 'm',
      complete: async () => { let repaired: string[] | undefined; const data = parseModelJson(broken, schemaEs, { onRepair: r => { repaired = r; } }); return { data, repaired }; },
    } as any;
    const result = await runChain([provider], 's', 'u', schemaEs);
    expect(result.data.action?.targetFile).toBe('a.md');
    expect(result.attempts).toEqual([expect.objectContaining({ ok: true, repaired: ['extra_closing_brace', 'moved:action.targetFile', 'moved:action.targetIsNew'] })]);
  });
});
