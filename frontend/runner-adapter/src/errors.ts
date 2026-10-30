// What went wrong, in the error's own words, or the value itself where it has none.
export const reasonOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)
