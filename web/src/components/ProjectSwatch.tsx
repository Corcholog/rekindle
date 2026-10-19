import { ComponentProps } from 'react';
import { useProjectHue } from '@/lib/projectHues';
import { cn } from '@/lib/utils';

/** A small square in the project's colour. Decorative: the project's name is always next to it. */
export function ProjectSwatch({ title, className }: { title: string | null | undefined; className?: string }) {
  const hue = useProjectHue(title);
  return <span data-proj={hue} aria-hidden="true" className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-[3px] bg-proj', className)} />;
}

/** A project's name in its colour, with its swatch. */
export function ProjectLabel({ title, className }: { title: string; className?: string }) {
  const hue = useProjectHue(title);
  return (
    <span data-proj={hue} className={cn('inline-flex min-w-0 items-center gap-1.5 font-medium text-proj-ink', className)}>
      <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-proj" />
      <span className="truncate">{title}</span>
    </span>
  );
}

/** A list item marked with its project's colour on the left edge. */
export function ProjectItem({ title, className, ...props }: { title: string } & ComponentProps<'li'>) {
  const hue = useProjectHue(title);
  return <li data-proj={hue} className={cn('border-l-4 border-l-proj', className)} {...props} />;
}
