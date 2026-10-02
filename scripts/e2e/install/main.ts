// `pnpm test:e2e:install`: installs the harnesses `NOVADECK_E2E_AGENTS` names (all those
// pinned when it is unset) into the e2e cache, as the suite would in its `beforeAll`. Run
// before the suite when the suite itself has no network, as under `isolated`: its own
// install then finds them done. Needs `@novadeck/protocol` built.

type Installed = { readonly bin: string; readonly version: string }

type Installer = {
  readonly installHarness: (name: string) => Promise<Installed>
  readonly pins: Readonly<Record<string, unknown>>
}

// The suite's own installer, so the cache holds exactly what the suite looks for. Loaded
// by its address, so the scripts' typecheck stays out of the runner's sources.
const installer = new URL("../../../application/runner/src/e2e/install.ts", import.meta.url)

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

export const main = async (): Promise<void> => {
  const { installHarness, pins } = (await import(installer.href)) as Installer
  for (const name of harnesses(process.env.NOVADECK_E2E_AGENTS, Object.keys(pins))) {
    // eslint-disable-next-line no-await-in-loop -- One download at a time.
    const installed = await installHarness(name)
    console.log(`${name} ${installed.version}: ${installed.bin}`)
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
