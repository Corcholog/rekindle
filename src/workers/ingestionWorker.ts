import { boss } from '../queue';
import { db } from '../db';
import { contents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { sharedAiProvider } from '../ai/OllamaProvider';
import { env } from '../config';
import { z } from 'zod';

import { YoutubeTranscript } from 'youtube-transcript';

const QUEUE_NAME = 'ingest_url';
const ollama = sharedAiProvider;

export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '169.254.169.254'
  ) {
    return true;
  }

  const parts = host.split('.').map(Number);
  if (parts.length === 4 && parts.every(p => !isNaN(p) && p >= 0 && p <= 255)) {
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 0) return true;
  }

  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.localhost')) {
    return true;
  }

  return false;
}

export function isYouTubeUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
  } catch {
    return false;
  }
}

export function canonicalizeUrl(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    parsed.hash = '';

    // Strip common tracking query params
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref'];
    for (const p of trackingParams) {
      parsed.searchParams.delete(p);
    }

    const host = parsed.hostname.toLowerCase();

    // YouTube canonicalization (videos, shorts, embeds, live, youtu.be)
    if (host === 'youtu.be') {
      const videoId = parsed.pathname.replace(/^\//, '').split('/')[0];
      if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
    }
    if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
      const v = parsed.searchParams.get('v');
      if (v) return `https://www.youtube.com/watch?v=${v}`;

      const match = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        return `https://www.youtube.com/watch?v=${match[1]}`;
      }
    }

    // Strip trailing slash for non-root paths
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.toString();
  } catch {
    return urlStr;
  }
}

export function canonicalizeYouTubeUrl(urlStr: string): string {
  return canonicalizeUrl(urlStr);
}

