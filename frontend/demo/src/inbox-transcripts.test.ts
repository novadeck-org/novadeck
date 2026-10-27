import { agentContext, answersOf } from "@novadeck/core/agent-steps"
import type { InboxRow } from "@novadeck/core/inbox"
import { companionKeyId } from "@novadeck/core/items"

import { demoInboxIds } from "./inbox-fixtures"
import { plainDemo } from "./index"
import { describe, expect, it } from "./test"

// What an Inbox item's sheet reads of its agent in the Inbox demo, as `useAgentContext`
// does: its conversation and the messages delivered to it.
const contextOf = (item: InboxRow) => {
  const backend = plainDemo("inbox")
  const store = backend.conversations!.conversation(item.source)
  const stop = store.subscribe(() => {})
  const conversation = store.getSnapshot()
  stop()
  const threads = backend.messages!.state.getSnapshot().terminals[companionKeyId(item.source)]
  return agentContext(conversation.agent, conversation.items, answersOf(threads))
}

const items = (): readonly InboxRow[] => plainDemo("inbox").inbox!.state.getSnapshot().items
const item = (id: string): InboxRow => items().find((each) => each.id === id)!

describe("the Inbox demo's agents' context", () => {
  it("gives an agent the person's words and its steps since, a failure among them", () => {
    expect(contextOf(item(demoInboxIds.login))).toMatchObject({
      said: {
        text: "deploy a preview of the docs site, then port the API reference to MDX",
      },
      steps: [
        { kind: "run", tool: "Bash", arg: "pnpm build:docs", result: "✓ built 412 pages in 38s" },
        {
          kind: "fail",
          tool: "Bash",
          arg: "vercel deploy --prebuilt",
          result: "Error: No existing credentials found. Please run `vercel login`.",
        },
        { kind: "edit", tool: "Edit", result: "+4 −2" },
      ],
    })
  })

  it("quotes nothing for an agent its lead briefed, as the brief isn't the person's", () => {
    expect(contextOf(item(demoInboxIds.limit))).toMatchObject({
      said: null,
      steps: [
        { kind: "run", tool: "Bash", result: "40 runs" },
        { kind: "edit", tool: "Write", result: "+40" },
      ],
    })
  })

  it("reads Antigravity's edits and failed runs in its own words", () => {
    expect(contextOf(item(demoInboxIds.stuck)).steps).toEqual([
      {
        kind: "fail",
        tool: "run_command",
        arg: "pnpm test invoices",
        result: "Tests  1 failed (1)",
      },
      { kind: "edit", tool: "edit_file", arg: "…/src/invoices/totals.ts", result: "+1 −1" },
      {
        kind: "fail",
        tool: "run_command",
        arg: "pnpm test invoices",
        result: "Tests  1 failed (1)",
      },
    ])
  })

  it("gives every item on a terminal whose agent the person spoke to the words they gave", () => {
    const backend = plainDemo("inbox")
    const conversing = items().filter((each) => {
      const store = backend.conversations!.conversation(each.source)
      const stop = store.subscribe(() => {})
      const { agent } = store.getSnapshot()
      stop()
      return agent !== null && each.id !== demoInboxIds.limit
    })
    expect(conversing.length).toBeGreaterThan(3)
    for (const each of conversing) expect(contextOf(each).said, each.id).not.toBeNull()
  })
})
