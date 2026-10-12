/** The comment that opens each file Novadeck writes. */
export const header = (comment: string, what: string): string =>
  [
    `${comment} Novadeck ${what}.`,
    `${comment} Written by Novadeck into its own data directory, and overwritten on each start.`,
    `${comment} Only Novadeck's shells, and agents you connected, use it.`,
  ].join("\n")
