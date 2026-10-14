import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db';
import { contents } from '../../db/schema';
import { sql } from 'drizzle-orm';
import { sharedAiProvider } from '../../ai/OllamaProvider';

const ollama = sharedAiProvider;

const LibrarySearchQuerySchema = z.object({
  q: z.string().min(1, 'El término de búsqueda es obligatorio'),
  limit: z.coerce.number().min(1).max(50).default(10),
});

const SearchResultItemSchema = z.object({
  id: z.string().uuid(),
  uri: z.string(),
  title: z.string().nullable(),
  channelOrDomain: z.string().nullable(),
  summary: z.string().nullable(),
  consumedAt: z.date(),
  similarityScore: z.number(),
});

const LibraryAskBodySchema = z.object({
  query: z.string().min(2, 'La pregunta debe tener al menos 2 caracteres'),
});

const askAnswerSchema = z.object({
  answer: z.string().describe('Respuesta sintética y clara a la pregunta del usuario basada en las fuentes de su biblioteca, en español, con citas como [1], [2]'),
  keyInsights: z.array(z.string()).describe('Lista de 2 a 4 conclusiones clave o puntos destacados'),
});

export default async function (server: FastifyInstance) {
  // 1. Semantic Vector Search across library
  server.get('/api/library/search', {
    schema: {
      querystring: LibrarySearchQuerySchema,
      response: {
        200: z.object({
          query: z.string(),
          total: z.number(),
          results: z.array(SearchResultItemSchema),
        }),
        400: z.object({
          error: z.string(),
          message: z.string().optional(),
        }),
        500: z.object({
          error: z.string(),
        }),
      },
    },
  }, async (request, reply) => {
    const { q, limit } = request.query as { q: string; limit: number };

    let queryVector: number[];
    try {
      queryVector = await ollama.getEmbedding(q);
    } catch (err) {
      server.log.error({ err }, 'Failed to compute embedding for query');
      return reply.status(500).send({
        error: 'Failed to compute query vector embedding',
      });
    }

    if (!queryVector || queryVector.length === 0) {
      return { query: q, total: 0, results: [] };
    }

    const targetVector = `[${queryVector.join(',')}]`;

    const searchResults = await db.execute(sql`
      SELECT 
        c.id,
        c.uri,
        c.title,
        c.channel_or_domain,
        c.summary,
        c.consumed_at,
        (c.embedding <=> ${targetVector}::vector) AS distance
      FROM ${contents} c
      WHERE c.ingest_status = 'ready'
        AND c.embedding IS NOT NULL
      ORDER BY distance ASC
      LIMIT ${limit}
    `);

    const results = searchResults.rows.map((row: any) => {
      const distance = typeof row.distance === 'number' ? row.distance : parseFloat(row.distance) || 0;
      // Cosine distance ranges from 0 (identical) to 2 (opposite); convert to 0..1 affinity score
      const similarityScore = Math.max(0, Math.min(1, Math.round((1 - distance) * 100) / 100));

      return {
        id: row.id as string,
        uri: row.uri as string,
        title: (row.title as string) || null,
        channelOrDomain: (row.channel_or_domain as string) || null,
        summary: (row.summary as string) || null,
        consumedAt: new Date(row.consumed_at),
        similarityScore,
      };
    });

    return {
      query: q,
      total: results.length,
      results,
    };
  });

  // 2. Ask My Library (RAG Question Answering)
  server.post('/api/library/ask', {
    schema: {
      body: LibraryAskBodySchema,
      response: {
        200: z.object({
          query: z.string(),
          answer: z.string(),
          keyInsights: z.array(z.string()),
          sources: z.array(z.object({
            index: z.number(),
            id: z.string().uuid(),
            title: z.string().nullable(),
            uri: z.string(),
            channelOrDomain: z.string().nullable(),
            similarityScore: z.number(),
          })),
        }),
        400: z.object({
          error: z.string(),
          message: z.string().optional(),
        }),
        500: z.object({
          error: z.string(),
        }),
      },
    },
  }, async (request, reply) => {
    const { query } = request.body as { query: string };

    let queryVector: number[];
    try {
      queryVector = await ollama.getEmbedding(query);
    } catch (err) {
      server.log.error({ err }, 'Failed to compute query embedding for Ask Library');
      return reply.status(500).send({
        error: 'Failed to compute query embedding',
      });
    }

    if (!queryVector || queryVector.length === 0) {
      return {
        query,
        answer: 'No se pudo vectorizar la consulta.',
        keyInsights: [],
        sources: [],
      };
    }

    const targetVector = `[${queryVector.join(',')}]`;

    // Fetch top 5 most relevant documents
    const topDocs = await db.execute(sql`
      SELECT 
        c.id,
        c.uri,
        c.title,
        c.channel_or_domain,
        c.summary,
        c.raw_text,
        (c.embedding <=> ${targetVector}::vector) AS distance
      FROM ${contents} c
      WHERE c.ingest_status = 'ready'
        AND c.embedding IS NOT NULL
      ORDER BY distance ASC
      LIMIT 5
    `);

    if (topDocs.rows.length === 0) {
      return {
        query,
        answer: 'Tu biblioteca aún no tiene contenidos procesados o listos para responder.',
        keyInsights: [],
        sources: [],
      };
    }

    const sources = topDocs.rows.map((row: any, idx: number) => {
      const distance = typeof row.distance === 'number' ? row.distance : parseFloat(String(row.distance)) || 0;
      const similarityScore = Math.max(0, Math.min(1, Math.round((1 - distance) * 100) / 100));
      return {
        index: idx + 1,
        id: row.id as string,
        uri: row.uri as string,
        title: (row.title as string) || null,
        channelOrDomain: (row.channel_or_domain as string) || null,
        summary: (row.summary as string) || '',
        rawSnippet: ((row.raw_text as string) || '').substring(0, 3000),
        similarityScore,
      };
    });

    // Check if the top document is sufficiently relevant (distance < 0.85)
    const bestDistance = typeof topDocs.rows[0].distance === 'number' 
      ? topDocs.rows[0].distance 
      : parseFloat(String(topDocs.rows[0].distance)) || 1;

    if (bestDistance > 0.85) {
      return {
        query,
        answer: 'No se encontraron artículos o lecturas en tu biblioteca con suficiente afinidad temática para responder a esta pregunta con certeza.',
        keyInsights: ['Intenta con otros términos clave o incorpora lecturas sobre el tema mediante el clipper o el buscador.'],
        sources: sources.map(s => ({
          index: s.index,
          id: s.id,
          title: s.title,
          uri: s.uri,
          channelOrDomain: s.channelOrDomain,
          similarityScore: s.similarityScore,
        })),
      };
    }

    // Prepare context for LLM
    const contextPrompt = sources.map(s => {
      return `[Fuente ${s.index}]: "${s.title || 'Sin título'}" (${s.channelOrDomain || s.uri})
${s.summary ? `Resumen: ${s.summary}\n` : ''}${s.rawSnippet ? `Extracto: ${s.rawSnippet}` : ''}`;
    }).join('\n\n---\n\n');

    const systemPrompt = `Eres el asistente de síntesis y consulta de la biblioteca personal Loom.
Tu misión es responder a la pregunta del usuario utilizando EXCLUSIVAMENTE la información provista en las FUENTES DE LA BIBLIOTECA.
REGLAS:
1. Responde SIEMPRE en ESPAÑOL, de forma rigurosa, clara y estructurada.
2. Cada afirmación clave debe citar su fuente usando corchetes numéricos, por ejemplo [1], [2].
3. Si las fuentes discrepan o abordan distintas facetas, sintetiza las diferencias constructivamente.
4. Si la información no está en las fuentes, indícalo con honestidad sin inventar datos.`;

    const userMessage = `<FUENTES_DE_LA_BIBLIOTECA>
${contextPrompt}
</FUENTES_DE_LA_BIBLIOTECA>

<PREGUNTA_DEL_USUARIO>
${query}
</PREGUNTA_DEL_USUARIO>`;

    try {
      const { data: result } = await ollama.evaluateContent(systemPrompt, userMessage, askAnswerSchema);

      return {
        query,
        answer: result.answer,
        keyInsights: result.keyInsights || [],
        sources: sources.map(s => ({
          index: s.index,
          id: s.id,
          title: s.title,
          uri: s.uri,
          channelOrDomain: s.channelOrDomain,
          similarityScore: s.similarityScore,
        })),
      };
    } catch (err) {
      server.log.error({ err }, 'Error during Ask Library LLM synthesis');
      return {
        query,
        answer: 'Ocurrió un error al sintetizar la respuesta con el modelo de lenguaje. Puedes consultar directamente las fuentes encontradas a continuación.',
        keyInsights: [],
        sources: sources.map(s => ({
          index: s.index,
          id: s.id,
          title: s.title,
          uri: s.uri,
          channelOrDomain: s.channelOrDomain,
          similarityScore: s.similarityScore,
        })),
      };
    }
  });
}
