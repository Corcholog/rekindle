import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Audit F-10: changing the vault path must not inject variables into .env or corrupt it.
describe('.env writer', () => {
  it('replaces the line literally, even with $ patterns in the value', async () => {
    const { upsertEnvLine } = await import('../src/vault/config');
    const content = 'GEMINI_API_KEY=abc\nVAULT_PATH=/old\nPORT=3000\n';
    const updated = upsertEnvLine(content, 'VAULT_PATH', "/vaults/$&/$'/x");
    expect(updated).toBe("GEMINI_API_KEY=abc\nVAULT_PATH=/vaults/$&/$'/x\nPORT=3000\n");
  });

  it('appends the key when it is missing', async () => {
    const { upsertEnvLine } = await import('../src/vault/config');
    expect(upsertEnvLine('PORT=3000', 'VAULT_PATH', '/v')).toBe('PORT=3000\nVAULT_PATH=/v\n');
    expect(upsertEnvLine('', 'VAULT_PATH', '/v')).toBe('VAULT_PATH=/v\n');
  });

  it('rejects values that would inject extra variables', async () => {
    const { upsertEnvLine } = await import('../src/vault/config');
    expect(() => upsertEnvLine('', 'VAULT_PATH', '/v\nGEMINI_API_KEY=attacker')).toThrow();
    expect(() => upsertEnvLine('', 'VAULT_PATH', '/v\r\nX=1')).toThrow();
  });

  it('writes atomically and leaves the file readable by the owner only', async () => {
    const { writeEnvValue } = await import('../src/vault/config');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-env-'));
    const envPath = path.join(dir, '.env');
    await fs.writeFile(envPath, 'PORT=3000\n', { mode: 0o755 });

    await writeEnvValue(envPath, 'VAULT_PATH', '/vault');

    expect(await fs.readFile(envPath, 'utf-8')).toBe('PORT=3000\nVAULT_PATH=/vault\n');
    expect((await fs.stat(envPath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(dir)).filter(f => f.endsWith('.tmp'))).toHaveLength(0);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('POST /api/settings/vault input validation', () => {
  let server: any;

  beforeAll(async () => {
    server = (await import('../src/api/server')).server;
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('rejects a vault path containing a newline', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/settings/vault',
      payload: { vaultPath: '/tmp\nGEMINI_API_KEY=attacker' },
    });
    expect(res.statusCode).toBe(400);
  });
});
