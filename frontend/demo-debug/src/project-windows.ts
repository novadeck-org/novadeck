import type { Workspace } from "@novadeck/core/types"

import type { DemoLaunch } from "./debug-demo"
import type { DemoProjectWindows } from "./desktop/project-windows"
import type { DemoActionGroup } from "./types"

// The projects other than the one on screen, by id.
const others = (workspace: Workspace | undefined): string[] =>
  workspace?.projects
    .filter((project) => project.id !== workspace.activeProjectId)
    .map((project) => project.id) ?? []

// The panel's group for project windows: the desktop app can open a project in a window of its
// own. What the other windows show, the voice they take and the places they send this window
// are pretended; the page's side of them is the real one.
export const projectWindowGroups = (
  launch: DemoLaunch,
  windows: DemoProjectWindows,
  workspace: () => Workspace | undefined,
): readonly DemoActionGroup[] => [
  {
    section: "App",
    title: "Project windows",
    actions: [
      {
        label: "Offered",
        hint: "Boots with the app able to open windows: a project's menu in the switcher and the pins bar has Open in new window, and the window's title names the project",
        reboots: true,
        run: () => launch.setProjectWindows(true),
      },
      {
        label: "Not offered",
        hint: "Boots without windows, as in a browser: a project's menu has no Open in new window",
        reboots: true,
        run: () => launch.setProjectWindows(false),
      },
      {
        label: "A second window, not the first",
        hint: "Boots as a window the person opened for a project: no welcome dialog, no Agent Chat offer, no voice or Murmur offer, no what's-new card",
        reboots: true,
        run: () => launch.setExtraWindow(!launch.extraWindow),
      },
      {
        label: "Another window shows the next project",
        hint: "The first project that isn't on screen shows Shown in another window in the switcher and the pins bar; picking it shows it here all the same",
        run: (context) => {
          const [next] = others(workspace())
          if (next === undefined) return context.note("There is no other project.")
          windows.pretend([next])
        },
      },
      {
        label: "Other windows show every other project",
        hint: "Every project but the one on screen is marked Shown in another window",
        run: () => windows.pretend(others(workspace())),
      },
      {
        label: "No other window",
        hint: "The marks go",
        run: () => windows.pretend([]),
      },
      {
        label: "Another window sends this one to the next project",
        hint: "This window goes to the project, as after a hand-off, and nothing else changes",
        run: (context) => {
          const [next] = others(workspace())
          if (next === undefined) return context.note("There is no other project.")
          windows.send({ projectId: next })
        },
      },
      {
        label: "Another window has the voice",
        hint: "This window rings no ding while the person is elsewhere: toasts still show, the Inbox counts on its icon in the other window",
        run: () => windows.setVoice(false),
      },
      {
        label: "This window has the voice",
        hint: "Back to ringing here",
        run: () => windows.setVoice(true),
      },
    ],
  },
]
