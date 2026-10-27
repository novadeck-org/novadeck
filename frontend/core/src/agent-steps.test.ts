import {
  agentContext,
  answersOf,
  askToFixNudge,
  editCounts,
  failureOf,
  lineCounts,
  type AgentStep,
} from "./agent-steps"
import { recorded } from "./agent-steps-recorded"
import type { ChatItem } from "./conversation"
import type { AgentMessage, TerminalThreads } from "./messages"
import { context, describe, expect, it } from "./test"

let count = 0
const item = (fields: Partial<ChatItem>): ChatItem => ({
  id: `i${++count}`,
  at: null,
  role: "assistant",
  kind: "text",
  text: "",
  truncated: false,
  tool: null,
  call: null,
  author: null,
  run: null,
  interrupted: false,
  ...fields,
})
const user = (text: string, at: number | null = null) => item({ role: "user", text, at })
const ran = (command: string, output: string, at: number | null = null): ChatItem[] => {
  const call = `c${++count}`
  return [
    item({
      kind: "tool-call",
      tool: "Bash",
      call,
      at,
      text: JSON.stringify({ command }),
      run: { kind: "run", title: "Ran", detail: command },
    }),
    item({ role: "tool", kind: "tool-result", call, at, text: output }),
  ]
}
const called = (
  tool: string,
  input: unknown,
  detail: string,
  output: string,
  at: number | null = null,
): ChatItem[] => {
  const call = `c${++count}`
  return [
    item({
      kind: "tool-call",
      tool,
      call,
      at,
      text: JSON.stringify(input),
      run: { kind: "run", title: "Ran", detail },
    }),
    item({ role: "tool", kind: "tool-result", call, at, text: output }),
  ]
}
const read = (path: string): ChatItem[] => {
  const call = `c${++count}`
  return [
    item({
      kind: "tool-call",
      tool: "Read",
      call,
      text: JSON.stringify({ file_path: path }),
      run: { kind: "read", title: "Read", detail: path },
    }),
    item({ role: "tool", kind: "tool-result", call, text: "1\tconst a = 1" }),
  ]
}

const steps = (agent: string, items: readonly ChatItem[]): readonly AgentStep[] =>
  agentContext(agent, items).steps

