import type { ConnectFailure } from "../../port"
import { bootFailures } from "./boot-failures"
import { sampleFix } from "./sandbox"
import type { DemoActionGroup, DemoStates } from "./types"
import type { DemoLaunch, DemoShell } from "./with-debug"

// How each boot failure reads in the panel: a label, and what happens after it.
const failureCopy: Record<ConnectFailure["kind"], { label: string; hint: string }> = {
  transient: { label: "Transient", hint: "splash retries and connects" },
  unauthorized: { label: "Unauthorized", hint: "Retry connects" },
  unknown: { label: "Unknown error", hint: "Retry connects" },
  incompatible: { label: "Incompatible runner", hint: "Quit only" },
  outdated: {
    label: "Newer workspace",
    hint: "Quit only; names the newer Novadeck",
  },
}

// The panel's groups for the shell around the demo: how it starts, how it fails to,
// its runner and its sandbox.
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
  return [
    {
      section: "App",
      title: "Startup",
      actions: [
        {
          label: "Hold the splash",
          hint: "Until you press Esc",
          reboots: true,
          run: () => rehearsals.rehearse({ hold: true }),
        },
        {
          label: "Slow attach",
          hint: "Terminals attach over ~3\u00a0s",
          reboots: true,
          run: launch.armSlowAttach,
        },
        {
          label: "Welcome dialog",
          hint: "First-run agent setup",
          run: states.openWelcome,
        },
      ],
    },
    {
      section: "App",
      title: "Boot failures",
      actions: bootFailures.map((failure) => {
        const { label, hint } = failureCopy[failure.kind]
        return {
          label,
          hint: `${failure.code} \u00b7 ${hint}`,
          reboots: true,
          run: () => rehearsals.rehearse({ fail: failure.code }),
        }
      }),
    },
    {
      section: "App",
      title: "Runner",
      actions: [
        {
          label: "Reconnect (5 s)",
          hint: "Terminals locked, then Reconnected",
          run: () => shell.reconnect(5_000),
        },
        {
          label: "Toggle offline",
          hint: "Footer reads Unavailable until toggled back",
          run: shell.toggleOffline,
        },
        {
          label: "Crash loop",
          hint: "4 crashes: footer and dialog; Retry restarts",
          run: shell.tripCrashLoop,
        },
      ],
    },
    {
      section: "App",
      title: "Sandbox",
      actions: [
        {
          label: "No sandbox",
          hint: "Footer chip; notice with the fix command",
          reboots: true,
          run: () => launch.setSandbox({ sandboxed: false, fix: sampleFix }),
        },
        {
          label: "No sandbox, no fix",
          hint: "Notice explains, no command",
          reboots: true,
          run: () => launch.setSandbox({ sandboxed: false, fix: "" }),
        },
        {
          label: "Sandboxed",
          hint: "No chip",
          reboots: true,
          run: () => launch.setSandbox({ sandboxed: true }),
        },
      ],
    },
  ]
}
