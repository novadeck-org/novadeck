import type { ConnectFailure } from "@novadeck/core/port"

import { bootFailures } from "./boot-failures"
import type { DemoLaunch, DemoShell } from "./debug-demo"
import { sampleFix } from "./desktop/sandbox"
import { iconGuidesGroup } from "./icon-guides"
import type { DemoActionGroup, DemoStates } from "./types"

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
// its runner, its sandbox and the guides drawn over it.
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
          hint: "Terminals read Reconnecting…, then go on",
          run: () => shell.reconnect(5_000),
        },
        {
          label: "Toggle offline",
          hint: "Terminals read Runner offline until toggled back",
          run: shell.toggleOffline,
        },
        {
          label: "Crash loop",
          hint: "4 crashes: the dialog, then Restart terminals in the footer",
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
    iconGuidesGroup,
  ]
}