describe("an agent's context from recorded transcripts", () => {
  context("of Claude Code", () => {
    const { items } = recorded.claude
    const said = items[0]!.text

    it("gives the person's prompt as their words", () => {
      expect(agentContext("claude", items).said).toEqual({ text: said, at: items[0]!.at })
    })

    it("counts each edit's lines from its input, and a file written whole as added", () => {
      expect(steps("claude", items.slice(0, 9))).toEqual([
        { kind: "edit", tool: "Edit", arg: "…/user/project/a.txt", result: "+1 −1" },
        { kind: "edit", tool: "Edit", arg: "…/user/project/a.txt", result: "+1 −1" },
        { kind: "edit", tool: "Write", arg: "…/user/project/b.txt", result: "+3" },
      ])
    })

    it("keeps the last three of what edited, ran or failed, with a failure's own line", () => {
      expect(steps("claude", items)).toEqual([
        {
          kind: "fail",
          tool: "Bash",
          arg: "ls no-such-file",
          result: "ls: cannot access 'no-such-file': No such file or directory",
        },
        { kind: "run", tool: "Bash", arg: "wc -l a.txt b.txt", result: "7 total" },
        {
          kind: "fail",
          tool: "Edit",
          arg: "…/user/project/a.txt",
          result: "String to replace not found in file.",
        },
      ])
    })
  })

  context("of Codex in code mode", () => {
    const { items } = recorded.codex

    it("reads a script's patches as edits, and its commands as runs", () => {
      expect(steps("codex", items.slice(0, 6))).toEqual([
        { kind: "edit", tool: "exec", arg: "a.txt", result: "+2 −2" },
        { kind: "edit", tool: "exec", arg: "b.txt", result: "+3" },
      ])
    })

    it("tells a command's exit code and a failed script, by what each printed", () => {
      expect(steps("codex", items)).toEqual([
        {
          kind: "fail",
          tool: "exec",
          arg: "ls no-such-file",
          result: "ls: cannot access 'no-such-file': No such file or directory",
        },
        { kind: "run", tool: "exec", arg: "wc -l a.txt b.txt", result: "7 total" },
        {
          kind: "fail",
          tool: "exec",
          arg: "a.txt",
          result:
            "apply_patch verification failed: Failed to find expected lines in /home/user/pr…",
        },
      ])
    })
  })

  context("of Codex's own shell and patch tools", () => {
    it("runs and patches, leaving out calls the person declined or stopped", () => {
      expect(steps("codex", recorded.codexDefault.items)).toEqual([
        { kind: "run", tool: "exec_command", arg: "echo approved > probe-out.txt", result: null },
        {
          kind: "edit",
          tool: "exec_command",
          arg: "…/sandbox/project/patched.txt",
          result: "+1",
        },
      ])
    })
  })

  context("of Antigravity", () => {
    const { items } = recorded.agy

    it("counts edit_file and write_file lines, and gives a failed step's error", () => {
      expect(steps("agy", items.slice(0, 11))).toEqual([
        { kind: "edit", tool: "edit_file", arg: "…/user/project/a.txt", result: "+1 −1" },
        { kind: "edit", tool: "write_file", arg: "…/user/project/b.txt", result: "+3" },
        {
          kind: "fail",
          tool: "edit_file",
          arg: "…/user/project/a.txt",
          result:
            "target content not found in the file; the Target must exactly match existing fi…",
        },
      ])
    })

    it("reads a command that exited cleanly as a run that printed nothing", () => {
      expect(steps("agy", items).at(-1)).toEqual({
        kind: "run",
        tool: "run_command",
        arg: "touch yes.txt",
        result: null,
      })
    })
  })
})

describe("the words an agent was given", () => {
  it("are the person's last, without Novadeck's doorbell line", () => {
    const items = [
      user("fix the flaky inbox test and push it", 1),
      user("[Novadeck: automatic notice, agent messages waiting, k3f9Xz]", 2),
    ]
    expect(agentContext("claude", items).said).toEqual({
      text: "fix the flaky inbox test and push it",
      at: 1,
    })
  })

  it("leave out Claude Code's slash commands and what they printed", () => {
    const items = [
      user("fix the flaky login test in the auth package", 1),
      ...ran("pnpm test", "ok", 2),
      user(
        "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>",
        3,
      ),
      user(
        "<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>",
        4,
      ),
      user("<local-command-stdout>Set effort level to medium</local-command-stdout>", 5),
      user(
        "Caveat: The messages below were generated by the user while running local commands. DO NOT respond",
        6,
      ),
      ...ran("pnpm lint", "clean", 7),
    ]
    const found = agentContext("claude", items)
    expect(found.said?.text).toBe("fix the flaky login test in the auth package")
    expect(found.steps.map((step) => step.arg)).toEqual(["pnpm test", "pnpm lint"])
  })

  it("leave out what Novadeck sent for the person: Ask it to fix, and a given notice", () => {
    const items = [
      user("migrate the invoices table to the new schema", 1),
      user(askToFixNudge, 2),
      user("You've hit the same failure 3 times. Stop and try a different approach.", 3),
    ]
    expect(agentContext("claude", items).said?.text).toBe(
      "You've hit the same failure 3 times. Stop and try a different approach.",
    )
    expect(
      agentContext(
        "claude",
        items,
        [],
        ["You've hit the same failure 3 times. Stop and try a different approach."],
      ).said?.text,
    ).toBe("migrate the invoices table to the new schema")
  })

  it("skip filler for the words before it, but keep filler that's all there is", () => {
    expect(
      agentContext("claude", [user("move the recap to :17 and :47", 1), user("ok go", 2)]).said
        ?.text,
    ).toBe("move the recap to :17 and :47")
    expect(agentContext("claude", [user("continue", 1)]).said?.text).toBe("continue")
  })

  it("leave out a stop, a shell-mode command and a hook's continuation", () => {
    const items = [
      user("draft the 0.9 release notes", 1),
      item({ role: "user", text: "[Request interrupted by user]", interrupted: true, at: 2 }),
      user("!git status", 3),
      user('<hook_prompt hook_run_id="stop">go on</hook_prompt>', 4),
    ]
    expect(agentContext("codex", items).said?.text).toBe("draft the 0.9 release notes")
  })

  it("are the person's Inbox answer when it came later, and the steps are those after it", () => {
    const items = [
      user("set up the inbox sheet task", 1),
      ...ran("pnpm install", "Done", 2),
      user("[Novadeck: automatic notice, agent messages waiting, ABC123]", 5),
      ...ran("pnpm test", "Tests 48 passed", 6),
    ]
    const found = agentContext("claude", items, [{ text: "use UTC, then report", at: 5 }])
    expect(found.said).toEqual({ text: "use UTC, then report", at: 5 })
    expect(found.steps).toEqual([
      { kind: "run", tool: "Bash", arg: "pnpm test", result: "Tests 48 passed" },
    ])
  })

  it("are none with nothing said, and the steps are the last of all", () => {
    expect(agentContext("claude", [...ran("pnpm build", "built in 2s")])).toEqual({
      said: null,
      steps: [{ kind: "run", tool: "Bash", arg: "pnpm build", result: "built in 2s" }],
    })
  })
})

