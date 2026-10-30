import type { AgentConnection, Backend } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import type { AgentIntegration } from "@novadeck/protocol"
import type { Runner } from "@novadeck/runner-client"

// The switches in Preferences the runner keeps: whether it keeps transcripts, which agents it
// connects, and whether the person has seen the first-run choice. Each shows a change at once;
// one the runner doesn't take goes back to what it still does.

export type RunnerSwitchCalls = {
  readonly agents: Pick<Runner["agents"], "set" | "list">
  readonly settings: Pick<Runner["settings"], "set">
}

// What the runner said at startup. Transcripts, or agents, it said nothing of aren't offered.
export type StartupSwitches = {
  readonly transcripts?: boolean | undefined
  readonly transcriptsAvailable?: boolean | undefined
  readonly agents?: readonly AgentIntegration[] | undefined
  readonly welcomed?: boolean | undefined
}

export const runnerSwitches = (
  runner: RunnerSwitchCalls,
  { transcripts: kept, transcriptsAvailable, agents: integrations, welcomed }: StartupSwitches,
  track: <T>(work: Promise<T>) => Promise<T>,
): Pick<Backend, "transcripts" | "agents"> => {
  const transcripts = createStore(kept ?? true)
  const agents = createStore<readonly AgentConnection[]>(
    (integrations ?? []).map((agent) => ({ ...agent, busy: false })),
  )
  const welcome = createStore(welcomed === false)
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
      (result) => updateAgent(agent, () => ({ ...result, busy: false })),
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
  const refreshAgents = (): void => {
    void track(runner.agents.list()).then(
      (list) =>
        agents.update((current) =>
          list.map((found) => {
            const shown = current.find((item) => item.agent === found.agent)
            // A change under way reports its own result.
            return shown?.busy ? shown : { ...found, busy: false }
          }),
        ),
      () => {},
    )
  }
  return {
    ...(kept !== undefined
      ? {
          transcripts: {
            enabled: transcripts,
            available: transcriptsAvailable ?? true,
            set: (enabled) => {
              const before = transcripts.getSnapshot()
              transcripts.update(() => enabled)
              // Unsaved, the switch shows what the runner still does.
              void track(runner.settings.set({ transcripts: enabled })).catch(() =>
                transcripts.update(() => before),
              )
            },
          },
        }
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
