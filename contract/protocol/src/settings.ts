import { z } from "zod"

import { openEnum } from "./open.js"

// How many of the Inbox's entries, and how long an entry's key (`<id>@<at>`), the person's order
// of them and their snoozes keep.
export const maxInboxOrder = 200
export const maxInboxEntryIdLength = 200
// How many resolved rows the Inbox lists, the latest, and how long one of them, as the runner
// keeps it for the app (`inboxHistory`), runs at most.
export const maxInboxResolved = 10
export const maxInboxHistoryLength = 65_536
// How many rows `inboxHistory` holds: the resolved ones and, beside them, the open ones the app
// had, for it to find what ended while it was closed.
export const maxInboxHistoryRows = maxInboxResolved + 50

// The longest an idle agent may wait before it is stopped, in minutes: a week.
export const maxHibernateMinutes = 7 * 24 * 60
// How long an idle agent waits before it is stopped, in minutes, until the person chooses.
export const defaultHibernateMinutes = 60

// How agents work with the other agents on this machine, which Novadeck's tool texts say:
// in Herd they work things out with each other when their work meets; in Solo they keep to
// their own work, tell the person what they notice, and act with other agents only when asked;
// in Swarm they organise themselves (open and close agents, form, join and leave teams, pass the
// lead) and Novadeck asks the person to confirm none of it but closing a terminal they opened.
// Teams (a lead and the agents it leads) work the same in Solo and Herd.
export const agentMode = z.enum(["herd", "solo", "swarm"])
export const defaultAgentMode = "herd"

// Runner-wide settings a client can change.
export const runnerSettings = z.strictObject({
  // Whether each terminal's screen is kept on disk, to show again when it restores.
  transcripts: z.boolean(),
  // Whether the person has seen the first-run choice of agents to connect.
  welcomed: z.boolean(),
  // The Inbox's entries that ask, each by its id and when it began (`<id>@<at>`), in the order
  // the person dragged them into; empty until they do.
  inboxOrder: z.array(z.string().min(1).max(maxInboxEntryIdLength)).max(maxInboxOrder),
  // The Inbox's entries the person snoozed, each by its id and when it began (`<id>@<at>`), the
  // latest last; empty until they snooze one.
  inboxSnoozed: z.array(z.string().min(1).max(maxInboxEntryIdLength)).max(maxInboxOrder),
  // The Inbox's entries the app derives itself, as JSON, trimmed, the latest last: those it made
  // resolved (a dialog answered, a held message released, a usage limit over), at most ten, and
  // the open ones it had, which the runner can't tell the end of; kept so they come back after a
  // restart. Empty until there are any.
  inboxHistory: z.array(z.string().min(1).max(maxInboxHistoryLength)).max(maxInboxHistoryRows),
  // After how many idle minutes a terminal's agent is stopped, its session resting until a
  // message or a look wakes it; null for never.
  hibernateAfterMinutes: z.number().int().min(1).max(maxHibernateMinutes).nullable(),
  // Whether agents may open git worktrees through Novadeck's tools, which tracks and cleans
  // them up; an Experimental feature, off until the person turns it on.
  worktrees: z.boolean(),
  // Whether Solo and Swarm may be picked, an Experimental feature, off until the person turns
  // it on: while off, agents work as a Herd whatever `agentMode` holds.
  agentModes: z.boolean(),
  // How agents work with each other (see `agentMode`), the pick that counts while `agentModes`
  // is on; Herd until the person picks another.
  agentMode,
  // Whether the shipping gate is on, an Experimental feature, off until the person turns it
  // on: Claude Code's and Codex's shell commands that ship work (push to another branch, land,
  // open or merge a PR) then need a permit, and while it is off nothing changes.
  shippingGate: z.boolean(),
  // Whether Novadeck's own pi (Novadeck Agent) may be fetched and started, an Experimental
  // feature, off until the person turns it on: on, the runner downloads its pinned pi at once;
  // off, it fetches and starts none, and keeps a copy it has. From revision 16: a runner before
  // it drops the key, and a UI offers the switch only where the runner's settings report it.
  bundledPi: z.boolean().optional(),
  // Whether Murmur may run, an Experimental feature, off until the person turns it on (on for
  // whoever turned Murmur on before it was one): off, the runner names no terminal with it,
  // installs and updates nothing, and keeps what is installed. From revision 20: a runner before
  // it drops the key, and a UI hides Murmur only where the runner's settings report the switch.
  murmur: z.boolean().optional(),
})

// Where the fetch of Novadeck's own pi stands: `off` while its switch is off, `downloading`
// with the bytes so far of `size`, `ready` once it is in place, `failed` with why (turning the
// switch on again tries again). A state a UI doesn't know reads as `off`.
export const bundledPiFetch = z.strictObject({
  state: openEnum(["off", "downloading", "ready", "failed"], {
    since: 16,
    unknown: { fallback: "off" },
  }),
  received: z.number().int().nonnegative().optional(),
  size: z.number().int().positive().optional(),
  error: z.string().max(500).optional(),
})

// The settings as the runner reports them, with what it can do whatever they say.
export const runnerSettingsState = runnerSettings.extend({
  // Whether transcripts can be kept here at all: they are kept only encrypted, so not where
  // nothing protects their key, as a Linux desktop with no keyring or a runner on its own.
  transcriptsAvailable: z.boolean(),
  // Where the fetch of Novadeck's own pi stands; absent from a runner before 16.
  bundledPiFetch: bundledPiFetch.optional(),
})

export type AgentMode = z.infer<typeof agentMode>
export type RunnerSettings = z.infer<typeof runnerSettings>
export type RunnerSettingsState = z.infer<typeof runnerSettingsState>
export type BundledPiFetch = z.infer<typeof bundledPiFetch>
