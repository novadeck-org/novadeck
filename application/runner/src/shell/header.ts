/** The comment that opens each file NovaDeck writes. */
export const header = (comment: string, what: string): string =>
  [
    `${comment} NovaDeck ${what}.`,
    `${comment} Written by NovaDeck into its own data directory, and overwritten on each start.`,
    `${comment} Only NovaDeck's shells, and agents you connected, use it.`,
  ].join("\n")
