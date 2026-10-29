import { type ReactElement, useId } from 'react';

import type { PoolView } from '@ohr/shared/pool-view';
import { formatSize } from '@ohr/shared/sizes';

import { type DiagramCell, type DiagramColumn, layoutTiers } from '../tier-layout.ts';

const COLUMN_WIDTH = 96;
const GAP = 16;
const PLOT_HEIGHT = 280;
const TOP = 8;
const LABEL_HEIGHT = 44;
const CELL_INSET = 6;
const CELL_GAP = 2;
const CORNER = 4;
const LINE_HEIGHT = 14;
/** A cell this tall fits its tier name; twice that also fits its state. */
const ONE_LINE = 28;
const TWO_LINES = 44;
const NAME_Y = 18;
const SIZE_Y = 34;
const DASH = '4 3';
const DEV_PREFIX = '/dev/';

/** One colour per tier, repeating after five. */
const TIER_FILLS = [
  'fill-emerald-500 dark:fill-emerald-600',
  'fill-sky-500 dark:fill-sky-600',
  'fill-violet-500 dark:fill-violet-600',
  'fill-amber-500 dark:fill-amber-600',
  'fill-rose-500 dark:fill-rose-600',
];

function cellClass(cell: DiagramCell): string {
  const fill = TIER_FILLS[(cell.tier - 1) % TIER_FILLS.length] ?? TIER_FILLS[0];
  switch (cell.state) {
    case 'active':
      return `${fill}`;
    case 'rebuilding':
      return `${fill} opacity-60 stroke-zinc-900 dark:stroke-zinc-50`;
    case 'spare':
      return 'fill-zinc-300 dark:fill-zinc-700';
    case 'faulty':
      return 'fill-red-600';
    case 'missing':
      return 'fill-transparent stroke-red-600';
    default:
      throw new Error(`Unhandled member state: ${String(cell.state satisfies never)}`);
  }
}

function shortName(path: string): string {
  if (path.startsWith(DEV_PREFIX)) {
    return path.slice(DEV_PREFIX.length);
  }
  return path;
}

interface ColumnProps {
  readonly column: DiagramColumn;
  readonly index: number;
  /** Diagram units to SVG units. */
  readonly unit: number;
}

function Cell({ cell, x, unit }: { cell: DiagramCell; x: number; unit: number }): ReactElement {
  const bottom = TOP + PLOT_HEIGHT;
  const height = Math.max(1, cell.height * unit - CELL_GAP);
  const y = bottom - (cell.offset + cell.height) * unit;
  const width = COLUMN_WIDTH - 2 * CELL_INSET;
  const centre = x + COLUMN_WIDTH / 2;
  // With two lines, the tier name moves up half a line to make room for the state.
  let nameY = y + height / 2;
  if (height >= TWO_LINES) {
    nameY -= LINE_HEIGHT / 2;
  }
  let dash: string | undefined;
  if (cell.state === 'rebuilding' || cell.state === 'missing') {
    dash = DASH;
  }
  return (
    <g>
      <title>{`${cell.partition}: tier ${cell.tier}, ${cell.state}`}</title>
      <rect
        className={cellClass(cell)}
        x={x + CELL_INSET}
        y={y}
        width={width}
        height={height}
        rx={CORNER}
        strokeWidth={1.5}
        strokeDasharray={dash}
      />
      {height >= ONE_LINE && (
        <text
          className="fill-white text-xs font-medium dark:fill-zinc-50"
          x={centre}
          y={nameY}
          textAnchor="middle"
          dominantBaseline="middle"
        >
          Tier {cell.tier}
        </text>
      )}
      {height >= TWO_LINES && cell.state !== 'active' && (
        <text
          className="fill-white text-xs dark:fill-zinc-50"
          x={centre}
          y={y + height / 2 + LINE_HEIGHT / 2}
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {cell.state}
        </text>
      )}
    </g>
  );
}

function Column({ column, index, unit }: ColumnProps): ReactElement {
  const x = GAP + index * (COLUMN_WIDTH + GAP);
  const bottom = TOP + PLOT_HEIGHT;
  const stack = column.cells.reduce((top, cell) => Math.max(top, cell.offset + cell.height), 0);
  const driveHeight = (column.height ?? stack) * unit;
  let size = 'missing';
  if (column.sizeBytes !== null) {
    size = formatSize(column.sizeBytes);
  }
  return (
    <g>
      <rect
        className="fill-zinc-100 stroke-zinc-300 dark:fill-zinc-900 dark:stroke-zinc-700"
        x={x}
        y={bottom - driveHeight}
        width={COLUMN_WIDTH}
        height={driveHeight}
        rx={CORNER + 2}
      />
      {column.cells.map((cell) => (
        <Cell key={cell.partition} cell={cell} x={x} unit={unit} />
      ))}
      <text
        className="fill-zinc-900 text-sm font-medium dark:fill-zinc-50"
        x={x + COLUMN_WIDTH / 2}
        y={bottom + NAME_Y}
        textAnchor="middle"
      >
        {shortName(column.drive)}
      </text>
      <text
        className="fill-zinc-500 text-xs dark:fill-zinc-400"
        x={x + COLUMN_WIDTH / 2}
        y={bottom + SIZE_Y}
        textAnchor="middle"
      >
        {size}
      </text>
    </g>
  );
}

/**
 * The pool's drives as columns and its tiers as bands (plan section 5.6).
 * Wider than a phone with many drives, so it scrolls sideways there.
 */
export function TierDiagram({ pool }: { readonly pool: PoolView }): ReactElement {
  const titleId = useId();
  const diagram = layoutTiers(pool);
  const width = GAP + diagram.columns.length * (COLUMN_WIDTH + GAP);
  const height = TOP + PLOT_HEIGHT + LABEL_HEIGHT;
  const unit = PLOT_HEIGHT / diagram.scale;
  return (
    <div className="overflow-x-auto">
      <svg
        role="img"
        aria-labelledby={titleId}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
      >
        <title id={titleId}>
          {`Pool ${pool.id}: ${diagram.columns.length} drives, ${diagram.tiers.length} tiers`}
        </title>
        {diagram.columns.map((column, index) => (
          <Column key={column.drive} column={column} index={index} unit={unit} />
        ))}
      </svg>
      {!diagram.toScale && (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Not to scale: an array is not running, so its size is unknown.
        </p>
      )}
    </div>
  );
}
