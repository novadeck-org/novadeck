import type { ForgeConnection, ForgeName } from "@novadeck/core/forges"
import type { AgentConnection, AgentMode, Backend } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import { newer, type RunnerSettingsState } from "@novadeck/protocol"
import type { Runner } from "@novadeck/runner-client"

import type { RunnerBackendOptions } from "./backend"

// Harnesses and forges a newer Novadeck's runner integrates that this build doesn't know
// aren't switched from here: they're left out of its lists, their settings kept on the runner.
const knownAgents = <T extends { readonly agent: string }>(
  list: readonly T[],
): (T & { readonly agent: AgentConnection["agent"] })[] =>
  list.filter(
    (each): each is T & { readonly agent: AgentConnection["agent"] } => each.agent !== newer,
  )
const knownForges = <T extends { readonly forge: string }>(
  list: readonly T[],
): (T & { readonly forge: ForgeName })[] =>
  list.filter((each): each is T & { readonly forge: ForgeName } => each.forge !== newer)

// The switches in Preferences the runner keeps: whether it keeps transcripts, how long it lets
// idle agents run, how agents work with each other, whether agents get worktrees, which agents it connects, and whether the person has seen the first-run choice. Each shows a change at once;
// one the runner doesn't take goes back to what it still does.

type RunnerSwitchCalls = {
  readonly agents: Pick<Runner["agents"], "set" | "list">
  readonly settings: Pick<Runner["settings"], "set">
  // Not every runner has forges (see `RunnerApi`).
  readonly forges?: Pick<Runner["forges"], "set" | "list"> | undefined
}

export const runnerSwitches = (
  runner: RunnerSwitchCalls,
  // What the runner said at startup. Transcripts, or agents, it said nothing of aren't offered.
  {
    transcripts: kept,
    transcriptsAvailable,
    agents: integrations,
    forges: forgeStates,
    welcomed,
    hibernateAfterMinutes,
    agentModes: modesOffered,
    agentMode: howAgentsWork,
    shippingGate: gated,
    worktrees: allowed,
  }: Pick<
    RunnerBackendOptions,
    | "transcripts"
    | "transcriptsAvailable"
    | "agents"
    | "forges"
    | "welcomed"
    | "hibernateAfterMinutes"
    | "agentModes"
    | "agentMode"
    | "shippingGate"
    | "worktrees"
  >,
  track: <T>(work: Promise<T>) => Promise<T>,
): Pick<
  Backend,
  | "transcripts"
  | "hibernation"
  | "agentModes"
  | "agentMode"
  | "shippingGate"
  | "worktrees"
  | "agents"
  | "forges"
