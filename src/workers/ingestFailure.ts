import type { IngestFailureKind } from '../db/schema';

/**
 * Why an ingest failed, as a code the web UI explains in the owner's language and answers with the
 * right fix: most failures mean Rekindle could not read the page (a PDF, a blocked site, a page that
 * builds its text with JavaScript), and the owner can paste the text instead.
 */

/** Raised when a page gives back so little text that it is probably a cookie wall, a paywall or a script-built page. */
export class TooLittleTextError extends Error {
  constructor(chars: number) {
    super(`Too little text extracted (${chars} characters)`);
  }
}

const PATTERNS: Array<[RegExp, IngestFailureKind]> = [
  [/Unsupported content type "application\/pdf/i, 'pdf'],
  [/Unsupported content type/i, 'unsupported_type'],
  [/Too little text extracted/i, 'too_little_text'],
  [/Failed to fetch URL: (?:401|403|429|451)\b/i, 'blocked'],
  [/Failed to fetch URL: (?:404|410)\b/i, 'not_found'],
  [/No subtitles or transcript|No se encontraron subtítulos/i, 'no_transcript'],
  [/Readability failed/i, 'no_text'],
  [/Access denied \(SSRF\)|Acceso denegado \(SSRF\)|Protocol '|Protocolo '|Invalid URL/i, 'not_allowed'],
  [/Failed to fetch URL|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed? ?out|redirects|Content size exceeds|Downloaded content exceeds/i, 'fetch_failed'],
];

export function classifyIngestFailure(message: string, url?: string): IngestFailureKind {
  const kind = PATTERNS.find(([pattern]) => pattern.test(message))?.[1] ?? 'other';
  // Some servers send PDFs as application/octet-stream
  if (kind === 'unsupported_type' && url && /\.pdf(?:$|[?#])/i.test(url)) return 'pdf';
  return kind;
}