describe("an agent's steps", () => {
  it("leave out reads, and a call still waiting on its result, as the one the person is asked about", () => {
    const pending = item({
      kind: "tool-call",
      tool: "Bash",
      call: "waiting",
      text: JSON.stringify({ command: "wrangler deploy" }),
      run: { kind: "run", title: "Ran", detail: "wrangler deploy" },
    })
    expect(steps("claude", [user("deploy it now"), ...read("src/a.ts"), pending])).toEqual([])
  })

  it("leave out a call the person turned down", () => {
    expect(
      steps("claude", [
        ...ran(
          "rm -rf dist",
          "The user doesn't want to proceed with this tool use. The tool use was rejected",
        ),
      ]),
    ).toEqual([])
  })

  it("count a Codex command polled to its end as that command, not as its polls", () => {
    const poll = (output: string) => called("write_stdin", { session_id: 7, chars: "" }, "", output)
    const items = [
      user("build the release binary and report its size"),
      ...called(
        "exec_command",
        { cmd: "cargo build --release" },
        "cargo build --release",
        "Chunk ID: 1\nWall time: 10.0 seconds\nProcess running with session ID 7\nOutput:\n   Compiling foo",
      ),
      ...poll(
        "Chunk ID: 2\nWall time: 30 seconds\nProcess running with session ID 7\nOutput:\n   Compiling bar",
      ),
      ...poll(
        "Chunk ID: 3\nWall time: 3 seconds\nProcess exited with code 101\nOutput:\nerror: could not compile `baz`",
      ),
    ]
    expect(steps("codex", items)).toEqual([
      {
        kind: "fail",
        tool: "exec_command",
        arg: "cargo build --release",
        result: "error: could not compile `baz`",
      },
    ])
    // Still running: the command itself, as it was called.
    expect(steps("codex", items.slice(0, 4))).toEqual([
      { kind: "run", tool: "exec_command", arg: "cargo build --release", result: "Compiling foo" },
    ])
  })

  it("count input typed into a Codex command as a run of its own", () => {
    expect(
      steps("codex", [
        ...called(
          "write_stdin",
          { session_id: 7, chars: "y\n" },
          "y",
          "Process running with session ID 7\nOutput:\nok",
        ),
      ]),
    ).toEqual([{ kind: "run", tool: "write_stdin", arg: "y", result: "ok" }])
  })

  it("read only the end of a long transcript for its steps", () => {
    // Every edit's input is a diff of 400 lines each; a return to building a step for each
    // of 3,000 of them takes seconds rather than milliseconds.
    const before = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")
    const after = Array.from({ length: 400 }, (_, i) => `line ${i % 7 === 0 ? "x" : ""}${i}`).join(
      "\n",
    )
    const items: ChatItem[] = [user("refactor everything in the repo please", 1)]
    for (let i = 0; i < 3000; i += 1)
      items.push(
        ...called(
          "Edit",
          { file_path: `/f${i}.ts`, old_string: before, new_string: after },
          `f${i}.ts`,
          "ok",
          2 + i,
        ),
      )
    const started = performance.now()
    const found = agentContext("claude", items)
    expect(performance.now() - started).toBeLessThan(250)
    expect(found.steps.map((step) => step.arg)).toEqual(["f2997.ts", "f2998.ts", "f2999.ts"])
  })

  it("keep three at most, oldest first", () => {
    const items = [
      user("run them all please"),
      ...["a", "b", "c", "d"].flatMap((each) => ran(each, each)),
    ]
    expect(steps("claude", items).map((step) => step.arg)).toEqual(["b", "c", "d"])
  })
})

