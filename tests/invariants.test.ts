import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

// Invariants I2, I3 and I4 from CLAUDE.md, verified without any live model.

const geminiConstructed = vi.fn();
const geminiGenerate = vi.fn();
const ollamaInvoke = vi.fn();
const ollamaEmbed = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: geminiGenerate };
    constructor(opts: unknown) { geminiConstructed(opts); }
  },
}));

vi.mock('@langchain/ollama', () => ({
  ChatOllama: class {
    model = 'qwen2.5:7b-instruct';
    withStructuredOutput() { return { invoke: ollamaInvoke }; }
  },
  OllamaEmbeddings: class {
    embedQuery = ollamaEmbed;
  },
}));

const schema = z.object({ answer: z.string() });

async function loadProvider(geminiKey: string) {
  vi.resetModules();
  vi.stubEnv('GEMINI_API_KEY', geminiKey);
  const { AiProvider } = await import('../src/ai/aiProvider');
  return new AiProvider();
}

describe('I2: no outbound LLM traffic without a cloud API key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ollamaInvoke.mockResolvedValue({ answer: 'local' });
    geminiGenerate.mockResolvedValue({ text: '{"answer":"cloud"}' });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('uses only Ollama when the key is empty', async () => {
    const provider = await loadProvider('');
    const result = await provider.evaluateContent('sistema', 'texto', schema);

    expect(result.model).toBe('ollama:qwen2.5:7b-instruct');
    expect(geminiConstructed).not.toHaveBeenCalled();
    expect(geminiGenerate).not.toHaveBeenCalled();
  });

  it('sends nothing to DeepSeek or Gemini when no cloud key is set, even if both are listed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.stubEnv('LLM_PROVIDERS', 'deepseek,gemini,ollama');
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const provider = await loadProvider('');
    const result = await provider.evaluateContent('sistema', 'texto', schema);

    expect(result.model).toBe('ollama:qwen2.5:7b-instruct');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(geminiGenerate).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('control: uses Gemini when a key is set', async () => {
    const provider = await loadProvider('test-key');
    const result = await provider.evaluateContent('sistema', 'texto', schema);

    expect(result.model.startsWith('gemini:')).toBe(true);
    expect(geminiGenerate).toHaveBeenCalledTimes(1);
    expect(ollamaInvoke).not.toHaveBeenCalled();
  });
});

describe('I3: embeddings are computed only locally', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ollamaEmbed.mockResolvedValue(new Array(1024).fill(0.1));
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('never calls Gemini for embeddings, even with a key configured', async () => {
    const provider = await loadProvider('test-key');
    const vector = await provider.getEmbedding('texto');

    expect(vector).toHaveLength(1024);
    expect(ollamaEmbed).toHaveBeenCalledWith('texto');
    expect(geminiGenerate).not.toHaveBeenCalled();
  });
});

describe('I4: suggestions.md never affects hashes or triggers reconciliation', () => {
  let vault: string;
  let projectDir: string;

  beforeEach(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-i4-'));
    projectDir = path.join(vault, 'Projects', 'Novela');
    await fs.mkdir(path.join(projectDir, 'capitulos'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'ideas.md'), '# Ideas\nTexto');
  });
  afterEach(async () => {
    await fs.rm(vault, { recursive: true, force: true });
  });

  it('writing suggestions.md leaves the project hash unchanged', async () => {
    const { getDirectoryHash } = await import('../src/vault/hash');
    const before = await getDirectoryHash(projectDir);

    await fs.writeFile(path.join(projectDir, 'suggestions.md'), '> [!tip] Sugerencia Aceptada\n');
    await fs.writeFile(path.join(projectDir, 'capitulos', 'suggestions.md'), '> [!tip] otra\n');
    expect(await getDirectoryHash(projectDir)).toBe(before);

    // Control: a real note edit does change it
    await fs.appendFile(path.join(projectDir, 'ideas.md'), '\nmás texto');
    expect(await getDirectoryHash(projectDir)).not.toBe(before);
  });

  it('the watcher ignores suggestions.md and hidden folders', async () => {
    const { shouldIgnoreVaultPath } = await import('../src/vault/watcher');
    expect(shouldIgnoreVaultPath(vault, path.join(projectDir, 'suggestions.md'))).toBe(true);
    expect(shouldIgnoreVaultPath(vault, path.join(vault, '.obsidian', 'workspace.json'))).toBe(true);
    expect(shouldIgnoreVaultPath(vault, path.join(projectDir, 'ideas.md'))).toBe(false);
  });
});
