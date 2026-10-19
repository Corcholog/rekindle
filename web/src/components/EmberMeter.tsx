import { useI18n } from '@/i18n';

import { heatOf } from '@/lib/dormancy';

// A project's idle time as a coal: burning this week, embers after, ash once dormant. A spark on
// the ash means something you read can rekindle it.

export function EmberMeter({ idleDays, showLabel = true, spark = false }: { idleDays: number | null | undefined; showLabel?: boolean; spark?: boolean }) {
  const { t } = useI18n();
  const known = idleDays !== null && idleDays !== undefined;
  const label = (known ? t('idle.meterLabel', { n: idleDays }) : t('idle.unknown')) + (spark ? `. ${t('idle.spark')}` : '');
  return (
    <span className="inline-flex items-center gap-1.5 text-xs tabular-nums text-ink-3" title={label}>
      <span className="ember-dot" data-heat={heatOf(idleDays)} data-spark={spark || undefined} aria-hidden="true" />
      {showLabel && <span aria-hidden="true">{known ? t('idle.short', { n: idleDays }) : '–'}</span>}
      <span className="sr-only">{label}</span>
    </span>
  );
}