> & {
  /**
   * Shows the settings as another client changed them (`settings.watch`), each switch the
   * runner said something of at startup; a change of this client's own under way shows its
   * own until the runner's answer, as before.
   */
  readonly take: (settings: RunnerSettingsState) => void
} => {
  const transcripts = createStore(kept ?? true)
  const hibernateAfter = createStore(hibernateAfterMinutes ?? null)
  const agentModes = createStore(modesOffered ?? false)
  const agentMode = createStore<AgentMode>(howAgentsWork ?? "herd")
  const shippingGate = createStore(gated ?? false)
  const worktrees = createStore(allowed ?? false)
  const agents = createStore<readonly AgentConnection[]>(
    knownAgents(integrations ?? []).map((agent) => ({ ...agent, busy: false })),
  )
  const forges = createStore<readonly ForgeConnection[]>(
    knownForges(forgeStates ?? []).map((forge) => ({ ...forge, busy: false })),
  )
  const welcome = createStore(welcomed === false)
  const updateForge = (forge: ForgeName, next: (current: ForgeConnection) => ForgeConnection) =>
    forges.update((list) => list.map((item) => (item.forge === forge ? next(item) : item)))
  // How many switches each forge has had, so a list asked before one never undoes it.
  const forgeSwitched = new Map<ForgeName, number>()
  const switchForge = (forge: ForgeName, enabled: boolean): void => {
    const calls = runner.forges
    if (!calls) return
    forgeSwitched.set(forge, (forgeSwitched.get(forge) ?? 0) + 1)
    updateForge(forge, (current) => ({
      ...current,
      busy: true,
      error: undefined,
    }))
    void track(calls.set(forge, enabled)).then(
      (result) => updateForge(forge, () => ({ ...result, forge, busy: false })),
      (error: unknown) =>
        updateForge(forge, (current) => ({
          ...current,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        })),
    )
  }
  const refreshForges = (options?: { readonly fresh?: boolean }): Promise<void> => {
    const calls = runner.forges
    if (!calls) return Promise.resolve()
    const asked = new Map(forgeSwitched)
    return track(calls.list(options?.fresh ? { fresh: true } : undefined)).then(
      (list) => {
        forges.update((current) =>
          knownForges(list).map((found) => {
            const shown = current.find((item) => item.forge === found.forge)
            // A change under way, or one made since the list was asked, reports its own result.
            const since = forgeSwitched.get(found.forge) !== asked.get(found.forge)
            return shown && (shown.busy || since) ? shown : { ...found, busy: false }
          }),
        )
      },
      () => {},
    )
  }
  // Replaces one agent's entry, keeping the others.
  const updateAgent = (
    agent: AgentConnection["agent"],
    next: (current: AgentConnection) => AgentConnection,
  ) => agents.update((list) => list.map((item) => (item.agent === agent ? next(item) : item)))
  const connectAgent = (agent: AgentConnection["agent"], connected: boolean): void => {
    updateAgent(agent, ({ available, connected: was }) => ({
      agent,
      available,
      connected: was,
      busy: true,
    }))
    void track(runner.agents.set(agent, connected)).then(
      (result) => updateAgent(agent, () => ({ ...result, agent, busy: false })),
      (error: unknown) =>
        updateAgent(agent, ({ available, connected: was }) => ({
          agent,
          available,
          connected: was,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        })),
    )
  }
  const refreshAgents = (options?: { readonly fresh?: boolean }): Promise<void> =>
    track(runner.agents.list(options?.fresh ? { fresh: true } : undefined)).then(
      (list) => {
        agents.update((current) =>
          knownAgents(list).map((found) => {
            const shown = current.find((item) => item.agent === found.agent)
            // A change under way reports its own result.
            return shown?.busy ? shown : { ...found, busy: false }
          }),
        )
      },
      () => {},
    )
  // Switches changed here whose answer hasn't come: what another client says of them waits.
  const pending = new Set<string>()
  const pendingWhile = <T>(name: string, work: Promise<T>): Promise<T> => {
    pending.add(name)
    return work.finally(() => pending.delete(name))
  }
  const takes = <T>(
    name: string,
    offered: unknown,
    store: { update: (next: () => T) => void },
    value: T,
  ) => {
    if (offered !== undefined && !pending.has(name)) store.update(() => value)
  }
  const take = (settings: RunnerSettingsState): void => {
    takes("transcripts", kept, transcripts, settings.transcripts)
    takes(
      "hibernateAfterMinutes",
      hibernateAfterMinutes,
      hibernateAfter,
      settings.hibernateAfterMinutes,
    )
    takes("agentModes", modesOffered, agentModes, settings.agentModes)
    takes("agentMode", howAgentsWork, agentMode, settings.agentMode)
    takes("shippingGate", gated, shippingGate, settings.shippingGate)
    takes("worktrees", allowed, worktrees, settings.worktrees)
    // Welcomed on another device: the first-run choice is made.
    if (welcomed !== undefined && settings.welcomed) welcome.update(() => false)
  }
  return {
    take,
    ...(kept !== undefined
      ? {
          transcripts: {
            enabled: transcripts,
            available: transcriptsAvailable ?? true,
            set: (enabled) => {
              const before = transcripts.getSnapshot()
              transcripts.update(() => enabled)
              // Unsaved, the switch shows what the runner still does.
              void track(
                pendingWhile("transcripts", runner.settings.set({ transcripts: enabled })),
              ).catch(() => transcripts.update(() => before))
            },
          },
        }
      : {}),
    ...(hibernateAfterMinutes !== undefined
      ? {
          hibernation: {
            after: hibernateAfter,
            set: (minutes) => {
              const before = hibernateAfter.getSnapshot()
              hibernateAfter.update(() => minutes)
              // Unsaved, the choice shows what the runner still does.
              void track(
                pendingWhile(
                  "hibernateAfterMinutes",
                  runner.settings.set({ hibernateAfterMinutes: minutes }),
                ),
              ).catch(() => hibernateAfter.update(() => before))
            },
          },
        }
      : {}),
    ...(modesOffered !== undefined
      ? {
          agentModes: {
            enabled: agentModes,
            set: (enabled) => {
              const before = agentModes.getSnapshot()
              agentModes.update(() => enabled)
              // Unsaved, the switch shows what the runner still does.
              void track(
                pendingWhile("agentModes", runner.settings.set({ agentModes: enabled })),
              ).catch(() => agentModes.update(() => before))
            },
          },
        }
      : {}),
    ...(gated !== undefined
      ? {
          shippingGate: {
            enabled: shippingGate,
            set: (enabled) => {
              const before = shippingGate.getSnapshot()
              shippingGate.update(() => enabled)
              // Unsaved, the switch shows what the runner still does.
              void track(
                pendingWhile("shippingGate", runner.settings.set({ shippingGate: enabled })),
              ).catch(() => shippingGate.update(() => before))
            },
          },
        }
      : {}),
    ...(howAgentsWork !== undefined
      ? {
          agentMode: {
            mode: agentMode,
            set: (mode) => {
              const before = agentMode.getSnapshot()
              agentMode.update(() => mode)
              // Unsaved, the choice shows what the runner still does.
              void track(pendingWhile("agentMode", runner.settings.set({ agentMode: mode }))).catch(
                () => agentMode.update(() => before),
              )
            },
          },
        }
      : {}),
    ...(allowed !== undefined
      ? {
          worktrees: {
            enabled: worktrees,
            set: (enabled) => {
              const before = worktrees.getSnapshot()
              worktrees.update(() => enabled)
              // Unsaved, the switch shows what the runner still does.
              void track(
                pendingWhile("worktrees", runner.settings.set({ worktrees: enabled })),
              ).catch(() => worktrees.update(() => before))
            },
          },
        }
      : {}),
    ...(forgeStates !== undefined && runner.forges
      ? { forges: { state: forges, set: switchForge, refresh: refreshForges } }
      : {}),
    ...(integrations !== undefined
      ? {
          agents: {
            state: agents,
            set: connectAgent,
            refresh: refreshAgents,
            welcome,
            finishWelcome: () => {
              welcome.update(() => false)
              void track(runner.settings.set({ welcomed: true })).catch(() => {})
            },
          },
        }
      : {}),
  }
}
