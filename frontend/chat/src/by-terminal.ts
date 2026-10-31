// A value kept for some terminals, by session context (`${projectId}/${workspaceSessionId}`)
// and terminal id; a terminal without one has no entry, and a context without terminals none
// either.
export type ByTerminal<T> = Readonly<Record<string, Readonly<Record<string, T>>>>

export const valueOf = <T>(map: ByTerminal<T>, context: string, id: string): T | undefined =>
  map[context]?.[id]

// The map with the terminal's value set, or dropped where it is undefined; the same map
// where that changes nothing, as `same` judges.
export const withValue = <T>(
  map: ByTerminal<T>,
  context: string,
  id: string,
  value: T | undefined,
  same: (a: T | undefined, b: T | undefined) => boolean = Object.is,
): ByTerminal<T> => {
  if (same(valueOf(map, context, id), value)) return map
  if (value !== undefined) return { ...map, [context]: { ...map[context], [id]: value } }
  const { [id]: _gone, ...left } = map[context]!
  const { [context]: _session, ...rest } = map
  return Object.keys(left).length > 0 ? { ...rest, [context]: left } : rest
}

// The map with only the terminals `keep` says yes to; the same map where it keeps them all.
export const keepTerminals = <T>(
  map: ByTerminal<T>,
  keep: (context: string, id: string) => boolean,
): ByTerminal<T> => {
  let next = map
  for (const [context, ids] of Object.entries(map))
    for (const id of Object.keys(ids))
      if (!keep(context, id)) next = withValue(next, context, id, undefined)
  return next
}
