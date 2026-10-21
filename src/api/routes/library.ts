import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db';
import { contents } from '../../db/schema';
import { sql } from 'drizzle-orm';
import { env, CONSULT_TOP_CONTENTS, CONSULT_TOP_NOTES, CONSULT_SUMMARY_CHARS, CONSULT_NOTE_CHARS, CONSULT_LABEL_CHARS, MAX_CONSULT_QUERY_CHARS } from '../../config';
import { sharedAiProvider } from '../../ai/aiProvider';
import { promptBlock } from '../../ai/promptSafety';
import { Language, languageName, outputLanguage } from '../../ai/language';
import { serverText } from '../../i18n/serverText';

const ollama = sharedAiProvider;

const LibraryAskBodySchema = z.object({
  query: z.string().min(2, 'La pregunta debe tener al menos 2 caracteres').max(MAX_CONSULT_QUERY_CHARS),
});

// Built per call: the explanations are written in the current output language
const consultAnswerSchema = (lang: Language) => z.object({
  diagnosis: z.string().describe(`Diagnóstico y respuesta razonada en ${languageName(lang).lower} a la consulta del usuario, integrando y citando explícitamente los contenidos de la biblioteca como [C1], [C2] y las notas de Obsidian como [N1], [N2]. Si no hay coincidencias directas, explícalo con honestidad y menciona si hay conexiones tangenciales.`),
  projectViability: z.string().nullish().describe('Si el usuario pregunta por la viabilidad de un proyecto, ensayo o idea (o si hay una oportunidad clara de conectar sus fuentes), propón un enfoque, tesis o ángulo concreto combinando sus lecturas y notas. Si no aplica, devuelve null.'),
  matchedContents: z.array(z.object({
    refId: z.string().describe('Identificador de referencia del contenido en el catálogo, ej: "C1", "C2"'),
    whyItConnects: z.string().describe(`Explicación concreta y específica (1 a 3 oraciones en ${languageName(lang).lower}) de por qué este video o artículo responde o aporta a lo que busca el usuario`),
  })).describe('Lista de contenidos de la biblioteca que realmente conectan con la consulta (vacía si ninguno conecta)'),
  matchedNotes: z.array(z.object({
    refId: z.string().describe('Identificador de referencia de la nota de proyecto en el catálogo, ej: "N1", "N2"'),
    whyItConnects: z.string().describe(`Explicación concreta y específica (1 a 3 oraciones en ${languageName(lang).lower}) de cómo esta nota de Obsidian conecta con la consulta o con los contenidos de la biblioteca`),
  })).describe('Lista de notas de proyectos de Obsidian que realmente conectan con la consulta (vacía si ninguna conecta)'),
});

