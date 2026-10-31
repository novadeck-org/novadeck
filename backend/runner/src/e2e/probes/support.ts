// What the probes share: they run only when asked, by path, and some of them type into a box.

/** Waits `ms` milliseconds. */
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A paste of `words` as a terminal sends it, bracketed, its line breaks as Enters. */
export const paste = (words: string) => `\x1b[200~${words.replace(/\n/g, "\r")}\x1b[201~`

/** Whether the probes were asked for (NOVADECK_E2E_PROBES=1). */
export const probing = process.env.NOVADECK_E2E_PROBES === "1"
