import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db';
import { contents } from '../../db/schema';
import { sql } from 'drizzle-orm';
import { sharedAiProvider } from '../../ai/aiProvider';
import { promptBlock } from '../../ai/promptSafety';

const ollama = sharedAiProvider;

const LibraryAskBodySchema = z.object({
  query: z.string().min(2, 'La pregunta debe tener al menos 2 caracteres'),
});

const consultAnswerSchema = z.object({
  diagnosis: z.string().describe('Diagnóstico y respuesta razonada en español a la consulta del usuario, integrando y citando explícitamente los contenidos de la biblioteca como [C1], [C2] y las notas de Obsidian como [N1], [N2]. Si no hay coincidencias directas, explícalo con honestidad y menciona si hay conexiones tangenciales.'),
  projectViability: z.string().nullish().describe('Si el usuario pregunta por la viabilidad de un proyecto, ensayo o idea (o si hay una oportunidad clara de conectar sus fuentes), propón un enfoque, tesis o ángulo concreto combinando sus lecturas y notas. Si no aplica, devuelve null.'),
  matchedContents: z.array(z.object({
    refId: z.string().describe('Identificador de referencia del contenido en el catálogo, ej: "C1", "C2"'),
    whyItConnects: z.string().describe('Explicación concreta y específica (1 a 3 oraciones en español) de por qué este video o artículo responde o aporta a lo que busca el usuario'),
  })).describe('Lista de contenidos de la biblioteca que realmente conectan con la consulta (vacía si ninguno conecta)'),
  matchedNotes: z.array(z.object({
    refId: z.string().describe('Identificador de referencia de la nota de proyecto en el catálogo, ej: "N1", "N2"'),
    whyItConnects: z.string().describe('Explicación concreta y específica (1 a 3 oraciones en español) de cómo esta nota de Obsidian conecta con la consulta o con los contenidos de la biblioteca'),
  })).describe('Lista de notas de proyectos de Obsidian que realmente conectan con la consulta (vacía si ninguna conecta)'),
});

