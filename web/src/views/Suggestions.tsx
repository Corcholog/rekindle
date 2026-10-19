import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BookMarked, ChevronDown, RefreshCcw, Sparkles, Loader2 } from 'lucide-react';
import { useI18n } from '@/i18n';
import { api, ApiError, type Project, type Suggestion, type SuggestionStatus, type Synergy } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmberMeter } from '@/components/EmberMeter';
import { activeCount, sortProjects } from '@/lib/dormancy';
import { SuggestionCard } from '@/components/SuggestionCard';
import { SynthesisDialog, SynergyDialog } from '@/components/ProjectDialogs';

const STATUSES: { id: SuggestionStatus; label: string; count: (p: Project['counts']) => number }[] = [
  { id: 'active', label: 'triage.tabActive', count: c => c.active ?? c.pending + (c.tentative ?? 0) },
  { id: 'pending', label: 'triage.tabPending', count: c => c.pending },
  { id: 'tentative', label: 'triage.tabTentative', count: c => c.tentative ?? 0 },
  { id: 'accepted', label: 'triage.tabAccepted', count: c => c.accepted },
  { id: 'discarded', label: 'triage.tabDiscarded', count: c => c.discarded },
];

const EMPTY_KEY: Record<SuggestionStatus, string> = {
  active: 'triage.emptyActive', pending: 'triage.emptyPending', tentative: 'triage.emptyTentative',
  accepted: 'triage.emptyAccepted', discarded: 'triage.emptyDiscarded',
};

