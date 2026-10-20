import type { TerminalKey } from "@novadeck/core/port"
import { isAgentProgram } from "@novadeck/core/process"
import type { Workspace } from "@novadeck/core/types"
import { sourcePaths, sourceThird, type DemoSource } from "@novadeck/demo/source"

import type { DemoActionGroup } from "./types"

// Source exists for the storefront project only.
const project = "storefront"
const fallback = "crow"

// The handle of the selected terminal's agent, as the Source panel names it; Crow's where
// the selected terminal isn't an agent of the storefront project.
const handleOf = (key: TerminalKey | undefined, workspace: Workspace | undefined): string => {
  const terminal =
    key?.projectId === project
      ? workspace?.projects
          .find((each) => each.id === key.projectId)
          ?.history.find((each) => each.id === key.workspaceSessionId)
          ?.state.roster.terminals.find((each) => each.id === key.terminalId)
      : undefined
  return terminal?.handle && terminal.state === "running" && isAgentProgram(terminal.process)
    ? terminal.handle
    : fallback
}

// The panel's group for the Source panel's states, which need the demo's source: the
// storefront project's tree, where the agents change files by themselves too.
export const sourceGroups = (source: DemoSource | undefined): readonly DemoActionGroup[] =>
  source
    ? [
        {
          section: "Agents",
          title: "Source",
          actions: [
            {
              label: "Agent writes a file",
              hint: "Open Source: the selected storefront agent's row pulses and its cursor moves to the file, back on one after it stopped (Crow if the selection isn't a storefront agent); an agent that isn't working loses the cursor again at the workspace's next change",
              run: ({ selected, workspace }) => source.write(handleOf(selected(), workspace())),
            },
            {
              label: "Agent stops writing (Source only)",
              hint: "Open Source: the selected storefront agent's cursor goes, its changes stay; only the Source cursor changes, the agent's turn is not (use Agent states to end or rest it; Crow if none)",
              run: ({ selected, workspace }) => source.endTurn(handleOf(selected(), workspace())),
            },
            {
              label: "Third agent edits Checkout.tsx",
              hint: `Open Source: src/checkout/Checkout.tsx shows moth, crow and ${sourceThird} (storefront's third terminal, Claude Code in the agents demos), the chips folding into +1; the row pulses once and ${sourceThird} leaves no cursor`,
              // One write and done: the simulation never runs this agent, so nothing else
              // would take its cursor away.
              run: () => {
                source.write(sourceThird, sourcePaths.checkout)
                source.endTurn(sourceThird)
              },
            },
            {
              label: "Agent creates a file in a folder",
              hint: "Open Source with src/api folded: the folder pulses and shows Crow's chip, and payments.ts is added inside",
              run: () => source.write(fallback, sourcePaths.payments),
            },
          ],
        },
      ]
    : []
