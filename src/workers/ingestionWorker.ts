import { boss } from '../queue';
import { db } from '../db';
import { contents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { sharedAiProvider } from '../ai/aiProvider';
import { env } from '../config';
import { summarizeText } from '../ai/summarize';
import * as net from 'net';
import { fetchPublicPage, isBlockedAddress } from '../net/safeFetch';
import { newTraceId, recordStage, timeStage, errorKindOf } from '../observability/pipeline';

import { YoutubeTranscript } from 'youtube-transcript';

const QUEUE_NAME = 'ingest_url';
const ollama = sharedAiProvider;

/**
 * Fast rejection at the API boundary for obviously local targets. The authoritative check
 * happens after DNS resolution in fetchPublicPage.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '');
  if (host === 'localhost') return true;
  if (net.isIP(host)) return isBlockedAddress(host);

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

export const setupIngestionWorker = async () => {
  const workerId = await boss.work(QUEUE_NAME, async (jobs: any) => {
    const jobArray = Array.isArray(jobs) ? jobs : [jobs];
    
    for (const job of jobArray) {
      if (!job || !job.data) continue;
      
      const { contentId, url, initialTitle, selection, traceId: jobTraceId } = job.data as {
        contentId: string;
        url: string;
        initialTitle?: string;
        selection?: string;
        traceId?: string;
      };
      // Jobs enqueued before tracing existed carry no trace ID
      const traceId = jobTraceId ?? newTraceId();
      const attempt = typeof job.retryCount === 'number' ? job.retryCount + 1 : null;
      const stage = { traceId, contentId, attempt };
      const jobStarted = Date.now();
      console.log(`Processing ingestion job for: ${url} (Content ID: ${contentId})`);

      try {
        // 1. Fast rejection of obviously local targets (fetchPublicPage re-checks after DNS)
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
          const yt = await timeStage({ ...stage, stage: 'extract', attrs: { source: 'youtube' } },
            () => extractYouTubeContent(url), r => ({ chars: r.rawText.length }));
          rawText = yt.rawText;
          channelOrDomain = yt.author || 'YouTube';
          title = yt.author && !yt.title.toLowerCase().includes(yt.author.toLowerCase())
            ? `${yt.title} - ${yt.author}`
            : yt.title;
        } else {
          // Public-internet only: every redirect hop and resolved IP is checked, body capped at 5 MB
          const page = await timeStage({ ...stage, stage: 'fetch', attrs: { source: 'web' } },
            () => fetchPublicPage(url), r => ({ bytes: r.text.length }));
          const html = page.text;
          const article = await timeStage({ ...stage, stage: 'extract', attrs: { source: 'web' } }, async () => {
            const doc = new JSDOM(html, { url: page.finalUrl });
            return new Readability(doc.window.document).parse();
          }, r => ({ chars: r?.textContent?.length ?? 0 }));

          if (!article || !article.textContent) {
            if (selection && selection.trim().length > 0) {
              rawText = selection.trim();
            } else {
              throw new Error('Readability failed to extract text content');
            }
          } else {
            rawText = article.textContent.trim().substring(0, 50000);
            if (selection && selection.trim().length > 0 && !rawText.includes(selection.trim().substring(0, 50))) {
              rawText = `[Cita seleccionada por el usuario]:\n${selection.trim()}\n\n---\n\n${rawText}`;
            }
          }

          const author = article?.byline ? article.byline.trim() : null;
          channelOrDomain = author || new URL(url).hostname.replace(/^www\./, '');
          const baseTitle = article?.title?.trim() || initialTitle || 'Unknown Title';
          title = author && !baseTitle.toLowerCase().includes(author.toLowerCase())
            ? `${baseTitle} - ${author}`
            : baseTitle;
        }

        // Update DB with rawText, title, and channelOrDomain
        await db.update(contents)
          .set({ rawText, title, channelOrDomain, ingestStatus: 'summarizing' })
          .where(eq(contents.id, contentId));

        // 3. Summarize through the LLM provider chain
        const summary = await timeStage({ ...stage, stage: 'summarize' },
          () => summarizeText(ollama, rawText, { traceId, contentId }),
          r => ({ inputChars: rawText.length, summaryChars: r.length }));

        await db.update(contents)
          .set({ summary, ingestStatus: 'embedding' })
          .where(eq(contents.id, contentId));

        // 4. Generate Embedding
        const embedding = await timeStage({ ...stage, stage: 'embed', attrs: { model: env.EMBED_MODEL, chars: summary.length } },
          () => ollama.getEmbedding(summary), r => ({ dimensions: r.length }));

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
        await boss.send('evaluate_content', { contentId, traceId }, { singletonKey: `eval:${contentId}`, retryLimit: 2 });
        console.log(`Enqueued evaluation job for content ${contentId}`);
        await recordStage({ ...stage, stage: 'ingest_job', durationMs: Date.now() - jobStarted, attrs: { source: isYouTubeUrl(url) ? 'youtube' : 'web' } });
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
        const isNonRetryable = /Failed to fetch URL: (?:400|401|403|404|410|422)|No se encontraron subtítulos|Unsupported content type|Content size exceeds|Downloaded content exceeds|Invalid URL|Readability failed|Acceso denegado \(SSRF\)|Protocolo '|more than \d+ redirects/i.test(errMsg);
        await recordStage({
          ...stage, stage: 'ingest_job', durationMs: Date.now() - jobStarted, ok: false, errorKind: errorKindOf(error),
          attrs: { source: isYouTubeUrl(url) ? 'youtube' : 'web', retryable: !isNonRetryable },
        });
        if (!isNonRetryable) {
          throw error;
        }
      }
    }
  });
  console.log(`Worker successfully registered for ${QUEUE_NAME} with ID: ${workerId}`);
};
