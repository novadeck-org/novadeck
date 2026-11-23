import type { ConnectFailure } from "@novadeck/core/port"

import { bootFailures, failureKey } from "./boot-failures"
import type { DemoLaunch, DemoShell } from "./debug-demo"
import { sampleFix } from "./desktop/sandbox"
import { pageUpdateChannel } from "./desktop/updates"
import { iconGuidesGroup } from "./icon-guides"
import { paneTurnsGroup } from "./pane-turns"
import type { DemoActionGroup, DemoStates } from "./types"

// How each boot failure reads in the panel: a label, and what happens after it.
const failureCopy: Record<ConnectFailure["kind"], { label: string; hint: string }> = {
  transient: { label: "Transient", hint: "splash retries and connects" },
  unauthorized: { label: "Unauthorized", hint: "Retry connects" },
  unknown: { label: "Unknown error", hint: "Retry connects" },
  incompatible: { label: "Older runner", hint: "Quit only; says to update the runner" },
  outdated: {
    label: "Newer workspace",
    hint: "Quit only; names the newer Novadeck",
  },
}

// An app older than its runner reads two ways: a page reloads, the desktop app quits; and a
// device refused as signed out reads apart from one never let in.
const copyOf = (failure: ConnectFailure): { label: string; hint: string } =>
  failure.revoked
    ? { label: "Device signed out", hint: "Retry asks again; says the owner can let it in" }
    : failure.update !== "app"
      ? failureCopy[failure.kind]
      : failure.reload
        ? { label: "Older page", hint: "Reload only; loads the runner's newer page" }
        : { label: "Older app", hint: "Quit only; says to update this app" }

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
        {
          label: "App error",
          hint: "A view throws: the crash screen, with Reload",
          run: (context) => context.crash(),
        },
        {
          label: "Views fail to load",
          hint: "Each Markdown, plan, data, folder, 3D model and PDF pane, open or opened next, says Couldn't load this view, with Retry, which loads it",
          run: (context) => context.failViewLoads(),
        },
      ],
    },
    {
      section: "App",
      title: "Boot failures",
      actions: bootFailures.map((failure) => {
        const { label, hint } = copyOf(failure)
        return {
          label,
          hint: `${failure.code} \u00b7 ${hint}`,
          reboots: true,
          run: () => rehearsals.rehearse({ fail: failureKey(failure) }),
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
    {
      section: "App",
      title: "Screen reader",
      actions: [
        {
          label: "Desktop, reader running",
          hint: "Preferences > Appearance offers Automatic; on it, the terminal in focus keeps a reader's text",
          reboots: true,
          run: () => launch.setScreenReader(true),
        },
        {
          label: "Desktop, no reader",
          hint: "Preferences > Appearance offers Automatic; on it, terminals keep no reader's text",
          reboots: true,
          run: () => launch.setScreenReader(false),
        },
        {
          label: "As in a browser",
          hint: "Nothing tells: Preferences offers On and Off alone, and shows On for Automatic",
          reboots: true,
          run: () => launch.setScreenReader(undefined),
        },
      ],
    },
    {
      section: "App",
      title: "Window controls",
      actions: [
        {
          label: "macOS, in the header",
          hint: "The window's close, minimise and zoom buttons sit at the header's start, where the mark gives way to them; in Zen they hide, and come back while the pointer is in the top-left corner",
          reboots: true,
          run: () => launch.setWindowControls("inset"),
        },
        {
          label: "macOS, full screen",
          hint: "No buttons over the page, as macOS keeps them in the menu bar that slides down: the header starts at its edge",
          reboots: true,
          run: () => launch.setWindowControls("fullScreen"),
        },
        {
          label: "Windows, in the header",
          hint: "The window's caption buttons hold the header's end, as tall as it is, and the header keeps clear of them; in Zen they stay, on the Focus window's header or on a plate in the corner",
          reboots: true,
          run: () => launch.setWindowControls("caption"),
        },
        {
          label: "Own title bar",
          hint: "As on Linux and in a browser: nothing over the header",
          reboots: true,
          run: () => launch.setWindowControls(undefined),
        },
      ],
    },
    {
      section: "App",
      title: "Agent worktrees",
      actions: [
        {
          label: "On, with Worktrees",
          hint: "Boots on the experimental channel with agent worktrees on: the rail has the Worktrees toggle, and Preferences > Experimental shows the Agent worktrees row on. On the page's default stable channel the setting is off and the rail has no Worktrees toggle, as in a stable build",
          reboots: true,
          run: () => {
            pageUpdateChannel.channel = "experimental"
            launch.setWorktrees(true)
          },
        },
        {
          label: "Not offered",
          hint: "Preferences > Experimental shows the Agent worktrees row disabled, reading Not available here, as on a runner without the setting; the rail has no Worktrees toggle",
          reboots: true,
          run: () => launch.setWorktrees(false),
        },
        {
          label: "Offered",
          hint: "The Agent worktrees row switches again",
          reboots: true,
          run: () => launch.setWorktrees(true),
        },
      ],
    },
    iconGuidesGroup,
    paneTurnsGroup,
  ]
}
