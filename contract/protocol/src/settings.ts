import { z } from "zod"

// Runner-wide settings a client can change.
export const runnerSettings = z.strictObject({
  // Whether each terminal's screen is kept on disk, to show again when it restores.
  transcripts: z.boolean(),
  // Whether the person has seen the first-run choice of agents to connect.
  welcomed: z.boolean(),
})

// The settings as the runner reports them, with what it can do whatever they say.
export const runnerSettingsState = runnerSettings.extend({
  // Whether transcripts can be kept here at all: they are kept only encrypted, so not where
  // nothing protects their key, as a Linux desktop with no keyring or a runner on its own.
  transcriptsAvailable: z.boolean(),
})

export type RunnerSettings = z.infer<typeof runnerSettings>
export type RunnerSettingsState = z.infer<typeof runnerSettingsState>
