import type { DemoInstalls } from "@novadeck/demo/agents/installs"

import type { DemoActionGroup, DemoStates } from "./types"

// Installing an agent from the welcome dialog: its Install button, the installer running in
// a terminal of its own, and one that fails.
export const installGroups = (
  installs: DemoInstalls,
  states: Pick<DemoStates, "openWelcomeBare">,
): readonly DemoActionGroup[] => [
  {
    section: "App",
    title: "Agent installs",
    actions: [
      {
        label: "Nothing installed",
        hint: "Welcome dialog, Claude Code, Codex and Antigravity each with Install and its command",
        run: () => {
          installs.reset()
          states.openWelcomeBare()
        },
      },
      {
        label: "Hold next install",
        hint: "The next Install's terminal keeps running, as an install under way does",
        run: installs.holdNext,
      },
      {
        label: "Finish held install",
        hint: "Its terminal ends, the agent connects and starts in a terminal of its own",
        run: installs.release,
      },
      {
        label: "Fail next install",
        hint: "The next Install ends in an error in its terminal; the agent stays not installed",
        run: installs.failNext,
      },
    ],
  },
]
