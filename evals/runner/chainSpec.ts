import { z } from 'zod';
import { buildProviderChain } from '../../src/ai/chain';
import { ChatProvider, Completion, CompletionOptions } from '../../src/ai/types';
import { ProviderSpec } from '../schema';

/**
 * Applies what the config declares for a provider: fixed options (for example DeepSeek thinking)
 * and pacing, so calls stay under the provider's requests-per-minute limit.
 */
export class ConfiguredProvider implements ChatProvider {
  private lastStart = 0;

  constructor(private inner: ChatProvider, private fixed: CompletionOptions, private minIntervalMs = 0) {}
  get name() { return this.inner.name; }
  get model() { return this.inner.model; }

  async complete<S extends z.ZodTypeAny>(system: string, user: string, schema: S, options?: CompletionOptions): Promise<Completion<z.infer<S>>> {
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    this.lastStart = Date.now();
    return this.inner.complete(system, user, schema, { ...options, ...this.fixed });
  }
}

const KEYS: Record<ProviderSpec['name'], string | null> = { deepseek: 'DEEPSEEK_API_KEY', gemini: 'GEMINI_API_KEY', ollama: null };

/** Builds the providers a config names, in order. Unlike production, a missing key is an error. */
export function buildChainFromSpecs(specs: ProviderSpec[], env: NodeJS.ProcessEnv): ChatProvider[] {
  return specs.map(spec => {
    const keyName = KEYS[spec.name];
    if (keyName && !env[keyName]) throw new Error(`La configuración usa ${spec.name} pero falta ${keyName} en .env`);

    const overrides: Record<string, string | undefined> = { LLM_PROVIDERS: spec.name };
    if (spec.model) {
      const modelKey = { deepseek: 'DEEPSEEK_MODEL', gemini: 'GEMINI_MODEL', ollama: 'OLLAMA_CHAT_MODEL' }[spec.name];
      overrides[modelKey] = spec.model;
    }
    const [provider] = buildProviderChain({ ...env, ...overrides });
    if (spec.thinking === undefined && !spec.minIntervalMs) return provider;
    return new ConfiguredProvider(provider, spec.thinking === undefined ? {} : { thinking: spec.thinking }, spec.minIntervalMs);
  });
}
