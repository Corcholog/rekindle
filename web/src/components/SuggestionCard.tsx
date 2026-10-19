import { useState } from 'react';
import { toast } from 'sonner';
import { Check, ExternalLink, FileText, Flame, RotateCcw } from 'lucide-react';
import { useI18n } from '@/i18n';
import { api, ApiError, type DiscardReason, type Suggestion } from '@/lib/api';
import { cn, safeHref } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { heatOf, rekindles as rekindlesProject } from '@/lib/dormancy';

// Fixed reasons offered when discarding; the values match DISCARD_REASONS in src/db/schema.ts
// and each has a "reason.<value>" label in the dictionaries
export const DISCARD_REASONS: DiscardReason[] = ['unrelated', 'obvious', 'wrong_note', 'poorly_worded', 'other'];
const ACTION_TYPES = ['evidence_citation', 'counter_argument', 'unblocker', 'narrative_bridge', 'other'];

// The card's left edge is its project's heat now: flame while worked on, ember, then ash
const HEAT_EDGE = { burning: 'border-l-ember-hot', embers: 'border-l-ember', ash: 'border-l-ash' } as const;

export function SuggestionCard({ suggestion: s, onResolved, projectIdleDays }: { suggestion: Suggestion; onResolved: () => void; projectIdleDays?: number | null }) {
  const { t, tRich, apiError, locale } = useI18n();
  const [feedback, setFeedback] = useState('');
  const [reason, setReason] = useState<DiscardReason | ''>('');
  const [busy, setBusy] = useState(false);
  const [reasoning, setReasoning] = useState<string | null>(s.triageReasoning ?? null);
  const [score, setScore] = useState<number | null>(s.confidenceScore ?? null);

  const open = s.status === 'pending' || s.status === 'tentative';
  const tentative = s.status === 'tentative' || (s.status === 'discarded' && (s.targetFile === 'discarded' || s.targetFile === 'tentative'));
  const rekindles = rekindlesProject(s.projectIdleDays) && s.status !== 'discarded';
  const href = safeHref(s.contentUri);
  const chip = s.status === 'tentative' ? t('sug.tentative')
    : s.status === 'discarded' ? (s.targetFile === 'discarded' ? t('sug.discardedByFilter') : t('sug.discarded'))
      : s.status === 'accepted' ? t('sug.accepted')
        : ACTION_TYPES.includes(s.actionType) ? t(`action.${s.actionType}`) : s.actionType;
  // The note the model says this belongs in; tentative items have none. Accepting never edits it:
  // the suggestion is appended to the project's suggestions.md, with a link to this note
  const note = s.targetFile && !['discarded', 'tentative', 'unknown', 'suggestions.md'].includes(s.targetFile) ? s.targetFile : null;
  // Verdicts differ by shape: actionable is a lit chip, tentative a smouldering outline
  const chipStyle = s.status === 'tentative' ? 'border border-dashed border-ember/70 text-ember'
    : s.status === 'discarded' ? 'text-ink-3'
      : s.status === 'accepted' ? 'bg-surface text-ink-2 ring-1 ring-line'
        : 'bg-ember-soft text-ember';

  const resolve = async (status: 'accepted' | 'discarded') => {
    setBusy(true);
    try {
      await api.resolve(s.id, status, feedback.trim(), status === 'discarded' && reason ? reason : undefined);
      toast.success(status === 'accepted' ? t('sug.acceptedToast') : t('sug.discardedToast'));
      onResolved();
    } catch (err) {
      toast.error(err instanceof ApiError ? apiError(err.body, 'error.update') : t('error.update'));
      setBusy(false);
    }
  };

  const reevaluate = async () => {
    setBusy(true);
    try {
      const { resolution } = await api.reevaluate(s.id);
      toast.success(t(resolution === 'keep_or_refine' ? 'sug.keptToast' : resolution === 'already_addressed' ? 'sug.addressedToast' : 'sug.obsoleteToast'));
      onResolved();
    } catch (err) {
      toast.error(err instanceof ApiError ? apiError(err.body, 'error.reevaluate') : t('error.reevaluate'));
      setBusy(false);
    }
  };

  const loadReasoning = async () => {
    if (reasoning !== null) return;
    try {
      const detail = await api.suggestion(s.id);
      setReasoning(detail.triageReasoning ?? t('sug.noReasoning'));
      setScore(detail.confidenceScore);
    } catch {
      setReasoning(t('error.detail'));
    }
  };

  return (
    <article
      className={cn(
        'suggestion-card overflow-hidden rounded-lg border border-l-4 bg-surface',
        rekindles ? 'rekindled border-ember/50' : 'border-line',
        HEAT_EDGE[heatOf(projectIdleDays ?? s.projectIdleDays)],
        s.status === 'discarded' && 'opacity-80',
      )}
      data-id={s.id}
      data-content-id={s.contentId}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2/50 px-5 py-2.5 text-xs">
        <span className="font-semibold text-ink">{s.projectTitle || t('sug.project')}</span>
        {rekindles && (
          // The one lit element of the card: this connection could relight a cold project
          <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-ember to-ember-2 px-2 py-0.5 font-medium text-ember-ink">
            <Flame size={13} aria-hidden="true" />{t('rekindle.badge', { n: s.projectIdleDays! })}
          </span>
        )}
        <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium', chipStyle)}>
          {s.status === 'accepted' && <Check size={12} aria-hidden="true" />}{chip}
        </span>
        {s.isStale && s.status === 'pending' && (
          <span className="rounded-full bg-surface px-2 py-0.5 text-ink-2" title={t('sug.staleTitle')}>{t('sug.stale')}</span>
        )}
        <span className="ml-auto text-ink-2">{new Date(s.createdAt).toLocaleDateString(locale)}</span>
      </div>
      <div className="p-5 pt-4">

      {tentative ? (
        // A tentative item has no action yet: lead with the article, the model's reasoning below
        <>
          <h4 className="prose-read text-lg leading-snug text-ink">{s.contentTitle || s.contentUri}</h4>
          <p className="prose-read mt-2 line-clamp-4 text-[0.95rem] text-ink-2">{s.suggestedAction}</p>
        </>
      ) : (
        <>
          <h4 className="prose-read text-lg leading-snug text-ink">{s.suggestedAction}</h4>
          <p className="prose-read mt-2 text-[0.95rem] text-ink-2">{s.observation}</p>
        </>
      )}

      <dl className="mt-4 grid gap-1 text-sm">
        {note && (
          <div className="flex flex-wrap items-center gap-2">
            <dt className="text-ink-3">{t('sug.suggestedNote')}</dt>
            <dd className="suggested-note flex items-center gap-1 text-ink"><FileText size={14} aria-hidden="true" /><code>{note}</code></dd>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <dt className="text-ink-3">{t('sug.source')}</dt>
          <dd className="min-w-0">
            {href
              ? <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ember underline-offset-2 hover:underline">{s.contentTitle || s.contentUri}<ExternalLink size={12} aria-hidden="true" /></a>
              : <span className="text-ink-2">{s.contentTitle || s.contentUri}</span>}
          </dd>
        </div>
      </dl>
      {s.status !== 'discarded' && (
        <p className="saved-to mt-2 text-xs text-ink-3">
          {tRich(s.status === 'accepted' ? 'sug.writtenTo' : s.status === 'tentative' ? 'sug.savedOnIntegrate' : 'sug.savedOnAccept', { file: <code>suggestions.md</code> })}
        </p>
      )}

      <details className="mt-3 text-sm" onToggle={e => (e.currentTarget as HTMLDetailsElement).open && loadReasoning()}>
        <summary className="cursor-pointer text-ink-2 hover:text-ink">{t('sug.showMore')}</summary>
        <div className="mt-2 rounded-md bg-surface-2 p-3">
          {score !== null && s.status !== 'discarded' && <p className="mb-1 text-xs text-ink-3">{t('sug.affinity')} {Math.round(score * 100)}%</p>}
          <p className="text-ink-2">{reasoning ?? t('sug.loadingReasoning')}</p>
        </div>
      </details>

      {open ? (
        <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 lg:flex-row lg:items-center">
          <label htmlFor={`feedback-${s.id}`} className="sr-only">{t('sug.feedbackLabel')}</label>
          <Input
            id={`feedback-${s.id}`}
            className="feedback-input lg:flex-1"
            placeholder={s.status === 'tentative' ? t('sug.feedbackTentative') : t('sug.feedbackPending')}
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select id={`reason-${s.id}`} aria-label={t('sug.reasonAria')} value={reason} onChange={e => setReason(e.target.value as DiscardReason | '')}>
              <option value="">{t('sug.reasonPlaceholder')}</option>
              {DISCARD_REASONS.map(r => <option key={r} value={r}>{t(`reason.${r}`)}</option>)}
            </Select>
            {s.isStale && s.status === 'pending' && (
              <Button size="sm" variant="ghost" onClick={reevaluate} disabled={busy} title={t('sug.reevaluateTitle')}>
                <RotateCcw size={14} aria-hidden="true" />{t('sug.reevaluate')}
              </Button>
            )}
            <Button size="sm" variant="danger" className="btn-discard" onClick={() => resolve('discarded')} disabled={busy}>{t('sug.discard')}</Button>
            <Button size="sm" variant="accept" className="btn-accept" onClick={() => resolve('accepted')} disabled={busy}>
              {s.status === 'tentative' ? t('sug.integrate') : t('sug.accept')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-4 border-t border-line pt-3 text-right text-xs text-ink-3">
          {s.status === 'accepted' ? t('sug.integratedObsidian') : s.targetFile === 'discarded' ? t('sug.discardedAuto') : t('sug.discardedManual')}
        </p>
      )}
      </div>
    </article>
  );
}
