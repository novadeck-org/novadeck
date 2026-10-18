const dim = (text: string): string => `\x1b[0;2m${text}\x1b[0m`

/** What marks where a restored transcript ends and the new shell's output begins. */
export const restoredSeparator = (savedAt: Date | null): string => {
  const when = savedAt ? ` · saved ${savedAt.toLocaleString()}` : ""
  return dim(`── restored transcript${when} ──`)
}
