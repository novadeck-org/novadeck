// Terminals whose agent finished while the person looked elsewhere, by the session context
// (`${projectId}/${workspaceSessionId}`) that holds them, each with how its turn ended:
// `done` on its own, or `failed` on an error. Each stays marked until the person views it
// or its agent starts another turn.
export type UnreadEnd = "done" | "failed"
export type Unread = Readonly<Record<string, Readonly<Record<string, UnreadEnd>>>>

// The terminal the person is looking at: the selected one of the session on screen while
// the page has focus; null while it has none.
export type Viewing = { readonly context: string; readonly id: string } | null

export const noUnread: Unread = {}

// How the terminal's unread turn ended, or undefined when none waits.
export const unreadEnd = (unread: Unread, context: string, id: string): UnreadEnd | undefined =>
  unread[context]?.[id]

// Marks a finish, the latest one's end replacing an earlier one's, unless the person was
// looking at that terminal as it finished.
export const markUnread = (
  unread: Unread,
  context: string,
  id: string,
  end: UnreadEnd,
  viewing: Viewing,
): Unread =>
  unreadEnd(unread, context, id) === end || (viewing?.context === context && viewing.id === id)
    ? unread
    : { ...unread, [context]: { ...unread[context], [id]: end } }

export const clearUnread = (unread: Unread, context: string, id: string): Unread => {
  if (!unreadEnd(unread, context, id)) return unread
  const { [id]: _cleared, ...left } = unread[context]!
  const { [context]: _session, ...rest } = unread
  return Object.keys(left).length > 0 ? { ...rest, [context]: left } : rest
}

// Clears what the person now looks at.
export const viewUnread = (unread: Unread, viewing: Viewing): Unread =>
  viewing ? clearUnread(unread, viewing.context, viewing.id) : unread

// Keeps only the terminals still there, as `exists` tells by context and id.
export const keepUnread = (
  unread: Unread,
  exists: (context: string, id: string) => boolean,
): Unread => {
  let next = unread
  for (const [context, ends] of Object.entries(unread))
    for (const id of Object.keys(ends))
      if (!exists(context, id)) next = clearUnread(next, context, id)
  return next
}
