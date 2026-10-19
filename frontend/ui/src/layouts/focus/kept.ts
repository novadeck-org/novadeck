// Focus keeps the terminals it last displayed mounted, out of sight, so switching back to
// one finds it as it was: its companion pane, a page loaded there, a plan's editor and
// where each was scrolled. Older ones unmount, so a long session doesn't hold them all.
export const keptLimit = 4

// The terminals Focus keeps, the one displayed first, then the ones displayed before it
// that are still here. The same array when nothing changed.
export const keptTerminals = (
  previous: readonly string[],
  displayed: string,
  present: readonly string[],
  limit = keptLimit,
): readonly string[] => {
  const next = [
    displayed,
    ...previous.filter((id) => id !== displayed && present.includes(id)),
  ].slice(0, limit)
  return next.length === previous.length && next.every((id, index) => id === previous[index])
    ? previous
    : next
}
