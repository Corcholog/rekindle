import { describe, it, expect, vi } from 'vitest';
import { isYouTubeUrl, canonicalizeYouTubeUrl, extractYouTubeContent } from '../src/workers/ingestionWorker';
import { YoutubeTranscript } from 'youtube-transcript';

describe('YouTube Ingestor Unit Tests', () => {
  it('correctly detects YouTube URLs', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=g0MsGsKW1no')).toBe(true);
    expect(isYouTubeUrl('https://youtube.com/watch?v=g0MsGsKW1no')).toBe(true);
    expect(isYouTubeUrl('https://youtu.be/g0MsGsKW1no')).toBe(true);
    expect(isYouTubeUrl('https://m.youtube.com/watch?v=g0MsGsKW1no')).toBe(true);
    expect(isYouTubeUrl('https://blog.google/technology/ai/')).toBe(false);
    expect(isYouTubeUrl('not-a-valid-url')).toBe(false);
  });

  it('canonicalizes youtu.be shortlinks to standard watch?v= format', () => {
    expect(canonicalizeYouTubeUrl('https://youtu.be/g0MsGsKW1no')).toBe('https://www.youtube.com/watch?v=g0MsGsKW1no');
    expect(canonicalizeYouTubeUrl('https://www.youtube.com/watch?v=g0MsGsKW1no&t=10s')).toBe('https://www.youtube.com/watch?v=g0MsGsKW1no');
    expect(canonicalizeYouTubeUrl('https://example.com/article')).toBe('https://example.com/article');
  });

  it('extracts transcript and oEmbed title using mocked providers', async () => {
    const mockTranscript = [
      { text: 'Hola a todos,' },
      { text: 'hoy vamos a hablar de agentes autónomos y LLMs.' },
    ];

    vi.spyOn(YoutubeTranscript, 'fetchTranscript').mockResolvedValue(mockTranscript as any);

    // Mock fetch for oEmbed
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('youtube.com/oembed')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ title: 'Agentes Autónomos en Producción' }),
        });
      }
      return originalFetch(url);
    });

    const result = await extractYouTubeContent('https://youtu.be/test1234');

    expect(result.title).toBe('Agentes Autónomos en Producción');
    expect(result.rawText).toBe('Hola a todos, hoy vamos a hablar de agentes autónomos y LLMs.');

    vi.restoreAllMocks();
  });
});
