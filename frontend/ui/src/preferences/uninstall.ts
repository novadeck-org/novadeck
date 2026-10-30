import type { OfferedUninstall, UninstallResult } from "@novadeck/core/desktop/uninstall"
import { harnesses, type AgentName } from "@novadeck/core/harnesses"
import type { Store } from "@novadeck/core/store"

import type { AgentSwitch } from "./AgentSwitches"

// What the uninstall row and its dialog say and do, as plain functions of the plan and of
// the dialog's state.

export const uninstallLabel = "Uninstall Novadeck"
export const uninstallDescription = "Removes the app from this computer."

// The dialog's state. `outcome` is set once the host answered with something that ends the
// page's part: the platform's uninstaller is taking over, or the app is gone.
export type UninstallDialog = {
  readonly keepData: boolean
  readonly busy: boolean
  readonly error: string | null
  // The agents this dialog's runs disconnected, which stay so if the removal then fails.
  readonly disconnected: readonly AgentName[]
  readonly outcome: Exclude<UninstallResult, { readonly kind: "failed" }> | null
}

// Opening it asks to keep the person's data: the safe answer.
export const askUninstall = (): UninstallDialog => ({
  keepData: true,
  busy: false,
  error: null,
  disconnected: [],
  outcome: null,
})

export const chooseKeepData = (dialog: UninstallDialog, keepData: boolean): UninstallDialog =>
  dialog.busy || dialog.outcome ? dialog : { ...dialog, keepData }

export const noteDisconnected = (dialog: UninstallDialog, agent: AgentName): UninstallDialog =>
  dialog.disconnected.includes(agent)
    ? dialog
    : { ...dialog, disconnected: [...dialog.disconnected, agent] }

// What a failed removal says of the agents it had already disconnected.
export const disconnectedNote = (disconnected: readonly AgentName[]): string | undefined =>
  disconnected.length === 0
    ? undefined
    : `${agentList(disconnected)} ${disconnected.length === 1 ? "was" : "were"} disconnected; connect ${disconnected.length === 1 ? "it" : "them"} again in Preferences if you keep Novadeck.`

// The agents the dialog names: those disconnected by an earlier try, and those still connected.
export const namedAgents = (
  dialog: UninstallDialog,
  connected: readonly AgentName[],
): readonly AgentName[] => [
  ...dialog.disconnected,
  ...connected.filter((agent) => !dialog.disconnected.includes(agent)),
]

export const startUninstall = (dialog: UninstallDialog): UninstallDialog => ({
  ...dialog,
  busy: true,
  error: null,
})

// A failure keeps the dialog open with its reason, for another try.
export const settleUninstall = (
  dialog: UninstallDialog,
  result: UninstallResult,
): UninstallDialog =>
  result.kind === "failed"
    ? { ...dialog, busy: false, error: result.reason }
    : { ...dialog, busy: false, outcome: result }

// Whether the person may still leave the dialog: not while it works, nor once the app is
// closing or gone.
export const dismissible = (dialog: UninstallDialog): boolean =>
  !dialog.busy && dialog.outcome === null

export const confirmLabel = (plan: Extract<OfferedUninstall, { kind: "ready" }>): string =>
  plan.handoff === "uninstaller" ? "Continue" : "Uninstall"

const agentNames = new Map<AgentName, string>(harnesses.map(({ id, name }) => [id, name]))
const nameOf = (agent: AgentName): string => agentNames.get(agent) ?? agent

// Agent names as a sentence part: "Claude Code", "Claude Code and Codex", "A, B and C".
export const agentList = (agents: readonly AgentName[]): string => {
  const names = agents.map(nameOf)
  const last = names.pop()
  return names.length === 0 ? (last ?? "") : `${names.join(", ")} and ${last}`
}

// What the dialog says is removed: the app, and the agents' plugin where connected.
export const removalText = (connected: readonly AgentName[]): string =>
  connected.length === 0
    ? "Novadeck is removed from this computer."
    : `Novadeck is removed from this computer and disconnected from ${agentList(connected)}.`

const idle = (list: readonly AgentSwitch[], agent: AgentName): AgentSwitch | undefined => {
  const item = list.find((each) => each.agent === agent)
  return item?.busy
    ? undefined
    : (item ?? { agent, available: false, connected: false, busy: false })
}

// Resolves with the agent's entry once no change to it is under way.
const settled = (state: Store<readonly AgentSwitch[]>, agent: AgentName) =>
  new Promise<AgentSwitch>((resolve) => {
    const check = (): boolean => {
      const item = idle(state.getSnapshot(), agent)
      if (item) resolve(item)
      return item !== undefined
    }
    if (check()) return
    const stop = state.subscribe(() => {
      if (check()) stop()
    })
  })

// Disconnects one agent and waits for it: undefined once it is disconnected, otherwise
// why it is not. The backend reports a change through its state, not a result.
export const disconnectAgent = async (
  agents: {
    readonly state: Store<readonly AgentSwitch[]>
    readonly set: (agent: AgentName, connected: boolean) => void
  },
  agent: AgentName,
): Promise<string | undefined> => {
  if (!(await settled(agents.state, agent)).connected) return undefined
  agents.set(agent, false)
  const after = await settled(agents.state, agent)
  if (!after.connected) return undefined
  return after.error ?? "It is still connected."
}

// Removes the app after disconnecting each agent in turn. The first agent that stays
// connected stops it before the app is touched, so nothing is half-removed.
export const runUninstall = async ({
  connected,
  disconnect,
  uninstall,
  keepData,
  onDisconnected,
}: {
  readonly connected: readonly AgentName[]
  readonly disconnect: (agent: AgentName) => Promise<string | undefined>
  readonly uninstall: (options: { readonly keepData: boolean }) => Promise<UninstallResult>
  readonly keepData: boolean
  // Told of each agent once it is disconnected.
  readonly onDisconnected?: (agent: AgentName) => void
}): Promise<UninstallResult> => {
  for (const agent of connected) {
    // One at a time, and none after a failure.
    // eslint-disable-next-line no-await-in-loop -- Each change must settle before the next.
    const reason = await disconnect(agent)
    if (reason !== undefined) {
      return { kind: "failed", reason: `Couldn't disconnect ${nameOf(agent)}: ${reason}` }
    }
    onDisconnected?.(agent)
  }
  return uninstall({ keepData })
}
