// `pnpm test:e2e:install`: installs the harnesses `NOVADECK_E2E_AGENTS` names (all those
// pinned when it is unset) into the e2e cache, as the suite would in its `beforeAll`. Run
// before the suite when the suite itself has no network, as under `isolated`: its own
// install then finds them done. Needs `@novadeck/protocol` built.

import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

type Installed = { readonly bin: string; readonly version: string }

type Installer = {
  readonly installHarness: (name: string) => Promise<Installed>
  readonly pins: Readonly<Record<string, unknown>>
}

// The suite's own installer, so the cache holds exactly what the suite looks for. Loaded
// by its address, so the scripts' typecheck stays out of the runner's sources.
const installer = new URL("../../../backend/runner/src/e2e/install.ts", import.meta.url)

/** The harnesses to install: those named, or every pinned one. */
export const harnesses = (
  agents: string | undefined,
  pinned: readonly string[],
): readonly string[] => {
  const names = (agents ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
  if (names.length === 0) return pinned
  const unknown = names.filter((name) => !pinned.includes(name))
  if (unknown.length > 0)
    throw new Error(
      `NOVADECK_E2E_AGENTS names no pinned harness ${unknown.join(", ")}: use ${pinned.join(", ")}`,
    )
  return names
}

// Fills the cache with Nova's pinned release, which the tour runs (from pi's GitHub
// release, not npm), through tsx: its module reads the runner's own sources.
const novaFill = new URL("../../../backend/runner/src/e2e/nova-fill.ts", import.meta.url)

export const main = async (): Promise<void> => {
  const { installHarness, pins } = (await import(installer.href)) as Installer
  const names = harnesses(process.env.NOVADECK_E2E_AGENTS, Object.keys(pins))
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop -- One download at a time.
    const installed = await installHarness(name)
    console.log(`${name} ${installed.version}: ${installed.bin}`)
  }
  if (names.includes("pi")) {
    const runner = createRequire(new URL("../../../backend/runner/package.json", import.meta.url))
    execFileSync(
      process.execPath,
      [runner.resolve("tsx/cli"), "--conditions=development", fileURLToPath(novaFill)],
      { stdio: "inherit" },
    )
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
