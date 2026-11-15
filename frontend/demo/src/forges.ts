import type { ForgeConnection, ForgeHost, ForgeName, Forges } from "@novadeck/core/forges"
import { forgeNames, forgePrograms } from "@novadeck/core/forges"
import { createStore } from "@novadeck/core/store"

// The demo's forges: GitHub, GitLab and Azure DevOps as a person might have them, simulated.
// Nothing here reads a command-line tool; the debug panel moves the state between the ones a
// runner finds (see `DemoForgesControl`), and an installer or a sign-in run in a demo terminal
// plays out (see `played`), then changes the state as the real one would.

// What a forge's tool is installed with, where the demo knows (the runner knows none for gh on
// Linux, which shows as "Not installed. Needs gh").
export const demoForgeInstallers: Partial<Record<ForgeName, string>> = {
  gitlab: "brew install glab",
  azure: "brew install azure-cli",
}

const hostOf: Readonly<Record<ForgeName, string>> = {
  github: "github.com",
  gitlab: "gitlab.com",
  azure: "dev.azure.com",
}

// The command that signs a tool in on its host, as a host reports it (`fix`).
export const demoSignIn: Readonly<Record<ForgeName, string>> = {
  github: "gh auth login --hostname github.com",
  gitlab: "glab auth login --hostname gitlab.com",
  azure: "az login --allow-no-subscriptions",
}

// What mends a token a host refused.
export const demoRefresh: Readonly<Record<ForgeName, string>> = {
  github: "gh auth refresh --hostname github.com",
  gitlab: "glab auth login --hostname gitlab.com",
  azure: "az login --allow-no-subscriptions --tenant 3f1c9a52-7d4e-4b8a-9c61-2e5d8f0a7b13",
}

const host = (forge: ForgeName, state: ForgeHost["state"]): ForgeHost => ({
  host: hostOf[forge],
  state,
  ...(state === "signed-out" && { fix: demoSignIn[forge] }),
  ...(state === "refused" && { fix: demoRefresh[forge] }),
})

// The states the debug panel moves the demo's forges between.
export type ForgesScenario =
  | "start"
  | "signed-in"
  | "signed-out"
  | "missing"
  | "refused"
  | "refused-unmendable"
  | "several-hosts"
  | "on-but-missing"
  | "busy"
  | "error"

const connection = (
  forge: ForgeName,
  parts: Partial<ForgeConnection> & Pick<ForgeConnection, "available" | "enabled">,
): ForgeConnection => ({
  forge,
  busy: false,
  hosts: [],
  ...(demoForgeInstallers[forge] !== undefined &&
    !parts.available && { installer: demoForgeInstallers[forge] }),
  ...parts,
})

// A scenario's forges, as a runner would list them.
export const scenarioOf = (scenario: ForgesScenario): readonly ForgeConnection[] =>
  forgeNames.map((forge): ForgeConnection => {
    const on = (state: ForgeHost["state"]) =>
      connection(forge, { available: true, enabled: true, hosts: [host(forge, state)] })
    switch (scenario) {
      case "start":
        // GitHub signed in, GitLab installed but signed out, Azure DevOps not installed.
        return forge === "github"
          ? on("signed-in")
          : forge === "gitlab"
            ? on("signed-out")
            : connection(forge, { available: false, enabled: false })
      case "signed-in":
        return on("signed-in")
      case "signed-out":
        return on("signed-out")
      case "refused":
        return on("refused")
      case "refused-unmendable":
        // GitLab and Azure DevOps name no command that mends a refused token.
        return forge === "github"
          ? on("refused")
          : connection(forge, {
              available: true,
              enabled: true,
              hosts: [{ host: host(forge, "refused").host, state: "refused" }],
            })
      case "several-hosts":
        // github.com and an Enterprise host, one signed in and one not.
        return forge === "github"
          ? connection(forge, {
              available: true,
              enabled: true,
              hosts: [
                host(forge, "signed-in"),
                {
                  host: "github.example.com",
                  state: "signed-out",
                  fix: "gh auth login --hostname github.example.com",
                },
              ],
            })
          : connection(forge, { available: true, enabled: false })
      case "on-but-missing":
        // Switched on, then its tool was uninstalled: it can't be looked at until it is back.
        return connection(forge, { available: false, enabled: true })
      case "missing":
        return connection(forge, { available: false, enabled: false })
      case "busy":
        return forge === "github"
          ? { ...on("signed-in"), busy: true }
          : connection(forge, { available: true, enabled: false })
      case "error":
        return forge === "github"
          ? {
              ...connection(forge, { available: true, enabled: false }),
              error: `${forgePrograms[forge]} could not read its token. Run ${demoSignIn[forge]}, then try again.`,
            }
          : connection(forge, { available: true, enabled: false })
    }
  })

// A forge command played in a demo terminal: how it ends.
export type ForgePlay = {
  readonly end: (outcome: "done" | "failed") => void
  readonly kind: "install" | "sign-in"
  readonly forge: ForgeName
}

export type DemoForgesControl = {
  // The forges move to a scenario.
  readonly scenario: (scenario: ForgesScenario) => void
  // The run a command in a demo terminal is, where it is a forge's installer or sign-in.
  readonly played: (command: string | undefined) => ForgePlay | undefined
}

export type DemoForges = Forges & DemoForgesControl

export const isDemoForges = (forges: Forges | undefined): forges is DemoForges =>
  forges !== undefined && "played" in forges && "scenario" in forges

// What a played command prints in its terminal as it ends.
export const forgeReply = (play: ForgePlay, outcome: "done" | "failed"): string =>
  outcome === "failed"
    ? play.kind === "install"
      ? "Error: could not resolve host: formulae.brew.sh"
      : `error: authentication failed for ${hostOf[play.forge]}`
    : play.kind === "install"
      ? `==> Installed ${forgePrograms[play.forge]}\nRun it once to sign in.`
      : `Logged in to ${hostOf[play.forge]}.`

export const createDemoForges = (): DemoForges => {
  const state = createStore<readonly ForgeConnection[]>(scenarioOf("start"))
  const change = (forge: ForgeName, step: (each: ForgeConnection) => ForgeConnection): void => {
    state.update((list) => list.map((each) => (each.forge === forge ? step(each) : each)))
  }
  const played = (command: string | undefined): ForgePlay | undefined => {
    if (command === undefined) return undefined
    for (const forge of forgeNames) {
      if (demoForgeInstallers[forge] === command)
        return {
          kind: "install",
          forge,
          end: (outcome) => {
            if (outcome === "done")
              change(forge, ({ installer: _gone, ...each }) => ({
                ...each,
                available: true,
                hosts: [host(forge, "signed-out")],
              }))
          },
        }
      if (demoSignIn[forge] === command || demoRefresh[forge] === command)
        return {
          kind: "sign-in",
          forge,
          end: (outcome) => {
            if (outcome === "done")
              change(forge, (each) => ({ ...each, hosts: [host(forge, "signed-in")] }))
          },
        }
    }
    return undefined
  }
  return {
    state,
    // A switch is instant in the demo; a runner's takes a moment, which the "busy" scenario shows.
    set: (forge, enabled) =>
      change(forge, (each) => ({
        ...each,
        enabled,
        error: undefined,
        hosts:
          enabled && each.available
            ? each.hosts.length
              ? each.hosts
              : [host(forge, "signed-out")]
            : each.hosts,
      })),
    refresh: () => Promise.resolve(),
    scenario: (scenario) => state.update(() => scenarioOf(scenario)),
    played,
  }
}
