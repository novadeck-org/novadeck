import type { TerminalKey } from "@novadeck/core/port"
import { isAgentProgram } from "@novadeck/core/terminals/process"
import type { Workspace } from "@novadeck/core/types"
import { demoPaths, filesThird, type DemoFiles } from "@novadeck/demo/files"
import { terminalOf } from "@novadeck/demo/workspace"

import type { DemoActionGroup } from "./types"

// Files exist for the storefront project only.
const project = "storefront"
const fallback = "crow"

// The handle of the selected terminal's agent, as the Files panel names it; Crow's where
// the selected terminal isn't an agent of the storefront project.
const handleOf = (key: TerminalKey | undefined, workspace: Workspace | undefined): string => {
  const terminal = key?.projectId === project ? terminalOf(workspace, key) : undefined
  return terminal?.handle && terminal.state === "running" && isAgentProgram(terminal.process)
    ? terminal.handle
    : fallback
}

// The panel's group for the Files panel's states, which need the demo's files: the
// storefront project's tree, where the agents change files by themselves too.
export const filesGroups = (files: DemoFiles | undefined): readonly DemoActionGroup[] =>
  files
    ? [
        {
          section: "Agents",
          title: "Files",
          actions: [
            {
              label: "Agent writes a file",
              hint: "Open Files: the selected storefront agent's row pulses and its cursor moves to the file, back on one after it stopped (Crow if the selection isn't a storefront agent); an agent that isn't working loses the cursor again at the workspace's next change",
              run: ({ selected, workspace }) => files.write(handleOf(selected(), workspace())),
            },
            {
              label: "Agent writes Checkout.tsx",
              hint: "Open Files and double-click src/checkout/Checkout.tsx (agents demo): the file preview's change of the selected storefront agent (Crow's if none) grows by a line, pulsing cyan, with its cursor at the end of it, and the Files row pulses the same; an agent that isn't working loses the cursor again at the workspace's next change",
              run: ({ selected, workspace }) =>
                files.write(handleOf(selected(), workspace()), demoPaths.checkout),
            },
            {
              label: "Agent stops writing (Files only)",
              hint: "Open Files: the selected storefront agent's cursor goes, its changes stay; only the Files cursor changes, the agent's turn is not (use the Agent group to end or rest it; Crow if none)",
              run: ({ selected, workspace }) => files.endTurn(handleOf(selected(), workspace())),
            },
            {
              label: "Third agent edits Checkout.tsx",
              hint: `Open Files: src/checkout/Checkout.tsx shows moth, crow and ${filesThird} (storefront's third terminal, Claude Code in the agents demos), the chips folding into +1; the row pulses once and ${filesThird} leaves no cursor`,
              // One write and done: the simulation never runs this agent, so nothing else
              // would take its cursor away.
              run: () => {
                files.write(filesThird, demoPaths.checkout)
                files.endTurn(filesThird)
              },
            },
            {
              label: "A folder can't be read",
              hint: "Open Files, then show the panel again (switch panels and back) or end an agent's turn: src/cart, once open, shows a muted \"Can't read this folder\" row",
              run: () => files.degrade("src/cart", "fail"),
            },
            {
              label: "A folder lists only part",
              hint: 'Open Files, then show the panel again or end an agent\'s turn: src/components, once open, lists two files and a muted "More not shown" row',
              run: () => files.degrade("src/components", "truncate"),
            },
            {
              label: "The project's files can't be read",
              hint: "Open Files, then show the panel again or end an agent's turn: the tree gives way to a line saying the files can't be read",
              run: () => files.degrade("", "fail"),
            },
            {
              label: "The project's folder is empty",
              hint: "Open Files, then show the panel again or end an agent's turn: the tree gives way to \"This project's folder is empty.\"",
              run: () => files.degrade("", "empty"),
            },
            {
              label: "The project lists only part",
              hint: 'Open Files, then show the panel again or end an agent\'s turn: the root lists two entries and ends with a muted "More not shown" row',
              run: () => files.degrade("", "truncate"),
            },
            {
              label: "Files read normally again",
              hint: "Open Files, then show the panel again or end an agent's turn: every folder lists in full again",
              run: () =>
                (["", "src/cart", "src/components"] as const).forEach((folder) =>
                  files.degrade(folder, undefined),
                ),
            },
            {
              label: "Checkout is behind main",
              hint: 'Open Files: under the header a line says "main is 3 behind origin" with Update; Update moves the checkout (the line goes, Receipt.tsx appears in src/checkout and Price.tsx leaves src/components)',
              run: () => files.stand({ count: 3 }),
            },
            {
              label: "Checkout can't update",
              hint: 'Open Files: the same line; Update gives way to "Can\'t update: Your local changes to src/cart/useCart.ts would be overwritten." with Retry',
              run: () =>
                files.stand({
                  count: 3,
                  refusal: "Your local changes to src/cart/useCart.ts would be overwritten.",
                }),
            },
            {
              label: "Checkout is up to date",
              hint: "Open Files: the behind line goes within a few seconds (the panel asks again every 20 s while shown, or when it is shown again)",
              run: () => files.stand(undefined),
            },
            {
              label: "Main moves the checkout",
              hint: "Open Files with src/checkout and src/components open: within a few seconds src/checkout/Receipt.tsx is added and src/components/Price.tsx removed, as when a fetch fast-forwarded the checkout",
              run: () => files.move(),
            },
            {
              label: "Agent creates a file in a folder",
              hint: "Open Files with src/api folded: the folder pulses and shows Crow's chip, and payments.ts is added inside",
              run: () => files.write(fallback, demoPaths.payments),
            },
          ],
        },
      ]
    : []
