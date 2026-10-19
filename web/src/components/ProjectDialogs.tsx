import { ReactNode, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, RefreshCcw, Save } from 'lucide-react';
import { useI18n } from '@/i18n';
import { api, ApiError, type Synergy, type SynergyBridge, type Synthesis } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-medium text-ink-3">{title}</h4>
      {children}
    </section>
  );
}

async function copy(text: string, ok: string, fail: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.info(ok);
  } catch {
    toast.warning(fail);
  }
}

export function SynthesisDialog({ target, onClose }: { target: { projectId: string; title: string } | null; onClose: () => void }) {
  const { t, apiError } = useI18n();
  const [data, setData] = useState<Synthesis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setData(null);
    setError(null);
    setSavedPath(null);
    if (!target) return;
    api.synthesize(target.projectId)
      .then(result => { setData(result); toast.success(t('synth.done')); })
      .catch(err => setError(err instanceof ApiError ? apiError(err.body, 'error.synthesis') : t('error.synthesis')));
  }, [target, t, apiError]);

  const save = async () => {
    if (!target || !data) return;
    setSaving(true);
    try {
      const { filePath } = await api.saveSynthesis(target.projectId, data);
      setSavedPath(filePath);
      toast.success(t('synth.savedToast', { path: filePath }));
    } catch (err) {
      toast.error(err instanceof ApiError ? apiError(err.body, 'error.saveBrief') : t('error.saveBrief'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={open => !open && onClose()} title={data?.title ?? (target ? t('synth.title', { project: target.title }) : '')} wide>
      <div id="synthesis-modal-body" className="grid gap-5">
        {!data && !error && <p className="flex items-center gap-2 text-sm text-ink-2"><Loader2 size={16} className="animate-spin" aria-hidden="true" />{t('triage.synthesizing')}</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {data && (
          <>
            <p className="text-xs text-ink-3">
              {savedPath ? <>{t('synth.savedAt')} <code>{savedPath}</code></> : t('synth.notSaved')} · {t('synth.integrated', { n: data.acceptedCount })}
            </p>
            <Section title={t('synth.summary')}>
              <p className="prose-read whitespace-pre-line text-ink">{data.executiveSummary}</p>
            </Section>
            {data.suggestedNextSteps.length > 0 && (
              <Section title={t('synth.nextSteps')}>
                <ul className="prose-read list-disc pl-5 text-ink">
                  {data.suggestedNextSteps.map((step, i) => <li key={i}>{step}</li>)}
                </ul>
              </Section>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => copy(`${data.title}\n\n${data.executiveSummary}\n\n${data.markdownContent ?? ''}`, t('synth.copied'), t('common.copyFailed'))}>
                <Copy size={14} aria-hidden="true" />{t('synth.copy')}
              </Button>
              <Button size="sm" variant="primary" onClick={save} disabled={saving || savedPath !== null}>
                <Save size={14} aria-hidden="true" />{savedPath ? t('synth.saved') : t('synth.save')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

export function SynergyDialog({ synergy, onClose, onSaved }: { synergy: Synergy | null; onClose: () => void; onSaved: () => void }) {
  const { t, apiError } = useI18n();
  const [data, setData] = useState<SynergyBridge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const explore = useCallback(async (force: boolean) => {
    if (!synergy) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.exploreSynergy(synergy.projectA.id, synergy.projectB.id, force);
      setData(result);
      setSavedPath(result.isCached && result.filePath ? result.filePath : null);
      if (result.isCached && result.filePath) toast.info(t('syn.cachedToast', { path: result.filePath }));
    } catch (err) {
      setError(err instanceof ApiError ? apiError(err.body, 'error.synergy') : t('error.synergy'));
    } finally {
      setLoading(false);
    }
  }, [synergy, t, apiError]);

  useEffect(() => {
    setData(null);
    setSavedPath(null);
    if (synergy) explore(false);
  }, [synergy, explore]);

  const save = async () => {
    if (!synergy || !data) return;
    try {
      const { filePath } = await api.saveSynergy(synergy.projectA.id, synergy.projectB.id, data);
      setSavedPath(filePath);
      toast.success(t('syn.savedToast', { path: filePath }));
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? apiError(err.body, 'error.saveBridge') : t('error.saveBridge'));
    }
  };

  const title = data?.bridgeTitle ?? (synergy ? `${synergy.projectA.title} & ${synergy.projectB.title}` : t('syn.modalTitle'));
  return (
    <Dialog open={synergy !== null} onOpenChange={open => !open && onClose()} title={title} wide>
      <div id="synergy-modal-body" className="grid gap-5">
        {loading && <p className="flex items-center gap-2 text-sm text-ink-2"><Loader2 size={16} className="animate-spin" aria-hidden="true" />{t('syn.loading')}</p>}
        {error && <p role="alert" className="text-sm text-danger"><strong>{t('syn.error')}</strong> {error}</p>}
        {data && !loading && (
          <>
            <p className="text-xs text-ink-3">{savedPath ? <>{t('syn.savedInVault')}: <code>{savedPath}</code></> : t('syn.fresh')}</p>
            <Section title={t('syn.contactPoints')}><p className="prose-read whitespace-pre-line text-ink">{data.overview}</p></Section>
            <Section title={t('syn.sharedQuestions')}><ul className="prose-read list-disc pl-5 text-ink">{(data.sharedProblems ?? []).map((p, i) => <li key={i}>{p}</li>)}</ul></Section>
            <Section title={t('syn.crossBenefits')}><ul className="prose-read list-disc pl-5 text-ink">{(data.mutualBenefits ?? []).map((b, i) => <li key={i}>{b}</li>)}</ul></Section>
            {data.markdownContent && (
              <Section title={t('syn.markdownDraft')}>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 font-mono text-xs text-ink-2">{data.markdownContent}</pre>
              </Section>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => explore(true)}><RefreshCcw size={14} aria-hidden="true" />{t('syn.regenerate')}</Button>
              <Button size="sm" variant="ghost" onClick={() => copy(`${data.bridgeTitle}\n\n${data.overview}\n\n${data.markdownContent}`, t('syn.copied'), t('common.copyFailed'))}>
                <Copy size={14} aria-hidden="true" />{t('syn.copy')}
              </Button>
              {!savedPath && <Button size="sm" variant="primary" onClick={save}><Save size={14} aria-hidden="true" />{t('syn.save')}</Button>}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