export function Suggestions({ refreshKey, onChange }: { refreshKey: number; onChange: () => void }) {
  const { t, apiError } = useI18n();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<SuggestionStatus>('active');
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [synergies, setSynergies] = useState<Synergy[]>([]);
  const [synthesis, setSynthesis] = useState<{ projectId: string; title: string } | null>(null);
  const [synergy, setSynergy] = useState<Synergy | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);

  const loadProjects = useCallback(() => api.projects().then(d => setProjects(d.projects)).catch(() => {}), []);
  const loadSuggestions = useCallback(async () => {
    try {
      const data = await api.suggestions(status, selected);
      setItems(data.items);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [status, selected]);
  const loadSynergies = useCallback(async (manual = false) => {
    try {
      const data = await api.synergies();
      setSynergies(data.synergies);
      if (manual) toast.info(t('syn.computed', { n: data.synergies.length }));
    } catch {
      // Synergies need two indexed projects; the panel simply stays hidden
    }
  }, [t]);

  useEffect(() => { loadProjects(); loadSynergies(); }, [loadProjects, loadSynergies, refreshKey]);
  useEffect(() => { loadSuggestions(); }, [loadSuggestions, refreshKey]);

  const sorted = useMemo(() => sortProjects(projects), [projects]);
  const project = projects.find(p => p.id === selected) ?? null;
  const totals = useMemo(() => {
    const sum = { active: 0, pending: 0, tentative: 0, accepted: 0, discarded: 0, total: 0 };
    for (const p of projects) for (const s of STATUSES) sum[s.id] += s.count(p.counts);
    return sum;
  }, [projects]);
  const counts = project ? Object.fromEntries(STATUSES.map(s => [s.id, s.count(project.counts)])) as Record<SuggestionStatus, number> : totals;
  const visibleSynergies = synergies.filter(s => !selected || s.projectA.id === selected || s.projectB.id === selected);
  const stale = (items ?? []).filter(s => s.isStale && s.status === 'pending');

  const afterChange = async () => {
    await Promise.all([loadProjects(), loadSuggestions()]);
    onChange();
  };

  const batchReevaluate = async () => {
    if (stale.length === 0) {
      toast.info(t('sug.batchNone'));
      return;
    }
    setBatchRunning(true);
    try {
      let n = 0;
      for (const pid of [...new Set(stale.map(s => s.projectId))]) {
        n += (await api.reevaluateStale(pid)).reevaluatedCount ?? 0;
      }
      toast.success(t('sug.batchDone', { n }));
      await afterChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? apiError(err.body, 'error.batch') : t('error.batch'));
    } finally {
      setBatchRunning(false);
    }
  };

  const synthesize = () => {
    if (!project) {
      toast.warning(t('synth.pickProject'));
      return;
    }
    if (project.counts.accepted === 0) {
      toast.warning(t('synth.nothing'));
      return;
    }
    setSynthesis({ projectId: project.id, title: project.title });
  };

  return (
    <div className="grid gap-6 md:grid-cols-[16rem_minmax(0,1fr)]">
      <aside aria-labelledby="projects-heading" className="min-w-0">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 id="projects-heading" className="text-sm font-semibold text-ink">{t('triage.projects')}</h2>
          <span className="text-xs text-ink-3">{projects.length}</span>
        </div>
        <p className="mb-3 text-xs text-ink-3">{t('rekindle.sidebarHint')}</p>
        <ul id="projects-list" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
          <li>
            <ProjectButton active={selected === null} onClick={() => setSelected(null)} title={t('triage.allProjects')} count={totals.active} />
          </li>
          {sorted.map(p => (
            <li key={p.id}>
              <ProjectButton
                active={selected === p.id}
                onClick={() => setSelected(p.id)}
                title={p.title}
                count={activeCount(p)}
                meter={<EmberMeter idleDays={p.idleDays} />}
              />
            </li>
          ))}
        </ul>
      </aside>

      <section className="min-w-0">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 id="selected-project-title" className="font-serif text-2xl text-ink">{project?.title ?? t('triage.allProjects')}</h3>
            <p id="selected-project-thesis" className="mt-1 line-clamp-3 max-w-prose text-sm text-ink-2">
              {project ? project.thesisText || t('triage.noThesis') : t('triage.allProjectsThesis')}
            </p>
            {project && (
              <p className="mt-2 text-sm text-ink-3">
                <EmberMeter idleDays={project.idleDays} showLabel={false} />{' '}
                {project.idleDays === null ? t('idle.unknown') : project.idleDays === 0 ? t('idle.active') : t('idle.days', { n: project.idleDays })}
              </p>
            )}
          </div>
          {project && (
            <Button id="btn-synthesize-project" size="sm" onClick={synthesize} title={t('triage.synthesizeTitle')}>
              <BookMarked size={15} aria-hidden="true" />{t('triage.synthesize')}
            </Button>
          )}
        </div>

        {visibleSynergies.length > 0 && (
          // Collapsed by default: suggestions are the main content of this view
          <details id="synergies-section" className="group mb-6 rounded-lg border border-line bg-surface" aria-labelledby="synergies-heading">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3">
              <span>
                <span id="synergies-heading" className="font-semibold text-ink">{t('syn.title')}</span>
                <span className="ml-2 text-sm text-ink-3">{visibleSynergies.length}</span>
              </span>
              <ChevronDown size={16} className="text-ink-3 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="border-t border-line p-4">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <p className="text-sm text-ink-2">{t('syn.subtitle')}</p>
                <Button size="sm" variant="ghost" onClick={() => loadSynergies(true)} title={t('syn.refreshTitle')}>
                  <RefreshCcw size={14} aria-hidden="true" />{t('syn.refresh')}
                </Button>
              </div>
              <ul className="grid gap-3 sm:grid-cols-2">
                {visibleSynergies.map(s => (
                  <li key={s.id} className="synergy-card rounded-md border border-line p-3">
                    <p className="text-sm font-medium text-ink">{s.projectA.title} <span className="text-ink-3">&amp;</span> {s.projectB.title}</p>
                    <p className="mt-1 line-clamp-3 text-sm text-ink-2">{s.rationale.replace(/\[\[([^\]]+)\]\]/g, '$1')}</p>
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs text-ink-3">
                      <span>{s.similarityScore}%{s.hasExistingBridge ? ` · ${t('syn.inVault')}` : ''}</span>
                      <Button size="sm" variant="ghost" data-proj-a={s.projectA.id} data-proj-b={s.projectB.id} onClick={() => setSynergy(s)}>
                        <Sparkles size={14} aria-hidden="true" />{s.hasExistingBridge ? t('syn.viewBridge') : t('syn.explore')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        )}

        <Tabs value={status} onValueChange={v => setStatus(v as SuggestionStatus)}>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <TabsList aria-label={t('nav.triage')} className="flex-1">
              {STATUSES.map(s => (
                <TabsTrigger key={s.id} value={s.id} id={`tab-status-${s.id}`}>
                  {t(s.label)} <span className="text-xs text-ink-3">{counts[s.id]}</span>
                </TabsTrigger>
              ))}
            </TabsList>
            {stale.length > 0 && status !== 'accepted' && status !== 'discarded' && (
              <Button size="sm" onClick={batchReevaluate} disabled={batchRunning} title={t('triage.batchTitle')}>
                {batchRunning && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {batchRunning ? t('triage.batchRunning') : t('triage.batch', { n: stale.length })}
              </Button>
            )}
          </div>
        </Tabs>

        <div id="suggestions-list" className="mt-4 grid gap-4">
          {loadError && <p role="alert" className="text-sm text-danger">{t('triage.loadError', { message: loadError })}</p>}
          {items === null && !loadError && <p className="text-sm text-ink-3">{t('triage.loading')}</p>}
          {items !== null && items.length === 0 && (
            <div className="rounded-lg border border-dashed border-line-strong p-8 text-sm">
              <p className="text-ink-2">{t(EMPTY_KEY[status])}</p>
              {status === 'active' && <p className="mt-1 text-ink-3">{t('triage.emptyActiveHint')}</p>}
            </div>
          )}
          {(items ?? []).map(s => <SuggestionCard key={`${s.status}-${s.id}`} suggestion={s} onResolved={afterChange} />)}
        </div>
      </section>

      <SynthesisDialog target={synthesis} onClose={() => setSynthesis(null)} />
      <SynergyDialog synergy={synergy} onClose={() => setSynergy(null)} onSaved={() => loadSynergies()} />
    </div>
  );
}

function ProjectButton({ active, onClick, title, count, meter }: { active: boolean; onClick: () => void; title: string; count: number; meter?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'project-item flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-ink-2 hover:bg-surface-2 hover:text-ink',
        active && 'bg-surface text-ink ring-1 ring-line',
      )}
    >
      <span className="min-w-0 flex-1 truncate" title={title}>{title}</span>
      {meter}
      {count > 0 && <span className="rounded-full bg-surface-2 px-1.5 text-xs text-ink">{count}</span>}
    </button>
  );
}
