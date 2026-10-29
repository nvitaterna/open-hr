/** What checking a request gives: the value to build a job from, or why it is refused. */
export type PreviewResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reasons: readonly string[] };
