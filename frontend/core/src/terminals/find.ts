// Finding a terminal by what is typed: its handle, name and folder, joined, as Find a
// terminal and the History pane both match.

// What is typed, set for matching: no `@` before a handle, no case.
export const findQuery = (typed: string): string => typed.trim().replace(/^@/, "").toLowerCase()

// Whether the words a terminal is known by hold what is typed. A missing word is left out,
// and the rest are joined by a space, so what is typed can run from one word into the next.
export const matchesQuery = (
  words: readonly (string | null | undefined)[],
  typed: string,
): boolean => words.filter(Boolean).join(" ").toLowerCase().includes(findQuery(typed))
