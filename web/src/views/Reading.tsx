import { FormEvent, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Link2, RefreshCw, Puzzle, Loader2 } from 'lucide-react';
import { useI18n } from '@/i18n';
import { api, ApiError, type ContentDetail, type ContentItem, type IngestStatus } from '@/lib/api';
import { safeHref } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Dialog } from '@/components/ui/dialog';
import { VerdictChip } from '@/components/VerdictChip';

const IN_FLIGHT: IngestStatus[] = ['pending', 'extracting', 'summarizing', 'embedding'];

export function Reading({ refreshKey, onChange }: { refreshKey: number; onChange: () => void }) {
  const { t, tRich, apiError, locale, lang } = useI18n();
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [filter, setFilter] = useState<IngestStatus | ''>('');
  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.contents(filter || undefined);
      setItems(data.items);
      setTotal(data.total);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [filter]);

  useEffect(() => { load(); }, [load, refreshKey]);

  // Poll while something is still being processed
  const inFlight = (items ?? []).some(i => IN_FLIGHT.includes(i.ingestStatus) || i.isEvaluating);
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => { if (!document.hidden) load(); }, 3000);
    return () => clearInterval(timer);
  }, [inFlight, load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (!value) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const { status, data } = await api.ingest(value);
      setUrl('');
      if (status === 202) toast.success(t('inbox.queued'));
      else toast.info(data.status === 'pending' ? t('inbox.retrying') : t('inbox.alreadyInLibrary'));
      await load();
      onChange();
    } catch (err) {
      const message = err instanceof ApiError ? apiError(err.body, 'error.ingest') : t('error.ingest');
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const retry = async (retryUrl: string) => {
    try {
      await api.ingest(retryUrl);
      toast.info(t('inbox.retryToast'));
      load();
    } catch {
      toast.error(t('error.retry'));
    }
  };

  return (
    <div className="grid gap-8">
      <section className="rounded-lg border border-line bg-surface p-6">
        <h2 className="font-serif text-2xl text-ink">{t('inbox.title')}</h2>
        <p className="mt-1 max-w-prose text-sm text-ink-2">{t('inbox.description')}</p>
        <form onSubmit={submit} className="mt-5 flex flex-col gap-3 sm:flex-row" id="ingest-form">
          <label htmlFor="url-input" className="sr-only">{t('inbox.urlLabel')}</label>
          <div className="relative flex-1">
            <Link2 size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
            <Input id="url-input" type="url" required autoComplete="off" value={url} onChange={e => setUrl(e.target.value)} placeholder={t('inbox.urlPlaceholder')} className="pl-9" />
          </div>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            {t('inbox.submit')}
          </Button>
        </form>
        {formError && <p role="alert" className="mt-3 text-sm text-danger">{formError}</p>}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm text-ink-3">
          <span>{t('inbox.clipperText')}</span>
          <Button size="sm" variant="ghost" onClick={() => setGuideOpen(true)} title={t('inbox.clipperTitle')}>
            <Puzzle size={15} aria-hidden="true" />{t('inbox.clipperButton')}
          </Button>
        </div>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-semibold text-ink">
            {t('feed.title')} <span className="ml-1 text-sm font-normal text-ink-3">{t('feed.count', { n: total })}</span>
          </h3>
          <div className="flex items-center gap-2">
            <label htmlFor="filter-status" className="sr-only">{t('feed.filterLabel')}</label>
            <Select id="filter-status" value={filter} onChange={e => setFilter(e.target.value as IngestStatus | '')}>
              <option value="">{t('feed.filterAll')}</option>
              <option value="ready">{t('feed.filterReady')}</option>
              <option value="extracting">{t('feed.filterExtracting')}</option>
              <option value="summarizing">{t('feed.filterSummarizing')}</option>
              <option value="embedding">{t('feed.filterEmbedding')}</option>
              <option value="failed">{t('feed.filterFailed')}</option>
            </Select>
            <Button size="icon" variant="ghost" onClick={load} aria-label={t('feed.refresh')} title={t('feed.refresh')}>
              <RefreshCw size={16} aria-hidden="true" />
            </Button>
          </div>
        </div>

        {loadError && <p role="alert" className="text-sm text-danger">{t('feed.loadError', { message: loadError })}</p>}
        {items === null && !loadError && <p className="text-sm text-ink-3">{t('feed.loading')}</p>}
        {items !== null && items.length === 0 && !filter && (
          <div className="rounded-lg border border-dashed border-line-strong p-8">
            <h4 className="font-serif text-lg text-ink">{t('firstRun.title')}</h4>
            <p className="mt-1 max-w-prose text-sm text-ink-2">{t('firstRun.body')}</p>
            <p className="mt-2 text-sm text-ink-3">{tRich('firstRun.demo', { file: <code>{lang === 'es' ? 'demo_vault/ARTICULOS_DEMO.md' : 'demo_vault_en/ARTICLES.md'}</code> })}</p>
          </div>
        )}
        {items !== null && items.length === 0 && filter && <p className="text-sm text-ink-3">{t('feed.empty')}</p>}

        <ul className="grid gap-3">
          {(items ?? []).map(item => (
            <ContentRow key={item.id} item={item} locale={locale} onOpen={() => setDetailId(item.id)} onRetry={() => retry(item.uri)} />
          ))}
        </ul>
      </section>

      <ContentDetailDialog id={detailId} onClose={() => setDetailId(null)} />
      <ExtensionGuide open={guideOpen} onOpenChange={setGuideOpen} />
    </div>
  );
}

