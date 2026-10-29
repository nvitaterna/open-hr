import type { ReactElement, ReactNode } from 'react';

interface SectionProps {
  readonly title: string;
  /** Shown on the right of the heading, such as a link. */
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}

/** A titled block of a page. */
export function Section({ title, aside, children }: SectionProps): ReactElement {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A bordered panel. */
export function Panel({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      {children}
    </div>
  );
}
