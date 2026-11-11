import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"

// Linting probe files with the repository's real config, for the tests that prove a fence:
// the config as it is, with its plugins resolved from the repository, as the probes live
// elsewhere; and oxlint's diagnostics for a folder.

const root = join(import.meta.dirname, "..", "..")

/** The root's `.oxlintrc.json`, its `jsPlugins` made absolute, for a probe workspace. */
export const probeConfig = (): string => {
  const config = JSON.parse(readFileSync(join(root, ".oxlintrc.json"), "utf8")) as {
    readonly jsPlugins?: readonly string[]
  }
  return `${JSON.stringify(
    {
      ...config,
      ...(config.jsPlugins && {
        jsPlugins: config.jsPlugins.map((path) => (isAbsolute(path) ? path : join(root, path))),
      }),
    },
    null,
    2,
  )}\n`
}

/** One finding of oxlint's, as its JSON format has it. */
export type Diagnostic = {
  readonly code: string
  readonly message: string
  /** The file, relative to the folder linted, with `/` as separator. */
  readonly filename: string
  readonly labels?: readonly { readonly span: { readonly line: number } }[]
}

/** What oxlint finds in `folder` under the config there. */
export const lint = (folder: string): readonly Diagnostic[] => {
  const oxlint = join(root, "node_modules", "oxlint", "bin", "oxlint")
  // oxlint exits non-zero on the refusals it's here to find.
  const output = (() => {
    try {
      return execFileSync(process.execPath, [oxlint, "--format", "json", "."], {
        cwd: folder,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch (error) {
      // Only what it printed counts: one that couldn't run printed nothing.
      const { stdout } = error as { stdout?: string }
      if (!stdout) throw error
      return stdout
    }
  })()
  const { diagnostics } = JSON.parse(output) as { diagnostics: readonly Diagnostic[] }
  return diagnostics.map((each) => ({ ...each, filename: each.filename.replaceAll("\\", "/") }))
}
