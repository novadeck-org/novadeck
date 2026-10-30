// Text the runner's domains build the same way: lists in a sentence, and lines cut short.

/** "a, b and c": the items of a sentence, the last joined by `conjunction`. */
export const list = (items: readonly string[], conjunction = "and"): string =>
  items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`

/** The first `shown` items, then how many more: "a, b and 3 more". */
export const firstFew = (items: readonly string[], shown: number): string => {
  const more = items.length - shown
  return `${items.slice(0, shown).join(", ")}${more > 0 ? ` and ${more} more` : ""}`
}

/** Text on one line, cut to `max` characters (code points, never half of one) with an ellipsis. */
export const shorten = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim()
  const characters = [...line]
  return characters.length > max
    ? `${characters
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`
    : line
}
