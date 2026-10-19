import { FormEvent, Fragment, ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { ExternalLink, Loader2, Search } from 'lucide-react';
import { useI18n } from '@/i18n';
import { api, ApiError, type ConsultAnswer } from '@/lib/api';
import { safeHref } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { ContentDetailDialog } from '@/views/Reading';

const CITATION = /\[([CN]\d+(?:\s*,\s*[CN]\d+)*)\]/gi;

/** Model text with [C1] / [N2] references turned into links to the cited cards. Text only. */
function WithCitations({ text }: { text: string }) {
  const { t } = useI18n();
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(CITATION)) {
    parts.push(text.slice(last, match.index));
    match[1].split(/\s*,\s*/).forEach((raw, i) => {
      const ref = raw.trim().toUpperCase();
      parts.push(
        <Fragment key={`${match.index}-${i}`}>
          {i > 0 && ' '}
          <a
            href={`#consult-ref-${ref}`}
            data-ref={ref}
            title={t('consult.goToRef', { ref })}
            className="consult-ref-badge rounded bg-ember-soft px-1 font-sans text-xs font-semibold text-ember no-underline"
            onClick={e => {
              e.preventDefault();
              document.getElementById(`consult-ref-${ref}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
          >[{ref}]</a>
        </Fragment>,
      );
    });
    last = (match.index ?? 0) + match[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

export function Consultant() {
  const { t, apiError } = useI18n();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<ConsultAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const ask = async (q: string) => {
    const value = q.trim();
    if (!value) return;
    setQuery(value);
    setLoading(true);
    setError(null);
    try {
      setAnswer(await api.consult(value));
    } catch (err) {
      const message = err instanceof ApiError ? apiError(err.body, 'error.consult') : t('error.consult');
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); ask(query); };
  const chips = [1, 2, 3].map(n => ({ label: t(`consult.chip${n}`), query: t(`consult.chip${n}Query`) }));

  return (
    <div className="grid gap-6">
      <section className="rounded-lg border border-line bg-surface p-6">
        <h2 className="font-serif text-2xl text-ink">{t('consult.title')}</h2>
        <p className="mt-1 max-w-prose text-sm text-ink-2">{t('consult.description')}</p>
        <form id="consultant-query-form" onSubmit={submit} className="mt-5 flex flex-col gap-3 sm:flex-row">
          <label htmlFor="consultant-query-input" className="sr-only">{t('consult.inputLabel')}</label>
          <div className="relative flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
            <Input id="consultant-query-input" required autoComplete="off" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('consult.placeholder')} className="pl-9" />
          </div>
          <Button type="submit" variant="primary" disabled={loading}>
            {loading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            {loading ? t('consult.submitting') : t('consult.submit')}
          </Button>
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-2" aria-label={t('consult.examplesAria')}>
          <span className="text-xs text-ink-3">{t('consult.examples')}</span>
          {chips.map(chip => (
            <button key={chip.label} type="button" onClick={() => ask(chip.query)} className="cursor-pointer rounded-full border border-line px-3 py-1 text-xs text-ink-2 hover:border-ember hover:text-ink">
              {chip.label}
            </button>
          ))}
        </div>
      </section>

      {!answer && !loading && !error && <p className="text-sm text-ink-3">{t('consult.hint')}</p>}
      {loading && <p className="flex items-center gap-2 text-sm text-ink-2"><Loader2 size={16} className="animate-spin" aria-hidden="true" />{t('consult.reviewing')}</p>}
      {error && !loading && <p role="alert" className="text-sm text-danger">{error}</p>}

      {answer && !loading && (
        <>
          <section className="rounded-lg border border-line bg-surface p-6">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-serif text-xl text-ink">{answer.query}</h3>
              <div className="flex items-center gap-3 text-xs text-ink-3">
                <span>{t('consult.reviewed', { library: answer.totalLibraryEvaluated, notes: answer.totalNotesEvaluated })}</span>
                <Button size="sm" variant="ghost" onClick={() => setAnswer(null)}>{t('consult.clear')}</Button>
              </div>
            </div>
            <div className="prose-read grid gap-3 text-ink">
              {answer.diagnosis.split(/\n\n+/).map((para, i) => <p key={i} className="whitespace-pre-line"><WithCitations text={para} /></p>)}
            </div>
            {answer.projectViability && (
              <div className="mt-5 border-l-2 border-ember pl-4">
                <p className="text-sm font-semibold text-ink">{t('consult.suggestedProject')}</p>
                <p className="prose-read mt-1 text-ink-2"><WithCitations text={answer.projectViability} /></p>
              </div>
            )}
          </section>

          <div className="grid gap-6 md:grid-cols-2">
            <section>
              <h4 className="mb-3 text-sm font-semibold text-ink">{t('consult.inLibrary')} <span className="font-normal text-ink-3">{answer.matchedContents.length}</span></h4>
              {answer.matchedContents.length === 0 && <p className="text-sm text-ink-3">{t('consult.noContents')}</p>}
              <ul className="grid gap-3">
                {answer.matchedContents.map(item => {
                  const href = safeHref(item.uri);
                  return (
                    <li key={item.refId} id={`consult-ref-${item.refId}`} className="consultant-match-card rounded-md border border-line bg-surface p-4">
                      <div className="flex items-center justify-between gap-2 text-xs text-ink-3">
                        <span><span className="font-semibold text-ember">[{item.refId}]</span> {item.channelOrDomain || (/youtube\.com|youtu\.be/i.test(item.uri) ? t('consult.video') : t('consult.article'))}</span>
                        <span className="flex gap-2">
                          <button type="button" className="cursor-pointer hover:text-ink" onClick={() => setDetailId(item.id)}>{t('feed.details')}</button>
                          {href && <a href={href} target="_blank" rel="noopener noreferrer" className="source-link inline-flex items-center gap-1 hover:text-ink">{t('consult.openOriginal')}<ExternalLink size={11} aria-hidden="true" /></a>}
                        </span>
                      </div>
                      <p className="mt-1 font-serif text-ink">{item.title || item.uri}</p>
                      <p className="mt-1 text-sm text-ink-2">{item.whyItConnects}</p>
                    </li>
                  );
                })}
              </ul>
            </section>
            <section>
              <h4 className="mb-3 text-sm font-semibold text-ink">{t('consult.inNotes')} <span className="font-normal text-ink-3">{answer.matchedNotes.length}</span></h4>
              {answer.matchedNotes.length === 0 && <p className="text-sm text-ink-3">{t('consult.noNotes')}</p>}
              <ul className="grid gap-3">
                {answer.matchedNotes.map(note => (
                  <li key={note.refId} id={`consult-ref-${note.refId}`} className="consultant-match-card rounded-md border border-line bg-surface p-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                      <span className="font-semibold text-ember">[{note.refId}]</span>
                      <span className="font-medium text-ink-2">{note.projectTitle}</span>
                      <code>{note.notePath || note.noteTitle}</code>
                    </div>
                    <p className="mt-1 font-serif text-ink">{note.noteTitle || note.notePath}</p>
                    <p className="mt-1 text-sm text-ink-2">{note.whyItConnects}</p>
                    {note.contentSnippet && (
                      <details className="mt-2 text-sm">
                        <summary className="cursor-pointer text-ink-3 hover:text-ink">{t('consult.readSnippet')}</summary>
                        <pre className="mt-1 whitespace-pre-wrap font-serif text-ink-2">{note.contentSnippet.slice(0, 700)}{note.contentSnippet.length > 700 ? '…' : ''}</pre>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </>
      )}
      <ContentDetailDialog id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
