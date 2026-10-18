import { z } from 'zod';
import { buildProviderChain } from '../../src/ai/chain';
import { ChatProvider, Completion, CompletionOptions } from '../../src/ai/types';
import { ProviderSpec } from '../schema';

/** Fixes the options of a provider (for example DeepSeek thinking) as declared in the config. */
class ConfiguredProvider implements ChatProvider {
  constructor(private inner: ChatProvider, private fixed: CompletionOptions) {}
  get name() { return this.inner.name; }
  get model() { return this.inner.model; }
  complete<S extends z.ZodTypeAny>(system: string, user: string, schema: S, options?: CompletionOptions): Promise<Completion<z.infer<S>>> {
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
    return spec.thinking === undefined ? provider : new ConfiguredProvider(provider, { thinking: spec.thinking });
  });
}
