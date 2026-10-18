// Which adapters a build may carry, by Vite mode, the name of its entry. Each entry imports its
// own (src/entries/), so the build checks the result: a build for a runner (the desktop and web
// apps) holds no demo, the visitor build, a public page, holds neither the runner client nor
// the debug panel, and the content preview holds no runner client.
const forbiddenFolders = (mode: string): readonly string[] =>
  mode === "try"
    ? ["src/backend/runner/", "src/backend/demo/debug/"]
    : mode === "content-preview"
      ? ["src/backend/runner/"]
      : ["src/backend/demo/"]

// The module ids of a bundle that a build in this mode must not carry.
export const boundaryViolations = (mode: string, moduleIds: readonly string[]): string[] => {
  const folders = forbiddenFolders(mode)
  return moduleIds.filter((id) => {
    const path = id.split("\\").join("/")
    return folders.some((folder) => path.includes(`/${folder}`))
  })
}

// What the first chunk must not carry: the terminal emulator and its library. The app opens
// them with the connection, after the page has painted its first frame, so a build that
// pulls them into the entry's static imports would make every start wait on them.
const deferredLibraries = ["/@xterm/", "/@novadeck/emulator/", "/libraries/emulator/"]

// The part of a built bundle this checks: a chunk's file, whether it is an entry, the chunks
// it imports before it runs (not the ones it loads later) and the modules it holds.
export type BuiltChunk = {
  readonly type: string
  readonly isEntry?: boolean
  readonly imports?: readonly string[]
  readonly modules?: Readonly<Record<string, unknown>>
}

// The module ids of the entry chunks and everything they import statically that belong to a
// deferred library.
export const firstChunkViolations = (bundle: Readonly<Record<string, BuiltChunk>>): string[] => {
  const first = new Set<string>()
  const visit = (fileName: string): void => {
    if (first.has(fileName) || bundle[fileName]?.type !== "chunk") return
    first.add(fileName)
    bundle[fileName].imports?.forEach(visit)
  }
  for (const [fileName, chunk] of Object.entries(bundle))
    if (chunk.type === "chunk" && chunk.isEntry) visit(fileName)
  return [...first].flatMap((fileName) =>
    Object.keys(bundle[fileName]?.modules ?? {}).filter((id) => {
      const path = id.split("\\").join("/")
      return deferredLibraries.some((library) => path.includes(library))
    }),
  )
}
