// Languages Rekindle reads and writes. Three choices, read at call time so a settings change applies
// without a restart:
// - output language: text the user reads (reasoning, actions, answers, callouts, saved notes);
// - notes language: the language of the owner's notes. Summaries are written in it, because the
//   summary is what gets embedded and compared with the notes;
// - prompt language: the language of the instructions. Internal, chosen by measurement (evals/).
// LANGUAGE is a preset for all three. With everything Spanish the prompts are byte-identical to
// the ones measured before languages were configurable, so the recorded eval baseline still holds.

export const LANGUAGES = ['es', 'en'] as const;
export type Language = typeof LANGUAGES[number];

type Env = Record<string, string | undefined>;

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

function pick(value: string | undefined, fallback: Language): Language {
  return isLanguage(value) ? value : fallback;
}

export function presetLanguage(env: Env = process.env): Language {
  return pick(env.LANGUAGE, 'es');
}

export function outputLanguage(env: Env = process.env): Language {
  return pick(env.OUTPUT_LANGUAGE, presetLanguage(env));
}

export function notesLanguage(env: Env = process.env): Language {
  return pick(env.NOTES_LANGUAGE, presetLanguage(env));
}

/** Instruction language. Not a user setting: PROMPT_LANGUAGE exists for the eval harness. */
export function promptLanguage(env: Env = process.env): Language {
  return pick(env.PROMPT_LANGUAGE, 'es');
}

/** A language's name as written inside a prompt of the given instruction language. */
const NAMES: Record<Language, Record<Language, { upper: string; title: string; lower: string }>> = {
  es: {
    es: { upper: 'ESPAÑOL', title: 'Español', lower: 'español' },
    en: { upper: 'INGLÉS', title: 'Inglés', lower: 'inglés' },
  },
  en: {
    es: { upper: 'SPANISH', title: 'Spanish', lower: 'Spanish' },
    en: { upper: 'ENGLISH', title: 'English', lower: 'English' },
  },
};

export function languageName(target: Language, prompt: Language = 'es') {
  return NAMES[prompt][target];
}

/** The "answer in X" line used in the Spanish prompts ("Debes responder SIEMPRE en ESPAÑOL."). */
export function answerInLine(output: Language, prompt: Language = 'es'): string {
  return prompt === 'es'
    ? `Debes responder SIEMPRE en ${languageName(output).upper}.`
    : `You MUST ALWAYS answer in ${languageName(output, 'en').upper}.`;
}
