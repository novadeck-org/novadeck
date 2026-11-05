import { readdirSync } from "node:fs"
import { join } from "node:path"

import { agentNames, type AgentName } from "@novadeck/protocol/harnesses"

import { chatItemsOf, renderChat } from "./pipeline"
import { describe, expect, it } from "./test"
import { turn } from "./vocabulary/agy"
import { calls as claudeCalls, said as claudeSaid } from "./vocabulary/claude"
import { calls as codexCalls, said as codexSaid } from "./vocabulary/codex"

// A conversation its agent still works on, as the chat draws it: the latest run's
// unanswered call runs, and a long run that is the latest starts open, while an earlier
// one stays folded. Every other golden is of a finished conversation.

type Conversation = { readonly name: string; readonly records: readonly object[] }

const conversations: Readonly<Record<AgentName, readonly Conversation[]>> = {
  claude: [
    {
      name: "long-run",
      records: [
        claudeSaid("Check it all."),
        ...claudeCalls("done", [
          ["Bash", { command: "ls" }, "a\nb"],
          ["Read", { file_path: "/home/user/project/a.ts" }, "a"],
          ["Read", { file_path: "/home/user/project/b.ts" }, "b"],
          ["Grep", { pattern: "TODO" }, "a.ts:1"],
        ]),
        claudeSaid("And the tests."),
        ...claudeCalls("live", [
          ["Bash", { command: "npm run build" }, "built"],
          ["Read", { file_path: "/home/user/project/c.ts" }, "c"],
          ["Grep", { pattern: "FIXME" }, "none"],
          ["Bash", { command: "npm test" }],
        ]),
      ],
    },
    {
      name: "short-run",
      records: [
        claudeSaid("Run it."),
        ...claudeCalls("short", [
          ["Read", { file_path: "/home/user/project/a.ts" }, "a"],
          ["Bash", { command: "npm test" }],
        ]),
      ],
    },
  ],
  codex: [
    {
      name: "long-run",
      records: [
        codexSaid("Check it all."),
        ...codexCalls("done", [
          ["exec_command", { cmd: "ls" }, "a\nb"],
          ["exec_command", { cmd: "cat a.ts" }, "a"],
          ["exec_command", { cmd: "cat b.ts" }, "b"],
          ["exec_command", { cmd: "rg TODO" }, "a.ts:1"],
        ]),
        codexSaid("And the tests."),
        ...codexCalls("live", [
          ["exec_command", { cmd: "npm run build" }, "built"],
          ["exec_command", { cmd: "cat c.ts" }, "c"],
          ["exec_command", { cmd: "rg FIXME" }, "none"],
          ["exec_command", { cmd: "npm test" }],
        ]),
      ],
    },
    {
      name: "short-run",
      records: [
        codexSaid("Run it."),
        ...codexCalls("short", [
          ["exec_command", { cmd: "cat a.ts" }, "a"],
          ["exec_command", { cmd: "npm test" }],
        ]),
      ],
    },
  ],
  agy: [
    {
      name: "long-run",
      records: [
        ...turn(
          "Check it all.",
          "Looking.",
          [
            ["run_command", { CommandLine: "ls" }, "a\nb"],
            ["view_file", { AbsolutePath: "/home/user/project/a.ts" }, "a"],
            ["view_file", { AbsolutePath: "/home/user/project/b.ts" }, "b"],
            ["grep_search", { Query: "TODO" }, "a.ts:1"],
          ],
          0,
        ),
        ...turn(
          "And the tests.",
          "Testing.",
          [
            ["run_command", { CommandLine: "npm run build" }, "built"],
            ["view_file", { AbsolutePath: "/home/user/project/c.ts" }, "c"],
            ["grep_search", { Query: "FIXME" }, "none"],
            ["run_command", { CommandLine: "npm test" }],
          ],
          6,
        ),
      ],
    },
    {
      name: "short-run",
      records: turn(
        "Run it.",
        "Running.",
        [
          ["view_file", { AbsolutePath: "/home/user/project/a.ts" }, "a"],
          ["run_command", { CommandLine: "npm test" }],
        ],
        0,
      ),
    },
  ],
}

const live = (harness: AgentName, { records }: Conversation) =>
  renderChat(
    chatItemsOf(
      harness,
      records.map((record) => JSON.stringify(record)),
    ),
    harness,
    [],
    { working: true },
  ).lines

describe("a conversation its agent still works on", () => {
  for (const harness of agentNames)
    it(`renders ${harness}'s as its golden`, async () => {
      const golden = conversations[harness]
        .map((conversation) => `# ${conversation.name}\n${live(harness, conversation).join("\n")}`)
        .join("\n\n")
      await expect(`${golden}\n`).toMatchFileSnapshot(`./live/${harness}.txt`)
    })

  it("runs the latest run's unanswered call, and opens that run if it folds", () => {
    for (const harness of agentNames) {
      const [long, short] = conversations[harness].map((conversation) =>
        live(harness, conversation),
      )
      const runs = long!.filter((line) => line.startsWith("tools: "))
      expect(runs, harness).toHaveLength(2)
      expect(runs[0], harness).toMatch(/^tools: \[4 tool calls/)
      expect(runs[0], harness).not.toMatch(/running/)
      expect(runs[1], harness).toMatch(/^tools: \[open: 4 tool calls/)
      expect(runs[1], harness).toMatch(/→ running$/)
      expect(short!.at(-1), harness).toMatch(/→ running$/)
    }
  })

  it("keeps a golden for each harness, and no other", () => {
    const kept = readdirSync(join(import.meta.dirname, "live")).toSorted()
    expect(kept).toEqual(agentNames.map((harness) => `${harness}.txt`).toSorted())
  })
})
