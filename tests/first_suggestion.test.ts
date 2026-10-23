import { defineFirstSuggestionSuite } from './helpers/firstSuggestion';

// Spanish demo vault (demo_vault/); the English one is in first_suggestion_en.test.ts
defineFirstSuggestionSuite({
  language: 'es',
  vaultDir: 'demo_vault',
  projectFolders: ['Atencion_y_Redes', 'El_Faro_del_Fin_del_Mundo', 'Juego_de_Mesa_Mareas', 'Podcast_Ciudades_Invisibles'],
  lighthouseFolder: 'El_Faro_del_Fin_del_Mundo',
  lighthouseTitle: 'El faro del fin del mundo',
  nestedNote: 'personajes/el_farero.md',
  matchUrl: 'https://es.wikipedia.org/wiki/Faro',
  // Each paragraph repeated: a real article is longer than MIN_ARTICLE_CHARS
  matchHtml: '<html><head><title>Faro</title></head><body><article><p>Un faro es una torre en la costa con una luz potente para guiar a los barcos durante la noche y la niebla. La lente de Fresnel concentra la luz del faro y el farero mantiene la luz encendida durante los temporales.</p><p>Un faro es una torre en la costa con una luz potente para guiar a los barcos durante la noche y la niebla. La lente de Fresnel concentra la luz del faro y el farero mantiene la luz encendida durante los temporales.</p><p>Un faro es una torre en la costa con una luz potente para guiar a los barcos durante la noche y la niebla. La lente de Fresnel concentra la luz del faro y el farero mantiene la luz encendida durante los temporales.</p></article></body></html>',
  matchWord: 'farero',
  matchSummary: 'Un faro es una torre en la costa con una luz para guiar a los barcos en la noche y la niebla; el farero mantiene la luz encendida durante los temporales.',
  controlUrl: 'https://es.wikipedia.org/wiki/Fotos%C3%ADntesis',
  controlHtml: '<html><head><title>Fotosíntesis</title></head><body><article><p>La clorofila de las hojas absorbe energía solar y transforma dióxido de carbono y agua en glucosa y oxígeno dentro del cloroplasto.</p><p>La clorofila de las hojas absorbe energía solar y transforma dióxido de carbono y agua en glucosa y oxígeno dentro del cloroplasto.</p><p>La clorofila de las hojas absorbe energía solar y transforma dióxido de carbono y agua en glucosa y oxígeno dentro del cloroplasto.</p><p>La clorofila de las hojas absorbe energía solar y transforma dióxido de carbono y agua en glucosa y oxígeno dentro del cloroplasto.</p><p>La clorofila de las hojas absorbe energía solar y transforma dióxido de carbono y agua en glucosa y oxígeno dentro del cloroplasto.</p></article></body></html>',
  controlSummary: 'La fotosíntesis convierte la energía solar en glucosa y oxígeno gracias a la clorofila de las hojas.',
  targetNote: 'investigacion_faros.md',
  action: {
    reasoning: 'Aporta detalles reales sobre el oficio del farero.',
    observation: 'El artículo describe la luz y el trabajo del farero.',
    suggestedAction: 'Citar la descripción de la luz del faro en las notas de investigación.',
  },
  calloutTitle: 'Sugerencia Aceptada',
  answerLine: 'Debes responder SIEMPRE en ESPAÑOL.',
  summaryLanguageLine: 'Escribe el resumen siempre en Español',
});
