import type { ReactElement, ReactNode } from 'react';

const HEADER_CELL = 'px-3 py-2 text-left font-medium whitespace-nowrap';

interface DataTableProps {
  readonly headings: readonly string[];
  /** The rows, as <tr> elements. */
  readonly children: ReactNode;
}

/** A bordered table that scrolls sideways on a narrow screen. */
export function DataTable({ headings, children }: DataTableProps): ReactElement {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
        <thead className="bg-zinc-50 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
          <tr>
            {headings.map((heading) => (
              <th key={heading} scope="col" className={HEADER_CELL}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">{children}</tbody>
      </table>
    </div>
  );
}
