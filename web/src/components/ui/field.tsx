import { forwardRef, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const base = 'w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-3 focus:border-ember focus:outline-none';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(base, 'h-10', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(base, 'py-2', className)} {...props} />
));
Textarea.displayName = 'Textarea';

// Native select: accessible, keyboard-friendly and themed through color-scheme
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(base, 'h-9 w-auto pr-8', className)} {...props} />
));
Select.displayName = 'Select';
