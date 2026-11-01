export const shipped: readonly (readonly [number, string, number])[]
export const fuseProblems: (executable: string) => Promise<string[]>
export const openedCopy: (executable: string) => Promise<{ executable: string; remove: () => void }>
