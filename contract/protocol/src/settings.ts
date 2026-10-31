import { z } from "zod"

// How many of the Inbox's rows, and how long a row's key (`<id>@<at>`), the person's order
// of them and their snoozes keep.
export const maxInboxOrder = 200
export const maxInboxRowIdLength = 200

// Runner-wide settings a client can change.
export const runnerSettings = z.strictObject({
  // Whether each terminal's screen is kept on disk, to show again when it restores.
  transcripts: z.boolean(),
  // Whether the person has seen the first-run choice of agents to connect.
  welcomed: z.boolean(),
  // The Inbox's rows that ask, each by its id and when it began (`<id>@<at>`), in the order
  // the person dragged them into; empty until they do.
  inboxOrder: z.array(z.string().min(1).max(maxInboxRowIdLength)).max(maxInboxOrder),
  // The Inbox's rows the person snoozed, each by its id and when it began (`<id>@<at>`), the
  // latest last; empty until they snooze one.
  inboxSnoozed: z.array(z.string().min(1).max(maxInboxRowIdLength)).max(maxInboxOrder),
})

// The settings as the runner reports them, with what it can do whatever they say.
export const runnerSettingsState = runnerSettings.extend({
  // Whether transcripts can be kept here at all: they are kept only encrypted, so not where
  // nothing protects their key, as a Linux desktop with no keyring or a runner on its own.
  transcriptsAvailable: z.boolean(),
})

export type RunnerSettings = z.infer<typeof runnerSettings>
export type RunnerSettingsState = z.infer<typeof runnerSettingsState>
