import type { AgentName } from "@novadeck/core/harnesses"
import type { Tour, TourRun } from "@novadeck/core/port"

// What starting the tour does to the workspace, as the app's commands do it.
export type TourEffects = {
  readonly tour: Tour
  // Opens the tour's folder as its own project, in place of those the backend removed.
  readonly openTour: (run: TourRun) => void
  // Adds a terminal to the project on screen, starting `command` there; answers its id.
  readonly add: (options: { readonly command: string }) => string
}

// The tour started: its lead's terminal, and the run it started from. Where the launch line
// carried no first line (`doorbell`), the tour's driver rings it once the agent shows.
export type TourStarted = { readonly terminalId: string; readonly run: TourRun }

/**
 * Starts the tour with `agent`: the backend readies its folder and launch line, and the tour
 * opens as a project of its own with one terminal starting the agent. Rejects where the backend
 * refuses, before anything in the workspace changes.
 */
export const startTour = async (agent: AgentName, effects: TourEffects): Promise<TourStarted> => {
  const run = await effects.tour.prepare(agent)
  effects.openTour(run)
  // No title of the person's: the agent names its terminal as it describes itself, which the
  // tour's driver waits on, and a person's title would outrank.
  const terminalId = effects.add({ command: run.command })
  return { terminalId, run }
}
