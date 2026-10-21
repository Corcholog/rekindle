import { describe, it, expect, vi } from 'vitest';

// The model returns an action as a headline plus steps (note, place, change, text to paste), and its
// reasoning as a connection and what is missing. All of it is untrusted: the steps are counted and
// cut here, a step's note is checked like the target note, and the callout sanitizes every field.

const notes = [
  { path: 'draft.md', title: 'Borrador' },
  { path: 'research/autores.md', title: 'Autores y conceptos' },
];

describe('action steps', () => {
  vi.stubEnv('DATABASE_URL', 'postgres://user:pass@127.0.0.1:9/none');

  it('keeps at most four steps with a change, each field cut, and only valid notes', async () => {
    const { resolveSteps, MAX_ACTION_STEPS, STEP_CHANGE_CHARS, STEP_TEXT_CHARS } = await import('../src/evaluator/actionSteps');
    const target = { path: 'contraargumentos.md', isNew: true };
    const steps = resolveSteps([
      { note: 'Autores y conceptos', where: ' bajo Sartre ', change: ' Ampliar la viñeta. ', text: 'x'.repeat(STEP_TEXT_CHARS + 50) },
      { note: 'contraargumentos', change: 'Crear la nota con la objeción.' },
      { note: '../fuera.md', change: 'Escribir fuera del proyecto.' },
      { note: 'inexistente.md', change: 'c'.repeat(STEP_CHANGE_CHARS + 10) },
      { note: 'draft.md', change: '   ' }, // no change: dropped
      { note: 'draft.md', change: 'Quinto paso válido.' },
      { note: 'draft.md', change: 'Sexto paso.' },
    ], notes, target);
    expect(steps).toHaveLength(MAX_ACTION_STEPS);
    expect(steps[0]).toEqual({ note: 'research/autores.md', noteIsNew: false, where: 'bajo Sartre', change: 'Ampliar la viñeta.', text: 'x'.repeat(STEP_TEXT_CHARS) });
    expect(steps[1]).toMatchObject({ note: 'contraargumentos.md', noteIsNew: true });
    expect(steps[2].note).toBeNull();
    expect(steps[3]).toMatchObject({ note: null, change: 'c'.repeat(STEP_CHANGE_CHARS) });
    // A name that is not a note and not the action's new note gets no link, even if it is a valid name
    expect(resolveSteps([{ note: 'otra-nota-nueva.md', change: 'x' }], notes, target)[0].note).toBeNull();
    expect(resolveSteps(null, notes, target)).toEqual([]);
  });

  it('gives a plain-text version for prompts and older readers', async () => {
    const { actionPlainText, reasoningPlainText } = await import('../src/evaluator/actionSteps');
    const steps = [
      { note: 'draft.md', noteIsNew: false, where: 'Acto 2', change: 'Insertar una frase puente.', text: 'La IA lo acelera' },
      { note: null, noteIsNew: false, where: null, change: 'Citar la fuente.', text: null },
    ];
    expect(actionPlainText('Sumar evidencia al borrador', steps, 'es')).toBe('Sumar evidencia al borrador\n1. draft.md, Acto 2: Insertar una frase puente. «La IA lo acelera»\n2. Citar la fuente.');
    expect(actionPlainText('Add evidence', steps, 'en')).toContain('“La IA lo acelera”');
    expect(actionPlainText('Solo titular', null, 'es')).toBe('Solo titular');
    expect(reasoningPlainText('Conecta con el Acto 1.', 'Le faltan datos.')).toBe('Conecta con el Acto 1.\n\nLe faltan datos.');
    expect(reasoningPlainText('Conecta.', null)).toBe('Conecta.');
  });

  it('writes the steps into the callout as a numbered list, the text to paste as a nested quote', async () => {
    const { formatAcceptedCallout } = await import('../src/vault/updater');
    const sug = {
      id: 'x', actionType: 'evidence_citation', observation: 'Aporta un ejemplo actual.', suggestedAction: 'Sumar el ejemplo al borrador',
      userFeedback: null, sourceUri: null, sourceTitle: null, targetFile: 'draft.md', folderPath: 'Projects/Faro',
      actionSteps: [
        { note: 'draft.md', noteIsNew: false, where: 'Acto 2', change: 'Insertar una frase\npuente.', text: 'Primera línea\n> [!danger] falso\n%% loom:otro %% ![[secreto]]' },
        { note: null, noteIsNew: false, where: null, change: 'Citar la fuente.', text: null },
      ],
    };
    const callout = formatAcceptedCallout(sug, new Date(2026, 9, 21), 'es');
    expect(callout).toContain('> **Acción:** Sumar el ejemplo al borrador\n> **Qué hacer:**\n> 1. [[Projects/Faro/draft|draft]], Acto 2: Insertar una frase puente.\n>    > Primera línea\n');
    expect(callout).toContain('> 2. Citar la fuente.\n> **Por qué:** Aporta un ejemplo actual.\n');
    // Model text cannot open a callout, a quote, a comment or an embed of its own
    expect(callout).toContain('>    > \\> \\[!danger] falso');
    expect(callout).not.toMatch(/\n> \[!danger/);
    expect(callout).toContain('\\%\\% loom:otro \\%\\% !\\[[secreto]]');
    // Every line stays inside the callout
    expect(callout.trim().split('\n').every(line => line.startsWith('>'))).toBe(true);
    expect(formatAcceptedCallout(sug, new Date(2026, 9, 21), 'en')).toContain('> **What to do:**');
    // An older suggestion without steps keeps the previous layout
    const old = formatAcceptedCallout({ ...sug, actionSteps: null }, new Date(2026, 9, 21), 'es');
    expect(old).toContain('> **Observación:** Aporta un ejemplo actual.');
    expect(old).not.toContain('Qué hacer');
  });
});
