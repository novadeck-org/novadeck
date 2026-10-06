import { demoVariants } from "../variants"
import { bootFailures } from "./boot-failures"
import type { DemoAction, DemoActionGroup, DemoStates } from "./types"
import type { DemoLaunch, DemoShell } from "./with-debug"

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const failureHints = {
  transient: "Boots again and fails the first attempt; the splash retries on its own and connects.",
  incompatible: "Boots again and fails with only Quit offered.",
  unauthorized: "Boots again and fails the first attempt; Retry connects.",
  unknown: "Boots again and fails the first attempt; Retry connects.",
} as const

// The panel's groups for the shell around the demo: which demo runs, how it starts, its
// connection, its crash loop and its sessions.
export const shellGroups = ({
  launch,
  shell,
  states,
}: {
  readonly launch: DemoLaunch
  readonly shell: DemoShell
  readonly states: DemoStates
}): readonly DemoActionGroup[] => {
  const { rehearsals } = launch
  const variants: readonly DemoAction[] = demoVariants
    .filter((variant) => variant !== "welcome")
    .map((variant) => ({
      label: `${variant}${variant === launch.variant ? " (current)" : ""}`,
      hint: "Boots again into this demo; a reload in this tab keeps it.",
      run: () => launch.switchVariant(variant),
    }))
  return [
    { title: "Demo", actions: variants },
    {
      title: "Startup",
      actions: [
        {
          label: "Splash hold",
          hint: "Boots again and holds the splash; press Esc to go on.",
          run: () => rehearsals.rehearse({ hold: true }),
        },
        {
          label: "Slow attach",
          hint: "Boots again; the splash counts terminals attaching over about 3 s.",
          run: launch.armSlowAttach,
        },
        ...bootFailures.map((failure) => ({
          label: `Boot failure: ${failure.kind} (${failure.code})`,
          hint: failureHints[failure.kind],
          run: () => rehearsals.rehearse({ fail: failure.code }),
        })),
        {
          label: "Welcome dialog",
          hint: "Opens the first-run dialog for connecting agents again.",
          run: states.openWelcome,
        },
      ],
    },
    {
      title: "Connection",
      actions: [
        {
          label: "Reconnecting 5 s",
          hint: "Footer Reconnecting…, terminals locked, then Reconnected.",
          run: () => shell.reconnect(5_000),
        },
        {
          label: "Offline (toggle)",
          hint: "Footer Unavailable until you toggle it back.",
          run: shell.toggleOffline,
        },
      ],
    },
    {
      title: "Crash loop",
      actions: [
        {
          label: "Trip the crash loop",
          hint: "Crashes 4: footer and dialog; the session's terminals fail. Retry restarts them.",
          run: shell.tripCrashLoop,
        },
      ],
    },
    {
      title: "Sessions",
      actions: [
        {
          label: "Running process + fresh session",
          hint: "Starts a process here, then a new session; the sessions panel counts 1 running.",
          run: async ({ selected, dispatch, note, startFresh }) => {
            const key = selected()
            if (!key || !dispatch) return note("Select a terminal first.")
            const target = { projectId: key.projectId, workspaceSessionId: key.workspaceSessionId }
            dispatch([
              {
                type: "terminal/status",
                target,
                terminalId: key.terminalId,
                status: { state: "running" },
              },
              { type: "terminal/process", target, terminalId: key.terminalId, process: "sleep" },
            ])
            await pause(1_000)
            startFresh()
          },
        },
      ],
    },
  ]
}