describe("a failure, in each harness's words", () => {
  it("is Claude Code's exit code, with the last line printed", () => {
    expect(failureOf("claude", "Bash", "Exit code 1\nFAIL src/a.test.ts\n1 failed")).toBe(
      "1 failed",
    )
    expect(failureOf("claude", "Bash", "Exit code 144")).toBe("exit code 144")
    expect(failureOf("claude", "Bash", "Exit code 0\nfine")).toBeUndefined()
  })

  it("is Codex's exit code, from its exec_command and shell headers or a shell-mode run", () => {
    expect(
      failureOf(
        "codex",
        "exec_command",
        "Chunk ID: a1\nWall time: 0.2 seconds\nProcess exited with code 2\nOriginal token count: 9\nOutput:\nls: cannot access 'x'\n",
      ),
    ).toBe("ls: cannot access 'x'")
    expect(failureOf("codex", "shell", "Exit code: 1\nWall time: 0 seconds\nOutput:\n")).toBe(
      "exit code 1",
    )
    expect(
      failureOf(
        "codex",
        "exec_command",
        "Wall time: 0.1 seconds\nOutput:\nExit code: 2\nWall time: 0 seconds\nOutput:\nerror: no such file\n",
      ),
    ).toBe("error: no such file")
    expect(failureOf("codex", "Bash", "before\n[exit code 3]")).toBe("before")
  })

  it("is not an exit code a command printed among its output", () => {
    expect(
      failureOf(
        "codex",
        "exec_command",
        "Chunk ID: a1\nProcess exited with code 0\nOutput:\nExit code: 1\n",
      ),
    ).toBeUndefined()
  })

  it("is not a failure's words a run that exited 0 printed, as from a log it read", () => {
    expect(
      failureOf(
        "codex",
        "exec_command",
        "Chunk ID: a1\nProcess exited with code 0\nOutput:\napply_patch verification failed: old log line\n",
      ),
    ).toBeUndefined()
    expect(
      failureOf(
        "agy",
        "run_command",
        "Created At: x\nCommand exited with code 0.\nStdout:\nEncountered error in step execution: old log line\n",
      ),
    ).toBeUndefined()
  })

  it("is Antigravity's errored step, or a command's exit code", () => {
    expect(
      failureOf(
        "agy",
        "read_file",
        "Created At: x\nEncountered error in step execution: file does not exist",
      ),
    ).toBe("file does not exist")
    expect(
      failureOf(
        "agy",
        "run_command",
        "Created At: x\nCompleted At: y\n\nThe command exited with code 2.\nStdout:\n\nStderr:\nls: cannot access 'x'\n",
      ),
    ).toBe("ls: cannot access 'x'")
    expect(
      failureOf("agy", "run_command", "Command exited with code 0.\n\nNo output from the command."),
    ).toBeUndefined()
  })
})

