import { ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
  /** Required by Radix for screen readers; hidden visually when omitted. */
  description?: string;
}

export function Dialog({ open, onOpenChange, title, children, wide, description }: DialogProps) {
  const { t } = useI18n();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/45" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-[6vh] z-50 max-h-[88vh] w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto rounded-lg border border-line bg-surface p-6 shadow-2xl',
            wide ? 'max-w-3xl' : 'max-w-xl',
          )}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <DialogPrimitive.Title className="font-serif text-xl leading-snug text-ink">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label={t('common.closeWindow')}>
              <X size={18} />
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className={description ? 'mb-4 text-sm text-ink-2' : 'sr-only'}>
            {description ?? ''}
          </DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
