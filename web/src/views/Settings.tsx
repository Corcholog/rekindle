import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FolderSync, Loader2 } from 'lucide-react';
import { useI18n, type Language } from '@/i18n';
import { api, ApiError, type LanguageSettings, type Project, type VaultSettings } from '@/lib/api';
import { storedTheme, saveTheme, type ThemeChoice } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { EmberMeter } from '@/components/EmberMeter';

function Card({ title, description, children, aside }: { title: string; description?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-serif text-xl text-ink">{title}</h2>
          {description && <p className="mt-1 max-w-prose text-sm text-ink-2">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Settings({ refreshKey, onChange, vault }: { refreshKey: number; onChange: () => void; vault: VaultSettings | null }) {
  const { t, tRich, apiError, lang, setLang, locale } = useI18n();
  const [path, setPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [languages, setLanguages] = useState<LanguageSettings | null>(null);
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme());

  useEffect(() => { if (vault?.vaultPath) setPath(p => p || vault.vaultPath!); }, [vault]);
  useEffect(() => { api.projects().then(d => setProjects(d.projects)).catch(() => {}); }, [refreshKey]);
  useEffect(() => { api.languages().then(setLanguages).catch(() => {}); }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!path.trim()) {
      setFeedback({ kind: 'error', text: t('settings.enterPath') });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const data = await api.saveVault(path.trim());
      setFeedback({ kind: 'ok', text: t('settings.vaultSaved', { active: data.summary?.activeProjects ?? 0, missing: data.summary?.missingProjects ?? 0 }) });
      toast.success(t('settings.vaultSavedToast'));
      onChange();
    } catch (err) {
      const text = err instanceof ApiError ? apiError(err.body, 'error.saveVault') : t('error.saveVault');
      setFeedback({ kind: 'error', text });
    } finally {
      setSaving(false);
    }
  };

  const rescan = async () => {
    try {
      await api.rescan();
      toast.success(t('settings.rescanDone'));
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? apiError(err.body, 'error.rescan') : t('error.rescan'));
    }
  };

  const saveLanguage = async (body: Partial<Pick<LanguageSettings, 'outputLanguage' | 'notesLanguage'>>) => {
    try {
      setLanguages(await api.saveLanguages(body));
      toast.success(t('lang.saved'));
    } catch (err) {
      toast.error(err instanceof ApiError ? apiError(err.body, 'error.language') : t('error.language'));
    }
  };

  const status = !vault ? t('settings.checking')
    : vault.isConfigured && vault.isValid ? t('settings.statusConnected')
      : vault.isConfigured ? t('settings.statusNotFound') : t('settings.statusNotConfigured');
  const healthy = !!vault && vault.isConfigured && vault.isValid;
  const byId = new Map(projects.map(p => [p.id, p]));
  const languageOptions = (['es', 'en'] as Language[]).map(l => <option key={l} value={l}>{t(`lang.${l}`)}</option>);

  return (
    <div className="grid gap-6">
      <Card
        title={t('settings.vaultTitle')}
        description={t('settings.vaultDescription')}
        aside={<span id="settings-status-label" className={cn('rounded-full px-2.5 py-1 text-xs', healthy ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger')}>{status}</span>}
      >
        <form onSubmit={save} className="grid gap-2" noValidate>
          <label htmlFor="vault-path-input" className="text-sm font-medium text-ink">{t('settings.pathLabel')}</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input id="vault-path-input" value={path} onChange={e => setPath(e.target.value)} placeholder={t('settings.pathPlaceholder')} autoComplete="off" spellCheck={false} />
            <Button type="submit" variant="primary" disabled={saving}>
              {saving && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}{t('settings.save')}
            </Button>
          </div>
          <p className="text-xs text-ink-3">{tRich('settings.help', { projects: <code>Projects/</code>, proyectos: <code>Proyectos/</code> })}</p>
          {feedback && <p role={feedback.kind === 'error' ? 'alert' : 'status'} className={cn('text-sm', feedback.kind === 'error' ? 'text-danger' : 'text-ok')}>{feedback.text}</p>}
        </form>
        <dl className="mt-5 grid gap-x-6 gap-y-2 border-t border-line pt-4 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-ink-3">{t('settings.activePath')}</dt>
          <dd className="min-w-0 break-all text-ink"><code>{vault?.vaultPath || t('settings.notConfigured')}</code></dd>
          <dt className="text-ink-3">{t('settings.watcher')}</dt>
          <dd className={vault?.watcherActive ? 'text-ok' : 'text-ink-3'}>{vault?.watcherActive ? t('settings.watcherActive') : t('settings.inactive')}</dd>
          <dt className="text-ink-3">{t('settings.projectsFolder')}</dt>
          <dd className="text-ink">{vault?.hasProjectsDir ? t('settings.detected', { dir: vault.projectsDirName ?? 'Projects' }) : t('settings.notDetectedHint')}</dd>
        </dl>
        <div className="mt-4">
          <Button size="sm" onClick={rescan} title={t('settings.rescanTitle')}><FolderSync size={15} aria-hidden="true" />{t('settings.rescan')}</Button>
        </div>
      </Card>

      <Card title={t('settings.projectsTitle')} description={t('settings.projectsDescription')} aside={<span className="text-xs text-ink-3">{t('settings.projectsCount', { n: vault?.projects.length ?? 0 })}</span>}>
        {(vault?.projects.length ?? 0) === 0 ? (
          <p className="text-sm text-ink-3">{vault?.hasProjectsDir ? t('settings.noProjectsInDir', { dir: vault.projectsDirName || 'Projects' }) : t('settings.noProjectsNoVault')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ink-3">
                <tr className="border-b border-line">
                  <th className="py-2 pr-4 font-medium">{t('settings.colProject')}</th>
                  <th className="py-2 pr-4 font-medium">{t('settings.colFolder')}</th>
                  <th className="py-2 pr-4 font-medium">{t('settings.colLastEdit')}</th>
                  <th className="py-2 pr-4 font-medium">{t('settings.colSuggestions')}</th>
                  <th className="py-2 font-medium">{t('settings.colDisk')}</th>
                </tr>
              </thead>
              <tbody>
                {vault!.projects.map(p => {
                  const info = byId.get(p.id);
                  return (
                    <tr key={p.id} className="border-b border-line last:border-0">
                      <td className="py-2 pr-4 font-medium text-ink">{p.title}</td>
                      <td className="py-2 pr-4"><code>{p.folderPath}</code></td>
                      <td className="py-2 pr-4 text-ink-2">
                        <span className="inline-flex items-center gap-2">
                          <EmberMeter idleDays={info?.idleDays} showLabel={false} />
                          {info?.notesModifiedAt ? new Date(info.notesModifiedAt).toLocaleDateString(locale) : t('idle.unknown')}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-ink-2">{t('settings.suggestionsCount', { n: p.suggestionsCount })}</td>
                      <td className="py-2">
                        {p.existsOnDisk
                          ? <span className="text-ok">{t('settings.onDisk')}</span>
                          : <span className="text-danger" title={t('settings.missingTitle')}>{t('settings.missing')}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title={t('lang.title')} description={t('lang.description')}>
          <div className="grid gap-3 text-sm">
            <label className="grid gap-1"><span className="text-ink">{t('lang.ui')}</span>
              <Select id="ui-language-select" value={lang} onChange={e => setLang(e.target.value as Language)}>{languageOptions}</Select>
            </label>
            <label className="grid gap-1"><span className="text-ink">{t('lang.output')}</span>
              <Select id="output-language-select" value={languages?.outputLanguage ?? ''} disabled={!languages} onChange={e => saveLanguage({ outputLanguage: e.target.value as Language })}>{languageOptions}</Select>
            </label>
            <label className="grid gap-1"><span className="text-ink">{t('lang.notes')}</span>
              <Select id="notes-language-select" value={languages?.notesLanguage ?? ''} disabled={!languages} onChange={e => saveLanguage({ notesLanguage: e.target.value as Language })}>{languageOptions}</Select>
              <span className="text-xs text-ink-3">{t('lang.notesHelp')}</span>
            </label>
          </div>
        </Card>
        <Card title={t('theme.label')}>
          <div role="radiogroup" aria-label={t('theme.label')} className="flex flex-wrap gap-2">
            {(['system', 'light', 'dark'] as ThemeChoice[]).map(choice => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={theme === choice}
                onClick={() => { setTheme(choice); saveTheme(choice); }}
                className={cn('cursor-pointer rounded-md border px-3 py-2 text-sm', theme === choice ? 'border-ember bg-ember-soft text-ink' : 'border-line text-ink-2 hover:text-ink')}
              >
                {t(`theme.${choice}`)}
              </button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
