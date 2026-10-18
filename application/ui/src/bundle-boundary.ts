// Which adapters a build may carry, by Vite mode, the name of its entry. Each entry imports its
// own (src/entries/), so the build checks the result: a build for a runner (the desktop and web
// apps) holds no demo, and the visitor build, a public page, holds neither the runner client
// nor the debug panel.
const demoModes = new Set(["content-preview", "try"])

const forbiddenFolders = (mode: string): readonly string[] =>
  mode === "try"
    ? ["src/backend/runner/", "src/backend/demo/debug/"]
    : demoModes.has(mode)
      ? []
      : ["src/backend/demo/"]

// The module ids of a bundle that a build in this mode must not carry.
export const boundaryViolations = (mode: string, moduleIds: readonly string[]): string[] => {
  const folders = forbiddenFolders(mode)
  return moduleIds.filter((id) => {
    const path = id.split("\\").join("/")
    return folders.some((folder) => path.includes(`/${folder}`))
  })
}