describe("a failure the harness words in another way", () => {
  it("is a Claude Code command that timed out", () => {
    expect(failureOf("claude", "Bash", "Command timed out after 2m 0.0s")).toBe(
      "Command timed out after 2m 0.0s",
    )
    expect(failureOf("claude", "PowerShell", "Command timed out after 30s\npartial")).toBe(
      "Command timed out after 30s",
    )
  })

  it("is Codex's older shell output, with its exit code in the metadata", () => {
    const output = (code: number) =>
      JSON.stringify({
        output: "error: boom\n",
        metadata: { exit_code: code, duration_seconds: 0.1 },
      })
    expect(failureOf("codex", "shell", output(1))).toBe("error: boom")
    expect(failureOf("codex", "shell", output(0))).toBeUndefined()
  })
})

describe("an edit's line counts", () => {
  it("count only the lines that changed, not those the two texts share", () => {
    expect(lineCounts("a\nb\nc\nd\n", "a\nB\nc\nD\n")).toEqual({ added: 2, removed: 2 })
    expect(lineCounts("one\n", "one\ntwo\nthree\n")).toEqual({ added: 2, removed: 0 })
  })

  it("add up Claude Code's MultiEdit and Antigravity's replacement chunks", () => {
    expect(
      editCounts(
        "MultiEdit",
        JSON.stringify({
          file_path: "/a.ts",
          edits: [
            { old_string: "a", new_string: "a\nb" },
            { old_string: "c\nd", new_string: "e" },
          ],
        }),
      ),
    ).toEqual({ added: 2, removed: 2 })
    expect(
      editCounts(
        "multi_replace_file_content",
        JSON.stringify({
          TargetFile: '"/a.ts"',
          ReplacementChunks: JSON.stringify([{ TargetContent: "x", ReplacementContent: "y\nz" }]),
        }),
      ),
    ).toEqual({ added: 2, removed: 1 })
  })

  it("count a whole file written as added, and say nothing for an input they can't read", () => {
    expect(editCounts("write_to_file", JSON.stringify({ CodeContent: '"a\\nb\\n"' }))).toEqual({
      added: 2,
      removed: 0,
    })
    expect(editCounts("NotebookEdit", "not json")).toBeNull()
  })
})

describe("the person's Inbox answers an agent was given", () => {
  const message = (fields: Partial<AgentMessage>): AgentMessage => ({
    id: `m${++count}`,
    hop: 1,
    from: "crow",
    to: "owl",
    text: "build the context lane",
    sentAt: 1,
    state: "delivered",
    held: null,
    deliveredAt: 2,
    ...fields,
  })
  const threads = (messages: readonly AgentMessage[]): TerminalThreads => ({
    handle: "owl",
    agent: true,
    threads: [{ id: "t", peer: "crow", hops: 1, idle: 0, held: false, heldFor: null, messages }],
  })

  it("are the person's replies from the Inbox once delivered, never an agent's messages", () => {
    expect(
      answersOf(
        threads([
          message({}),
          message({ text: "still on its way", state: "queued", deliveredAt: null }),
          message({ from: "rook", text: "a peer's note" }),
          message({ from: "owl", to: "crow", text: "my report" }),
          message({ from: "you", inbox: "answer", text: "use UTC", deliveredAt: 3 }),
          message({ from: "you", inbox: "answer", text: "  ", deliveredAt: 4 }),
          message({ from: "owl", to: "you", inbox: "ask", text: "which zone?" }),
        ]),
      ),
    ).toEqual([{ text: "use UTC", at: 3 }])
  })
})