export default async function (server: FastifyInstance) {
  // 0. Archive & Vault Research Partner: the library items and notes closest to the question
  server.post('/api/library/consult', {
    schema: {
      body: LibraryAskBodySchema,
      response: {
        200: z.object({
          query: z.string(),
          diagnosis: z.string(),
          projectViability: z.string().nullable(),
          totalLibraryEvaluated: z.number(),
          totalNotesEvaluated: z.number(),
          totalLibrary: z.number(),
          totalNotes: z.number(),
          matchedContents: z.array(z.object({
            refId: z.string(),
            id: z.string().uuid(),
            title: z.string().nullable(),
            uri: z.string(),
            channelOrDomain: z.string().nullable(),
            summary: z.string().nullable(),
            consumedAt: z.date(),
            whyItConnects: z.string(),
          })),
          matchedNotes: z.array(z.object({
            refId: z.string(),
            id: z.string(),
            projectId: z.string().uuid(),
            projectTitle: z.string(),
            noteTitle: z.string(),
            notePath: z.string(),
            contentSnippet: z.string().nullable(),
            whyItConnects: z.string(),
          })),
        }),
        400: z.object({
          error: z.string(),
          message: z.string().optional(),
          code: z.string().optional(),
        }),
        500: z.object({
          error: z.string(),
          message: z.string().optional(),
          code: z.string().optional(),
        }),
      },
    },
  }, async (request, reply) => {
    const { query } = request.body as { query: string };

    // The question is embedded locally (I3) and compared only with embeddings of the same model (I7)
    let queryEmbedding: number[];
    try {
      queryEmbedding = await ollama.getEmbedding(query);
    } catch (err) {
      server.log.error({ err }, 'Embedding the Consultor question failed');
      return reply.status(500).send({
        error: 'Failed to consult library and vault',
        message: 'The local embedding model failed to read the question.',
        code: 'embedding_failed',
      });
    }
    const targetVector = `[${queryEmbedding.join(',')}]`;
    const embedModel = env.EMBED_MODEL;

    // 1. The ready contents closest to the question
    const readyContentsRes = await db.execute(sql`
      SELECT
        c.id,
        c.uri,
        c.title,
        c.channel_or_domain,
        c.summary,
        SUBSTRING(c.raw_text FROM 1 FOR 800) AS raw_preview,
        c.consumed_at
      FROM ${contents} c
      WHERE c.ingest_status = 'ready'
        AND c.embedding IS NOT NULL
        AND c.embedding_model = ${embedModel}
      ORDER BY c.embedding <=> ${targetVector}::vector ASC
      LIMIT ${CONSULT_TOP_CONTENTS}
    `);

    const libraryCatalog = readyContentsRes.rows.map((row: any, idx: number) => ({
      refId: `C${idx + 1}`,
      id: row.id as string,
      uri: row.uri as string,
      title: (row.title as string) || null,
      channelOrDomain: (row.channel_or_domain as string) || null,
      summary: (row.summary as string) || null,
      rawPreview: (row.raw_preview as string) || '',
      consumedAt: new Date(row.consumed_at),
    }));

    // 2. The notes of active projects (latest snapshot) closest to the question. A snapshot without
    // note rows (older data) is one entry, its project text ranked by the project embedding.
    const latestNotesRes = await db.execute(sql`
      WITH latest_snaps AS (
        SELECT DISTINCT ON (ps.project_id)
          ps.id AS snapshot_id,
          ps.project_id,
          p.title AS project_title,
          COALESCE(ps.notes_content, ps.thesis_text) AS project_text,
          ps.embedding,
          ps.embedding_model
        FROM project_snapshots ps
        INNER JOIN projects p ON p.id = ps.project_id
        WHERE p.is_active = true
        ORDER BY ps.project_id, ps.captured_at DESC
      ),
      ranked AS (
        SELECT
          pns.id AS note_id, ls.project_id, ls.project_title, pns.note_title, pns.note_path,
          pns.content_snippet, (pns.embedding <=> ${targetVector}::vector) AS distance
        FROM latest_snaps ls
        INNER JOIN project_note_snapshots pns ON pns.project_snapshot_id = ls.snapshot_id
        WHERE pns.embedding IS NOT NULL AND pns.embedding_model = ${embedModel}
        UNION ALL
        SELECT
          ls.snapshot_id, ls.project_id, ls.project_title, NULL, NULL,
          ls.project_text, (ls.embedding <=> ${targetVector}::vector)
        FROM latest_snaps ls
        WHERE NOT EXISTS (SELECT 1 FROM project_note_snapshots x WHERE x.project_snapshot_id = ls.snapshot_id)
          AND ls.project_text IS NOT NULL
          AND ls.embedding IS NOT NULL AND ls.embedding_model = ${embedModel}
      )
      SELECT * FROM ranked
      ORDER BY distance ASC
      LIMIT ${CONSULT_TOP_NOTES}
    `);

    const notesCatalog = (latestNotesRes.rows as any[]).map((row, idx) => {
      const isNote = row.note_path !== null;
      return {
        refId: `N${idx + 1}`,
        id: row.note_id as string,
        projectId: row.project_id as string,
        projectTitle: row.project_title as string,
        noteTitle: isNote ? ((row.note_title as string) || serverText().untitledNote) : `${row.project_title} (Resumen de Proyecto)`,
        notePath: isNote ? (row.note_path as string) : `${row.project_title}.md`,
        contentSnippet: (row.content_snippet as string) || null,
      };
    });

    // What the selection was taken from, so the model and the owner know it is a selection
    const totalsRes = await db.execute(sql`
      WITH latest_snaps AS (
        SELECT DISTINCT ON (ps.project_id) ps.id, ps.notes_content, ps.thesis_text
        FROM project_snapshots ps
        INNER JOIN projects p ON p.id = ps.project_id
        WHERE p.is_active = true
        ORDER BY ps.project_id, ps.captured_at DESC
      )
      SELECT
        (SELECT COUNT(*) FROM ${contents} WHERE ingest_status = 'ready') AS library,
        (SELECT COUNT(*) FROM project_note_snapshots pns INNER JOIN latest_snaps ls ON pns.project_snapshot_id = ls.id)
          + (SELECT COUNT(*) FROM latest_snaps ls
             WHERE COALESCE(ls.notes_content, ls.thesis_text) IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM project_note_snapshots x WHERE x.project_snapshot_id = ls.id)) AS notes
    `);
    const totalLibrary = Number((totalsRes.rows[0] as any).library);
    const totalNotes = Number((totalsRes.rows[0] as any).notes);

    if (libraryCatalog.length === 0 && notesCatalog.length === 0) {
      return {
        query,
        diagnosis: serverText().emptyLibrary,
        projectViability: null,
        totalLibraryEvaluated: 0,
        totalNotesEvaluated: 0,
        totalLibrary,
        totalNotes,
        matchedContents: [],
        matchedNotes: [],
      };
    }

    const libraryPromptBlock = libraryCatalog.length > 0
      ? libraryCatalog.map(item => {
          const bodyText = item.summary
            ? `Resumen: ${item.summary.substring(0, CONSULT_SUMMARY_CHARS)}`
            : `Extracto: ${item.rawPreview}`;
          const title = (item.title || 'Sin título').substring(0, CONSULT_LABEL_CHARS);
          const source = (item.channelOrDomain || item.uri).substring(0, CONSULT_LABEL_CHARS);
          return `[${item.refId}] Título: "${title}" | Fuente: ${source}\n${bodyText}`;
        }).join('\n\n---\n\n')
      : 'No hay contenidos guardados en la biblioteca.';

    const notesPromptBlock = notesCatalog.length > 0
      ? notesCatalog.map(note => {
          const snippet = (note.contentSnippet || '').substring(0, CONSULT_NOTE_CHARS);
          const project = note.projectTitle.substring(0, CONSULT_LABEL_CHARS);
          const file = (note.notePath || note.noteTitle).substring(0, CONSULT_LABEL_CHARS);
          return `[${note.refId}] Proyecto: "${project}" | Archivo de Nota: "${file}"\nContenido de la nota:\n${snippet}`;
        }).join('\n\n---\n\n')
      : 'No hay notas de proyectos activas en el Vault de Obsidian.';

    const lang = outputLanguage();
    const systemPrompt = `Eres el Consultor de Investigación de Rekindle, un compañero intelectual que conoce a fondo tanto la Biblioteca de contenidos guardados por el usuario (videos, artículos, ensayos) como las Notas de sus Proyectos activos en su Vault de Obsidian.

Tu objetivo es responder con precisión, criterio analítico y honestidad a preguntas como:
- "¿Tenemos contenido relacionado a X, Y, Z?"
- "¿Puedo hacer un proyecto o ensayo sobre X?"
- "¿Qué argumentos, referencias o notas conectan con esta idea?"

REGLAS ESTRICTAS:
1. Evalúa TANTO el <CATALOGO_BIBLIOTECA> (referencias [C1], [C2]...) COMO las <NOTAS_PROYECTOS_OBSIDIAN> (referencias [N1], [N2]...).
2. No dependas solo de coincidencias literales de palabras: reconoce relaciones conceptuales, de categoría o de obra/autor (por ejemplo, si preguntan por "videojuegos", un ensayo sobre "Shadow of the Colossus" o una nota que menciona juegos indie ES directamente relevante).
3. En "diagnosis", responde en ${languageName(lang).upper} de forma clara, conversacional y estructurada. Cita explícitamente en el texto las referencias relevantes usando sus etiquetas exactas entre corchetes, por ejemplo [C1], [N1].
4. Si el usuario pregunta si puede armar un proyecto sobre un tema (o si detectas un puente fértil entre lo que tiene en la biblioteca y sus notas de Obsidian), completa "projectViability" con una propuesta concreta de enfoque, ángulo o estructura. Si es solo una consulta de inventario simple y no aplica o no hay material, puedes dejar "projectViability" en null o sugerir brevemente qué ángulo podría explorar con lo encontrado.
5. Incluye en "matchedContents" ÚNICAMENTE los contenidos [C#] que realmente aportan a la consulta (no rellenes con ítems irrelevantes), explicando en "whyItConnects" exactamente por qué ese video o artículo conecta con lo que preguntó el usuario.
6. Incluye en "matchedNotes" ÚNICAMENTE las notas de Obsidian [N#] que realmente conectan con la consulta (incluso si mencionan el tema como referencia, ejemplo o estructura), explicando en "whyItConnects" qué contiene esa nota y cómo aporta.
7. Solo ves una selección: los contenidos y las notas más cercanos a la consulta, según <SELECCION>. Si el usuario pide un inventario completo o un recuento, aclara que respondes sobre esa selección.`;

    const selection = `Recibes los ${libraryCatalog.length} contenidos más cercanos a la consulta, de ${totalLibrary} en la biblioteca, y las ${notesCatalog.length} notas más cercanas, de ${totalNotes} en los proyectos activos.`;
    const userMessage = `${promptBlock('SELECCION', selection)}

${promptBlock('CATALOGO_BIBLIOTECA', libraryPromptBlock)}

${promptBlock('NOTAS_PROYECTOS_OBSIDIAN', notesPromptBlock)}

${promptBlock('CONSULTA_DEL_USUARIO', query)}`;

    try {
      const { data: result } = await ollama.evaluateContent(systemPrompt, userMessage, consultAnswerSchema(lang), undefined, { component: 'consult' });

      const contentMap = new Map(libraryCatalog.map(c => [c.refId.toUpperCase(), c]));
      const noteMap = new Map(notesCatalog.map(n => [n.refId.toUpperCase(), n]));

      const normalizeRef = (rawRef: string) => rawRef.replace(/[[\]\s]/g, '').toUpperCase();

      const seenContents = new Set<string>();
      const matchedContents = [];
      for (const mc of result.matchedContents || []) {
        const key = normalizeRef(mc.refId);
        const item = contentMap.get(key);
        if (item && !seenContents.has(item.id)) {
          seenContents.add(item.id);
          matchedContents.push({
            refId: item.refId,
            id: item.id,
            title: item.title,
            uri: item.uri,
            channelOrDomain: item.channelOrDomain,
            summary: item.summary,
            consumedAt: item.consumedAt,
            whyItConnects: mc.whyItConnects,
          });
        }
      }

      const seenNotes = new Set<string>();
      const matchedNotes = [];
      for (const mn of result.matchedNotes || []) {
        const key = normalizeRef(mn.refId);
        const note = noteMap.get(key);
        if (note && !seenNotes.has(note.id)) {
          seenNotes.add(note.id);
          matchedNotes.push({
            refId: note.refId,
            id: note.id,
            projectId: note.projectId,
            projectTitle: note.projectTitle,
            noteTitle: note.noteTitle,
            notePath: note.notePath,
            // Notes are stored in full; the UI previews the start only
            contentSnippet: note.contentSnippet?.substring(0, 4000) ?? null,
            whyItConnects: mn.whyItConnects,
          });
        }
      }

      return {
        query,
        diagnosis: result.diagnosis,
        projectViability: result.projectViability || null,
        totalLibraryEvaluated: libraryCatalog.length,
        totalNotesEvaluated: notesCatalog.length,
        totalLibrary,
        totalNotes,
        matchedContents,
        matchedNotes,
      };
    } catch (err: any) {
      server.log.error({ err }, 'Error during Consult Library & Vault LLM evaluation');
      return reply.status(500).send({
        error: 'Failed to consult library and vault',
        message: 'The language model failed to analyze the library and notes.',
        code: 'llm_failed',
      });
    }
  });
}
