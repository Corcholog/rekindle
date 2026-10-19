import { useI18n } from '@/i18n';
import type { Verdict } from '@/lib/api';
import { cn } from '@/lib/utils';

export function VerdictChip({ verdict, score }: { verdict: Verdict | null; score?: number | null }) {
  const { t } = useI18n();
  const v = verdict === 'actionable' || verdict === 'tentative' ? verdict : 'irrelevant';
  const pct = Math.round((score ?? 0) * 100);
  return (
    <span className={cn(
      'rounded-full px-2 py-0.5 text-xs font-medium',
      v === 'actionable' && 'bg-act-soft text-act',
      v === 'tentative' && 'bg-tent-soft text-tent',
      v === 'irrelevant' && 'font-normal text-ink-3',
    )}>
      {t(`verdict.${v}`)}{v !== 'irrelevant' && score !== undefined && score !== null ? ` · ${pct}%` : ''}
    </span>
  );
}