export default async function (server: FastifyInstance) {
  // 0. Archive & Vault Research Partner (Full-Catalog Cross-Source Consultant)
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
        }),
        500: z.object({
          error: z.string(),
          message: z.string().optional(),
        }),
      },
    },
  }, async (request, reply) => {
    const { query } = request.body as { query: string };

    // 1. Fetch all ready contents from the library
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
      ORDER BY c.consumed_at DESC
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

    // 2. Fetch all active projects and their latest snapshot + note snapshots
    const latestNotesRes = await db.execute(sql`
      WITH latest_snaps AS (
        SELECT DISTINCT ON (ps.project_id)
          ps.id AS snapshot_id,
          ps.project_id,
          p.title AS project_title,
          ps.thesis_text,
          ps.notes_content
        FROM project_snapshots ps
        INNER JOIN projects p ON p.id = ps.project_id
        WHERE p.is_active = true
        ORDER BY ps.project_id, ps.captured_at DESC
      )
      SELECT
        ls.snapshot_id,
        ls.project_id,
        ls.project_title,
        ls.thesis_text,
        ls.notes_content,
        pns.id AS note_id,
        pns.note_title,
        pns.note_path,
        pns.content_snippet
      FROM latest_snaps ls
      LEFT JOIN project_note_snapshots pns ON pns.project_snapshot_id = ls.snapshot_id
      ORDER BY ls.project_title ASC, pns.note_title ASC
    `);

    const notesCatalog: Array<{
      refId: string;
      id: string;
      projectId: string;
      projectTitle: string;
      noteTitle: string;
      notePath: string;
      contentSnippet: string | null;
    }> = [];

    let noteCounter = 1;
    for (const row of latestNotesRes.rows as any[]) {
      if (row.note_id) {
        notesCatalog.push({
          refId: `N${noteCounter++}`,
          id: row.note_id as string,
          projectId: row.project_id as string,
          projectTitle: row.project_title as string,
          noteTitle: (row.note_title as string) || 'Nota sin título',
          notePath: (row.note_path as string) || '',
          contentSnippet: (row.content_snippet as string) || null,
        });
      } else if (row.notes_content || row.thesis_text) {
        // Fallback if project snapshot has no granular rows in project_note_snapshots
        notesCatalog.push({
          refId: `N${noteCounter++}`,
          id: row.snapshot_id as string,
          projectId: row.project_id as string,
          projectTitle: row.project_title as string,
          noteTitle: `${row.project_title} (Resumen de Proyecto)`,
          notePath: `${row.project_title}.md`,
          contentSnippet: ((row.notes_content || row.thesis_text) as string).substring(0, 1800),
        });
      }
    }

    if (libraryCatalog.length === 0 && notesCatalog.length === 0) {
      return {
        query,
        diagnosis: 'Tu biblioteca y tu Vault de Obsidian aún no tienen contenidos ni notas procesadas para consultar.',
        projectViability: null,
        totalLibraryEvaluated: 0,
        totalNotesEvaluated: 0,
        matchedContents: [],
        matchedNotes: [],
      };
    }

    const libraryPromptBlock = libraryCatalog.length > 0
      ? libraryCatalog.map(item => {
          const bodyText = item.summary
            ? `Resumen: ${item.summary}`
            : `Extracto: ${item.rawPreview}`;
          return `[${item.refId}] Título: "${item.title || 'Sin título'}" | Fuente: ${item.channelOrDomain || item.uri}\n${bodyText}`;
        }).join('\n\n---\n\n')
      : 'No hay contenidos guardados en la biblioteca.';

    const notesPromptBlock = notesCatalog.length > 0
      ? notesCatalog.map(note => {
          const snippet = (note.contentSnippet || '').substring(0, 1800);
          return `[${note.refId}] Proyecto: "${note.projectTitle}" | Archivo de Nota: "${note.notePath || note.noteTitle}"\nContenido de la nota:\n${snippet}`;
        }).join('\n\n---\n\n')
      : 'No hay notas de proyectos activas en el Vault de Obsidian.';

    const systemPrompt = `Eres el Consultor de Investigación de Loom, un compañero intelectual que conoce a fondo tanto la Biblioteca de contenidos guardados por el usuario (videos, artículos, ensayos) como las Notas de sus Proyectos activos en su Vault de Obsidian.

Tu objetivo es responder con precisión, criterio analítico y honestidad a preguntas como:
- "¿Tenemos contenido relacionado a X, Y, Z?"
- "¿Puedo hacer un proyecto o ensayo sobre X?"
- "¿Qué argumentos, referencias o notas conectan con esta idea?"

REGLAS ESTRICTAS:
1. Evalúa TANTO el <CATALOGO_BIBLIOTECA> (referencias [C1], [C2]...) COMO las <NOTAS_PROYECTOS_OBSIDIAN> (referencias [N1], [N2]...).
2. No dependas solo de coincidencias literales de palabras: reconoce relaciones conceptuales, de categoría o de obra/autor (por ejemplo, si preguntan por "videojuegos", un ensayo sobre "Shadow of the Colossus" o una nota que menciona juegos indie ES directamente relevante).
3. En "diagnosis", responde en ESPAÑOL de forma clara, conversacional y estructurada. Cita explícitamente en el texto las referencias relevantes usando sus etiquetas exactas entre corchetes, por ejemplo [C1], [N1].
4. Si el usuario pregunta si puede armar un proyecto sobre un tema (o si detectas un puente fértil entre lo que tiene en la biblioteca y sus notas de Obsidian), completa "projectViability" con una propuesta concreta de enfoque, ángulo o estructura. Si es solo una consulta de inventario simple y no aplica o no hay material, puedes dejar "projectViability" en null o sugerir brevemente qué ángulo podría explorar con lo encontrado.
5. Incluye en "matchedContents" ÚNICAMENTE los contenidos [C#] que realmente aportan a la consulta (no rellenes con ítems irrelevantes), explicando en "whyItConnects" exactamente por qué ese video o artículo conecta con lo que preguntó el usuario.
6. Incluye en "matchedNotes" ÚNICAMENTE las notas de Obsidian [N#] que realmente conectan con la consulta (incluso si mencionan el tema como referencia, ejemplo o estructura), explicando en "whyItConnects" qué contiene esa nota y cómo aporta.`;

    const userMessage = `${promptBlock('CATALOGO_BIBLIOTECA', libraryPromptBlock)}

${promptBlock('NOTAS_PROYECTOS_OBSIDIAN', notesPromptBlock)}

${promptBlock('CONSULTA_DEL_USUARIO', query)}`;

    try {
      const { data: result } = await ollama.evaluateContent(systemPrompt, userMessage, consultAnswerSchema, undefined, { component: 'consult' });

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
            contentSnippet: note.contentSnippet,
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
        matchedContents,
        matchedNotes,
      };
    } catch (err: any) {
      server.log.error({ err }, 'Error during Consult Library & Vault LLM evaluation');
      return reply.status(500).send({
        error: 'Failed to consult library and vault',
        message: 'Error al analizar tu biblioteca y notas con el modelo de lenguaje.',
      });
    }
  });
}
