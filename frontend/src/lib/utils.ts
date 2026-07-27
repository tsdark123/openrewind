// =============================================================================
// utils.ts — tiny helpers shared across the frontend.
//
// `cn(...)` is the conventional className-merger expected by ported v0 / shadcn
// components (`@/lib/utils`). We don't pull in `clsx + tailwind-merge` for this
// one-liner: the v0 toolbar only needs falsy-filtering + space-joining.
// =============================================================================

export const cn = (
  ...args: Array<string | false | null | undefined | Record<string, boolean>>
): string => {
  const out: string[] = [];
  for (const a of args) {
    if (!a) continue;
    if (typeof a === 'string') {
      out.push(a);
    } else if (typeof a === 'object') {
      for (const [k, v] of Object.entries(a)) if (v) out.push(k);
    }
  }
  return out.join(' ');
};
