/** Button styles the forms and wizards share. */

const BASE =
  'rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2';

export const PRIMARY_BUTTON = `${BASE} bg-emerald-700 text-white hover:bg-emerald-800 focus-visible:outline-emerald-700`;

export const DANGER_BUTTON = `${BASE} bg-red-700 text-white hover:bg-red-800 focus-visible:outline-red-700`;

export const SECONDARY_BUTTON = `${BASE} border border-zinc-300 hover:bg-zinc-100 focus-visible:outline-zinc-500 dark:border-zinc-700 dark:hover:bg-zinc-900`;