function ContentRow({ item, locale, onOpen, onRetry }: { item: ContentItem; locale: string; onOpen: () => void; onRetry: () => void }) {
  const { t } = useI18n();
  const title = item.title || t('feed.extractingTitle');
  const statusLabel = t(`ingestStatus.${item.ingestStatus}`);
  const ready = item.ingestStatus === 'ready';
  const when = new Date(item.consumedAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });

  let state: string;
  if (!ready) state = statusLabel;
  else if (item.isEvaluating) state = t('feed.evaluating');
  else if (item.counts.actionable > 0) state = `${t('verdict.actionable')} (${item.counts.actionable})`;
  else if (item.counts.tentative > 0) state = `${t('verdict.tentative')} (${item.counts.tentative})`;
  else if (item.counts.irrelevant > 0) state = t('feed.noConnection');
  else state = t('feed.archived');

  return (
    <li className="content-item-card rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <button type="button" className="btn-detail cursor-pointer text-left font-serif text-base text-ink hover:text-ember" data-content-id={item.id} onClick={onOpen}>
            {title}
          </button>
          <p className="mt-0.5 flex min-w-0 gap-2 text-xs text-ink-3">
            {item.channelOrDomain && <span className="shrink-0 font-medium text-ink-2">{item.channelOrDomain}</span>}
            <span className="truncate">{item.uri}</span>
          </p>
        </div>
        <span className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-2">{state}</span>
      </div>

      {(item.evaluationsList ?? []).length > 0 && (
        <ul className="mt-3 grid gap-2 border-l-2 border-line pl-3">
          {item.evaluationsList!.map((ev, i) => (
            <li key={i} className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{ev.projectTitle}</span>
                <VerdictChip verdict={ev.verdict} score={ev.confidenceScore} />
              </div>
              {ev.triageReasoning && ev.verdict !== 'irrelevant' && <p className="mt-0.5 line-clamp-2 text-ink-2">{ev.triageReasoning}</p>}
            </li>
          ))}
        </ul>
      )}

      {item.ingestStatus === 'failed' && item.ingestStatusReason && (
        <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          <span><strong>{t('ingestStatus.failed')}:</strong> {item.ingestStatusReason}</span>
          <Button size="sm" onClick={onRetry}>{t('feed.retry')}</Button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-3">
        <span>{when}</span>
        <span>
          {item.counts.evaluations > 0
            ? t('feed.evaluations', { n: item.counts.evaluations, actionable: item.counts.actionable, tentative: item.counts.tentative || 0 })
            : item.isEvaluating ? t('feed.evaluatingNotes') : ready ? t('feed.saved') : statusLabel}
        </span>
      </div>
    </li>
  );
}

export function ContentDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<ContentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    if (!id) return;
    api.content(id).then(setData).catch(() => setError(t('error.detail')));
  }, [id, t]);

  const href = safeHref(data?.uri);
  return (
    <Dialog open={id !== null} onOpenChange={open => !open && onClose()} title={data?.title || (error ? t('modal.contentTitle') : t('common.loading'))} wide>
      <div id="modal-content-body" className="grid gap-5">
        {error && <p role="alert" className="text-danger"><strong>{t('modal.loadError')}</strong> {error}</p>}
        {data && (
          <>
            <section>
              <h4 className="mb-1 text-xs font-medium text-ink-3">{t('modal.source')}</h4>
              {href
                ? <a className="modal-uri-link break-all text-sm text-ember underline-offset-2 hover:underline" href={href} target="_blank" rel="noopener noreferrer">{data.uri}</a>
                : <span className="modal-uri-link break-all text-sm text-ink-2">{data.uri}</span>}
            </section>
            <section>
              <h4 className="mb-1 text-xs font-medium text-ink-3">{t('modal.summary')}</h4>
              <p className="prose-read whitespace-pre-line text-ink">{data.summary || t('modal.noSummary')}</p>
            </section>
            <section>
              <h4 className="mb-2 text-xs font-medium text-ink-3">{t('modal.evaluations')}</h4>
              {data.evaluations.length === 0 && <p className="text-sm text-ink-3">{t('modal.noEvaluations')}</p>}
              <ul className="grid gap-3">
                {data.evaluations.map(ev => (
                  <li key={ev.id} className="rounded-md border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm text-ink">{ev.projectTitle}</strong>
                      <VerdictChip verdict={ev.verdict} score={ev.confidenceScore} />
                    </div>
                    <p className="mt-1 text-sm text-ink-2">{ev.triageReasoning || t('sug.noReasoning')}</p>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}

function ExtensionGuide({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tRich } = useI18n();
  const steps = [
    { title: t('ext.step1'), body: tRich('ext.step1Text', { chrome: <code>chrome://extensions</code>, brave: <code>brave://extensions</code> }) },
    { title: t('ext.step2'), body: t('ext.step2Text') },
    { title: t('ext.step3'), body: tRich('ext.step3Text', { button: <strong>{t('ext.loadUnpacked')}</strong>, folder: <code>extension/</code> }) },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('ext.title')} description={t('ext.intro')}>
      <ol className="grid gap-4">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-ink">{i + 1}</span>
            <div>
              <p className="font-medium text-ink">{step.title}</p>
              <p className="text-sm text-ink-2">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </Dialog>
  );
}
