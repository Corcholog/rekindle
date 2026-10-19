import { createContext, ReactNode, useCallback, useContext, useMemo, useState, Fragment } from 'react';
import { DICT } from './dict';

export const LANGUAGES = ['es', 'en'] as const;
export type Language = typeof LANGUAGES[number];
type Params = Record<string, string | number>;

const STORAGE_KEY = 'rekindle.uiLanguage';
// Before the rename the choice was stored under this key; it is still honored once
const LEGACY_STORAGE_KEY = 'loom.uiLanguage';

const isLanguage = (value: unknown): value is Language => typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);

export function storedLanguage(): Language | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
    return isLanguage(value) ? value : null;
  } catch {
    return null;
  }
}

export function translate(lang: Language, key: string, params?: Params): string {
  const value = (DICT[lang] as Record<string, unknown>)[key] ?? (DICT.es as Record<string, unknown>)[key];
  if (value === undefined) return key;
  if (typeof value === 'function') return value(params ?? {});
  const text = String(value);
  return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text;
}

export interface I18n {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: string, params?: Params) => string;
  /** Like t(), with React nodes (code, strong) in the placeholders: never markup from strings. */
  tRich: (key: string, nodes: Record<string, ReactNode>) => ReactNode;
  /** Text for an API error: its code when known, else the fallback key. */
  apiError: (data: unknown, fallbackKey: string) => string;
  locale: string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ initial, children }: { initial: Language; children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(initial);
  const setLang = useCallback((next: Language) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode: the choice lasts for this page only
    }
  }, []);

  const value = useMemo<I18n>(() => {
    const t = (key: string, params?: Params) => translate(lang, key, params);
    return {
      lang,
      setLang,
      t,
      tRich: (key, nodes) => {
        const parts = translate(lang, key).split(/(\{\w+\})/);
        return parts.map((part, i) => {
          const name = part.match(/^\{(\w+)\}$/)?.[1];
          return <Fragment key={i}>{name && name in nodes ? nodes[name] : part}</Fragment>;
        });
      },
      apiError: (data, fallbackKey) => {
        const code = (data as { code?: unknown } | null)?.code;
        return typeof code === 'string' && `error.${code}` in DICT[lang] ? t(`error.${code}`) : t(fallbackKey);
      },
      locale: lang === 'en' ? 'en-US' : 'es-ES',
    };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}

export { DICT };
