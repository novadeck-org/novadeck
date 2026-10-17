// Quoting for each language a value is written into, as one word of it.

export const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

export const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`

export const fishQuote = (value: string): string =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`

/** Batch files expand %VAR% even inside quotes; a path can't hold a double quote. */
export const cmdQuote = (value: string): string => `"${value.replaceAll("%", "%%")}"`
