export const shipped: readonly (readonly [number, string, number])[]
export const fuseProblems: (executable: string) => Promise<string[]>
export const openedCopy: (
  executable: string,
) => Promise<{ executable: string; root: string; remove: () => void }>
export const processesUnder: (root: string) => [pid: string, command: string][]
export const killUnder: (root: string) => void
export const closeWithin: (
  app: {
    close: () => Promise<unknown>
    process: () => { kill: (signal?: string) => unknown }
    windows: () => { title: () => Promise<string>; url: () => string }[]
  },
  root: string,
  output: string[],
  userData: string,
  ms?: number,
) => Promise<string | undefined>
