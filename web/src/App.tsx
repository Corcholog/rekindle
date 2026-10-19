import { useCallback, useEffect, useRef, useState } from 'react';
import { Toaster } from 'sonner';
import { BookOpen, Flame, MessagesSquare, Settings as SettingsIcon, TriangleAlert } from 'lucide-react';
import { useI18n } from '@/i18n';
import { api, type VaultSettings } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Reading } from '@/views/Reading';
import { Suggestions } from '@/views/Suggestions';
import { Consultant } from '@/views/Consultant';
import { Settings } from '@/views/Settings';

export type View = 'reading' | 'suggestions' | 'consultant' | 'settings';
const VIEWS: View[] = ['reading', 'suggestions', 'consultant', 'settings'];

// The view lives in the URL hash (#suggestions), so the back button and bookmarks work
const viewFromHash = (): View => {
  const name = window.location.hash.replace(/^#\/?/, '');
  return (VIEWS as string[]).includes(name) ? (name as View) : 'reading';
};

export function App() {
  const { t, lang } = useI18n();
  const [view, setViewState] = useState<View>(viewFromHash);
  const setView = useCallback((next: View) => {
    if (window.location.hash !== `#${next}`) window.location.hash = next;
    setViewState(next);
  }, []);
  useEffect(() => {
    const onHash = () => setViewState(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Bumped when background work finishes, so every view reloads its data
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey(k => k + 1), []);
  const [vault, setVault] = useState<VaultSettings | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const [activeCount, setActiveCount] = useState(0);
  const wasProcessing = useRef(false);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = t('meta.title');
  }, [lang, t]);

  useEffect(() => {
    api.vault().then(setVault).catch(() => setVault(null));
    api.projects()
      .then(d => setActiveCount(d.projects.reduce((sum, p) => sum + (p.counts.active ?? p.counts.pending + (p.counts.tentative ?? 0)), 0)))
      .catch(() => {});
  }, [refreshKey]);

  useEffect(() => {
    let inFlight = false;
    const check = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const s = await api.status();
        if (s.isProcessing) {
          setActivity(s.evaluatingJobs > 0 ? t('status.evaluating', { n: s.evaluatingJobs }) : t('status.ingesting'));
          wasProcessing.current = true;
        } else {
          setActivity(null);
          if (wasProcessing.current) {
            wasProcessing.current = false;
            refresh();
          }
        }
      } catch {
        // Transient network errors are ignored
      } finally {
        inFlight = false;
      }
    };
    check();
    const timer = setInterval(check, 2500);
    return () => clearInterval(timer);
  }, [t, refresh]);

  const healthy = vault ? vault.isConfigured && vault.isValid : true;
  const nav: { id: View; label: string; icon: typeof BookOpen; badge?: number }[] = [
    { id: 'reading', label: t('nav.inbox'), icon: BookOpen },
    { id: 'suggestions', label: t('nav.triage'), icon: Flame, badge: activeCount },
    { id: 'consultant', label: t('nav.consultant'), icon: MessagesSquare },
    { id: 'settings', label: t('nav.settings'), icon: SettingsIcon },
  ];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 bg-bg/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Logo size={30} />
            <div className="leading-tight">
              <h1 className="font-serif text-xl font-semibold tracking-tight text-ink">Rekindle</h1>
              <p className="hidden text-xs text-ink-3 sm:block">{t('brand.tagline')}</p>
            </div>
          </div>
          <nav aria-label={t('nav.aria')} className="order-3 flex w-full gap-1 overflow-x-auto [scrollbar-width:none] sm:order-none sm:w-auto">
            {nav.map(item => (
              <button
                key={item.id}
                type="button"
                id={`tab-${item.id}`}
                aria-current={view === item.id ? 'page' : undefined}
                onClick={() => setView(item.id)}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink',
                  view === item.id && 'bg-surface font-medium text-ink shadow-sm ring-1 ring-line',
                )}
              >
                <item.icon size={16} aria-hidden="true" />
                {item.label}
                {item.badge ? <span className="rounded-full bg-ember-soft px-1.5 text-xs font-semibold text-ember">{item.badge}</span> : null}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-xs text-ink-3" role="status" aria-live="polite">
            <span className={cn('h-2 w-2 rounded-full', activity ? 'animate-pulse bg-ember' : healthy ? 'bg-ok' : 'bg-danger')} aria-hidden="true" />
            <span>{activity ?? (healthy ? t('status.connected') : t('status.noVault'))}</span>
          </div>
        </div>
        <div className="ember-rule" aria-hidden="true" />
      </header>

      {!healthy && (
        <div role="alert" className="mx-auto mt-4 flex max-w-6xl items-center justify-between gap-4 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-ink">
          <span className="flex items-center gap-2"><TriangleAlert size={16} className="text-danger" aria-hidden="true" />{t('banner.text')}</span>
          <Button size="sm" onClick={() => setView('settings')}>{t('banner.button')}</Button>
        </div>
      )}

      <main className="mx-auto max-w-6xl px-4 py-6">
        {view === 'reading' && <Reading refreshKey={refreshKey} onChange={refresh} />}
        {view === 'suggestions' && <Suggestions refreshKey={refreshKey} onChange={refresh} />}
        {view === 'consultant' && <Consultant />}
        {view === 'settings' && <Settings refreshKey={refreshKey} onChange={refresh} vault={vault} />}
      </main>
      <Toaster position="bottom-right" richColors closeButton theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'} />
    </div>
  );
}
