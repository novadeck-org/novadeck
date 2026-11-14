import { itemIdOf } from "@novadeck/core/items"
import type { Backend, BackendAction, BackendSink } from "@novadeck/core/port"
import { workspaceReducer } from "@novadeck/core/state"
import { workspaceFixture } from "@novadeck/core/testing"
import type { AgentShell, TerminalMetadata, Workspace } from "@novadeck/core/types"
import { describe, expect, it } from "vitest"

import { withShellItems } from "./shell-items"

const target = { projectId: "project", workspaceSessionId: "initial" }
const shell: AgentShell = { id: "1", command: "pnpm dev", since: 0, exit: null }

// The fixture's first terminal as a running Claude Code agent whose status lists `shells`.
const withShells = (
  workspace: Workspace,
  shells: readonly AgentShell[] | undefined,
): Workspace => ({
  ...workspace,
  projects: workspace.projects.map((project) => ({
    ...project,
    history: project.history.map((session) => ({
      ...session,
      state: {
        ...session.state,
        roster: {
          ...session.state.roster,
          terminals: session.state.roster.terminals.map((terminal, at): TerminalMetadata =>
            at === 0
              ? ({
                  ...terminal,
                  state: "running",
                  process: "claude",
                  handle: "moth",
                  agent: { working: false, ...(shells && { shells }) },
                } as unknown as TerminalMetadata)
              : terminal,
          ),
        },
      },
    })),
  })),
})

// What the shells item does as the workspace changes, one commit at a time.
const follow = () => {
  const dispatched: BackendAction[][] = []
  const backend = withShellItems({ commit: () => {}, start: () => () => {} } as unknown as Backend)
  backend.start!({
    dispatch: (actions: BackendAction[]) => dispatched.push(actions),
  } as unknown as BackendSink)
  let workspace = workspaceFixture()
  return {
    commit: async (shells: readonly AgentShell[] | undefined) => {
      workspace = withShells(workspace, shells)
      backend.commit(workspace, [])
      await Promise.resolve()
      const last = dispatched.at(-1) ?? []
      // The workspace takes what the item did, as the app's would.
      for (const action of last) workspace = workspaceReducer(workspace, action as never)
      return last
    },
  }
}

describe("the demo's shells item", () => {
  it("is made as an agent lists shells and removed when it lists none, as the runner does", async () => {
    const app = follow()
    const made = await app.commit([shell])
    expect(made).toMatchObject([{ type: "item/upsert", item: { kind: "shells", version: 1 } }])
    const gone = await app.commit(undefined)
    expect(gone).toEqual([{ type: "item/remove", target, itemId: itemIdOf("demo-shells-01") }])
  })

  it("stays for a status that lists an empty set, which the debug panel uses to show the empty pane", async () => {
    const app = follow()
    await app.commit([shell])
    const kept = await app.commit([])
    expect(kept).toMatchObject([{ type: "item/upsert", item: { kind: "shells", detail: "ended" } }])
  })
})
