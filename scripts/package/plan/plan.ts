// Whether a pull request's change can affect the packaged app, so the Release workflow's
// packaging jobs run for it. Pure: `main.ts` gathers the facts (the event, the folders of
// the packages the host is built from, git's changed files).

/** The facts a decision rests on; `undefined` where they couldn't be had. */
export type Facts = {
  /** The workflow's event (`pull_request`, `push`, …). */
  readonly event: string
  /** The folders of the host's package and every package it's built from, as turbo lists them. */
  readonly packaged: readonly string[] | undefined
  /** Paths git calls changed, relative to the repository's root, with `/` as separator. */
  readonly files: readonly string[] | undefined
}

// What lies outside every package yet decides what the packages build into, or how the
// packaging runs: the toolchain and dependency pins, the patches pnpm applies, the shared
// compiler settings, the workflows that package a pull request (Package, which Quality
// calls) and the installer the Linux package's smoke test runs.
const packagingFiles = new Set([
  ".github/workflows/package.yml",
  ".github/workflows/quality.yml",
  ".npmrc",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "turbo.json",
])
const packagingFolders = ["patches/", "scripts/install/", "scripts/package/"]

// Files in a package that no build reads: its tests, specs and end-to-end scenarios, and
// its prose.
const unbuilt = [/\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/, /(?:^|\/)src\/(?:specs|e2e)\//, /\.md$/]

/** Whether a changed file can change the packaged app. */
export const packages = (file: string, packaged: readonly string[]): boolean =>
  packagingFiles.has(file) ||
  packagingFolders.some((folder) => file.startsWith(folder)) ||
  (packaged.some((folder) => file.startsWith(`${folder}/`)) &&
    !unbuilt.some((pattern) => pattern.test(file)))

/**
 * Whether the packaging jobs run: always but for a pull request, and for one whenever the
 * facts are missing, which can't be told from a change that packages; otherwise only when a
 * changed file can change the packaged app.
 */
export const plan = (facts: Facts): boolean => {
  if (facts.event !== "pull_request") return true
  const { packaged, files } = facts
  if (!packaged || !files) return true
  return files.some((file) => packages(file, packaged))
}

/** The package folders of `turbo ls --output json`, or `undefined` if it isn't that. */
export const parseFolders = (output: string): readonly string[] | undefined => {
  try {
    const items = (JSON.parse(output) as { packages?: { items?: unknown } }).packages?.items
    if (!Array.isArray(items) || items.length === 0) return undefined
    const found = items.map((item: { path?: unknown }) => item?.path)
    return found.every((path) => typeof path === "string" && path !== "")
      ? (found as string[]).map((path) => path.replaceAll("\\", "/").replace(/\/$/, ""))
      : undefined
  } catch {
    return undefined
  }
}
