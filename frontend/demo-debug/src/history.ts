import type { Backend } from "@novadeck/core/port"
import { isDemoHistory } from "@novadeck/demo/history"

import type { DemoActionGroup } from "./types"

// The panel's group for History's states the demo can't reach by itself: its agents are all
// restorable, so closing one never asks for that reason.
export const historyGroups = (history: Backend["history"]): readonly DemoActionGroup[] =>
  isDemoHistory(history)
    ? [
        {
          section: "Agents",
          title: "History",
          actions: [
            {
              label: "Selected agent can't be restored",
              hint: "Close the selected agent terminal: the close question says it can't be restored from History, whether it is working or not",
              run: ({ selected }) => {
                const key = selected()
                if (key) history.setRestorable(key.terminalId, false)
              },
            },
            {
              label: "Selected agent can be restored",
              hint: "Close the selected agent terminal: it asks only while it is working, and an idle one closes at once",
              run: ({ selected }) => {
                const key = selected()
                if (key) history.setRestorable(key.terminalId, true)
              },
            },
          ],
        },
      ]
    : []
