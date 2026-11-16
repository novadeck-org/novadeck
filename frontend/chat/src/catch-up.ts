// A chat out of sight holds at what it last drew (see ./held). Back in sight, what came meanwhile
// draws in one render: a few blocks join the log as they would have, but a long backlog would build
// a whole window of new rows at once, and then colour, fold and measure them over the next frames
// as the log follows its end. A chat at its end then starts again from its last blocks, as it does
// when it mounts, and draws the earlier ones a few at a time once the page is idle.

/** How many blocks arrived after the one with id `last`: all of them where it's gone. */
export const arrivedSince = (
  blocks: readonly { readonly id: string }[],
  last: string | null,
): number => {
  if (last === null) return blocks.length
  const at = blocks.findLastIndex(({ id }) => id === last)
  return at === -1 ? blocks.length : blocks.length - 1 - at
}

/**
 * Whether a chat back in sight starts again from its last blocks: it was at its end, and more
 * arrived while it held than a step of the window draws.
 */
export const catchesUp = (atEnd: boolean, arrived: number, step: number): boolean =>
  atEnd && arrived > step
