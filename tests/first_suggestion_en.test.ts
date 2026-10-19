import { defineFirstSuggestionSuite } from './helpers/firstSuggestion';

// English demo vault (demo_vault_en/) with LANGUAGE=en: English summaries, suggestions and callouts
defineFirstSuggestionSuite({
  language: 'en',
  vaultDir: 'demo_vault_en',
  projectFolders: ['Attention_and_Social_Media', 'Invisible_Cities_Podcast', 'The_Lighthouse_at_the_End_of_the_World', 'Tides_Board_Game'],
  lighthouseFolder: 'The_Lighthouse_at_the_End_of_the_World',
  lighthouseTitle: 'The Lighthouse at the End of the World',
  nestedNote: 'characters/the_keeper.md',
  matchUrl: 'https://en.wikipedia.org/wiki/Lighthouse',
  matchHtml: '<html><head><title>Lighthouse</title></head><body><article><p>A lighthouse is a tower on the coast with a powerful light that guides ships through the night and the fog. The Fresnel lens concentrates the beam, and the keeper keeps the light burning through the storms.</p></article></body></html>',
  matchWord: 'keeper',
  matchSummary: 'A lighthouse is a tower on the coast whose light guides ships at night and in fog; the keeper keeps the light burning through the storms.',
  controlUrl: 'https://en.wikipedia.org/wiki/Photosynthesis',
  controlHtml: '<html><head><title>Photosynthesis</title></head><body><article><p>Chlorophyll in leaves absorbs solar energy and turns carbon dioxide and water into glucose and oxygen inside the chloroplast.</p></article></body></html>',
  controlSummary: 'Photosynthesis turns solar energy into glucose and oxygen thanks to the chlorophyll in leaves.',
  targetNote: 'lighthouse_research.md',
  action: {
    reasoning: 'It adds real details about the keeper\'s craft.',
    observation: 'The article describes the beam and the keeper\'s work.',
    suggestedAction: 'Quote the description of the lighthouse beam in the research notes.',
  },
  calloutTitle: 'Accepted Suggestion',
  answerLine: 'Debes responder SIEMPRE en INGLÉS.',
  summaryLanguageLine: 'Escribe el resumen siempre en Inglés',
});
