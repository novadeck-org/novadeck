// How much memory a computer has free for the model. Linux and Windows answer through
// `os.freemem()`. macOS keeps its cache as inactive and purgeable pages and never reports
// them as free, and Metal's own figure is per process, so there `vm_stat` is read.

/** The bytes `vm_stat`'s output calls available: free, inactive, purgeable and speculative pages. */
export const parseVmStat = (output: string): number | undefined => {
  const size = /page size of (\d+) bytes/.exec(output)?.[1]
  if (size === undefined) return undefined
  let pages = 0
  let found = false
  for (const name of ["free", "inactive", "purgeable", "speculative"]) {
    const count = new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(output)?.[1]
    if (count === undefined) continue
    pages += Number(count)
    found = true
  }
  return found ? pages * Number(size) : undefined
}
