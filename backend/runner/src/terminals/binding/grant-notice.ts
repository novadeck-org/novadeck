import type { Grant } from "@novadeck/protocol"

/**
 * The grants a notice repeats, as many of the covering ones as the answer has room for, oldest
 * first: `render` gives their wrapper (empty for none) and `fits` says whether the answer
 * stays within what a hook may print with it. A terminal covered by more than fits would
 * otherwise never be told of the bar and the Inbox either, as their notice never fit. The
 * rest, `left`, are delivered to the terminal as messages, each of which fits alone.
 */
export const fitGrants = (
  covering: readonly Grant[],
  render: (grants: readonly Grant[]) => string,
  fits: (wrapped: string) => boolean,
): { readonly wrapped: string; readonly left: readonly Grant[] } => {
  for (let count = covering.length; count > 0; count -= 1) {
    const wrapped = render(covering.slice(0, count))
    if (fits(wrapped)) return { wrapped, left: covering.slice(count) }
  }
  return { wrapped: "", left: covering }
}