export async function extractYouTubeContent(url: string): Promise<{ title: string; rawText: string; author: string }> {
  const canonicalUrl = canonicalizeYouTubeUrl(url);

  // 1. Fetch Title & Author via oEmbed (official YouTube API without key requirement)
  let title = 'Video de YouTube';
  let author = '';
  try {
    const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`);
    if (oembedRes.ok) {
      const data: any = await oembedRes.json();
      if (data.title) title = data.title;
      if (data.author_name) author = data.author_name;
    }
  } catch (err) {
    console.warn(`[IngestWorker] Warning fetching YouTube oEmbed title:`, err);
  }

  // 2. Fetch transcript via YoutubeTranscript
  const parts = await YoutubeTranscript.fetchTranscript(canonicalUrl);
  if (!parts || parts.length === 0) {
    throw new Error('No se encontraron subtítulos o transcripción disponible para este video de YouTube');
  }

  const rawText = parts.map(p => p.text).join(' ').trim().substring(0, 50000);
  return { title, rawText, author };
}

const summarySchema = z.object({
  summary: z.string().describe('Un resumen estructurado del contenido extraído'),
});

export const setupIngestionWorker = async () => {
  const workerId = await boss.work(QUEUE_NAME, async (jobs: any) => {
    const jobArray = Array.isArray(jobs) ? jobs : [jobs];
    
    for (const job of jobArray) {
      if (!job || !job.data) continue;
      
      const { contentId, url } = job.data as { contentId: string, url: string };
      console.log(`Processing ingestion job for: ${url} (Content ID: ${contentId})`);

      try {
        // 1. Validate against SSRF
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          throw new Error(`Protocolo '${parsedUrl.protocol}' no permitido. Solo se admite http y https.`);
        }
        if (isPrivateOrLoopbackHost(parsedUrl.hostname)) {
          throw new Error(`Acceso denegado (SSRF): no se permite la ingesta de direcciones locales o privadas (${parsedUrl.hostname}).`);
        }

        // 2. Update status to extracting
        await db.update(contents)
          .set({ ingestStatus: 'extracting', ingestStatusReason: null })
          .where(eq(contents.id, contentId));

        // 2. Extract content (YouTube vs Standard Web Page)
        let rawText: string;
        let title: string;
        let channelOrDomain: string | null = null;

        if (isYouTubeUrl(url)) {
          console.log(`[IngestWorker] Extracting transcript for YouTube video: ${url}`);
          const yt = await extractYouTubeContent(url);
          rawText = yt.rawText;
          channelOrDomain = yt.author || 'YouTube';
          title = yt.author && !yt.title.toLowerCase().includes(yt.author.toLowerCase())
            ? `${yt.title} - ${yt.author}`
            : yt.title;
        } else {
          const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5 MB size cap
          const FETCH_TIMEOUT_MS = 15000; // 15s timeout

          const response = await fetch(url, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; LoomBot/1.0; +https://github.com/loom-assistant)',
              'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
            },
          });

          if (!response.ok) {
            throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
          }

          const contentType = response.headers.get('content-type') || '';
          if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml') && !contentType.includes('text/plain')) {
            throw new Error(`Unsupported content type "${contentType}". Only HTML or text web pages are supported.`);
          }

          const contentLength = response.headers.get('content-length');
          if (contentLength && parseInt(contentLength, 10) > MAX_HTML_BYTES) {
            throw new Error(`Content size exceeds 5MB limit (${contentLength} bytes)`);
          }

          const arrayBuffer = await response.arrayBuffer();
          if (arrayBuffer.byteLength > MAX_HTML_BYTES) {
            throw new Error(`Downloaded content exceeds 5MB limit (${arrayBuffer.byteLength} bytes)`);
          }

          const decoder = new TextDecoder('utf-8');
          const html = decoder.decode(arrayBuffer);
          const doc = new JSDOM(html, { url });
          const reader = new Readability(doc.window.document);
          const article = reader.parse();

          if (!article || !article.textContent) {
            throw new Error('Readability failed to extract text content');
          }

          rawText = article.textContent.trim().substring(0, 50000); // safety limit
          const author = article.byline ? article.byline.trim() : null;
          channelOrDomain = author || new URL(url).hostname.replace(/^www\./, '');
          const baseTitle = article.title ? article.title.trim() : 'Unknown Title';
          title = author && !baseTitle.toLowerCase().includes(author.toLowerCase())
            ? `${baseTitle} - ${author}`
            : baseTitle;
        }

        // Update DB with rawText, title, and channelOrDomain
        await db.update(contents)
          .set({ rawText, title, channelOrDomain, ingestStatus: 'summarizing' })
          .where(eq(contents.id, contentId));

        // 3. Summarize using Ollama
        const systemPrompt = "Eres un analista experto. Resume el texto proporcionado de manera concisa enfocándote en los puntos clave. Importante: Escribe el resumen siempre en Español, incluso si el texto original está en Inglés u otro idioma.";
        const { data: summaryResult } = await ollama.evaluateContent(systemPrompt, rawText, summarySchema);
        
        await db.update(contents)
          .set({ summary: summaryResult.summary, ingestStatus: 'embedding' })
          .where(eq(contents.id, contentId));

        // 4. Generate Embedding
        const embedding = await ollama.getEmbedding(summaryResult.summary);

        // 5. Save everything and mark ready
        await db.update(contents)
          .set({ 
            embedding,
            embeddingModel: env.EMBED_MODEL,
            ingestStatus: 'ready' 
          })
          .where(eq(contents.id, contentId));

        console.log(`Successfully ingested and vectorised: ${url}`);
        
        // 6. Trigger Evaluation Pipeline
        await boss.send('evaluate_content', { contentId }, { singletonKey: `eval:${contentId}`, retryLimit: 2 });
        console.log(`Enqueued evaluation job for content ${contentId}`);
      } catch (error: any) {
        console.error(`Error in ingestion worker for ${url}:`, error);
        
        await db.update(contents)
          .set({ 
            ingestStatus: 'failed',
            ingestStatusReason: error.message || 'Unknown error'
          })
          .where(eq(contents.id, contentId));

        // For permanent / non-retryable errors (e.g. 404, bad URL, unsupported format, no transcripts),
        // do not rethrow to pg-boss so it doesn't wastefully retry.
        const errMsg = error.message || '';
        const isNonRetryable = /Failed to fetch URL: (?:400|401|403|404|410|422)|No se encontraron subtítulos|Unsupported content type|Content size exceeds|Downloaded content exceeds|Invalid URL|Readability failed/i.test(errMsg);
        if (!isNonRetryable) {
          throw error;
        }
      }
    }
  });
  console.log(`Worker successfully registered for ${QUEUE_NAME} with ID: ${workerId}`);
};
