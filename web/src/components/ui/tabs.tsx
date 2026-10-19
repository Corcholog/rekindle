import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';
import { ComponentProps } from 'react';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('flex flex-wrap gap-1 border-b border-line', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        '-mb-px inline-flex items-center gap-2 border-b-2 border-transparent px-3 py-2 text-sm text-ink-2 hover:text-ink',
        'data-[state=active]:border-ember data-[state=active]:text-ink cursor-pointer',
        className,
      )}
      {...props}
    />
  );
}
