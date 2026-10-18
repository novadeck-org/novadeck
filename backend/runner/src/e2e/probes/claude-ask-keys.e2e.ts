// (K) route probes: the keys that answer each dialog, and what their results look like.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { text } from "../model/script.js"
import { own, result } from "../scenarios.js"
import { sleep, surface, tweak } from "./claude-support.js"

const Down = "\x1b[B"
const Up = "\x1b[A"
const Right = "\x1b[C"
const Left = "\x1b[D"
const bash = {
  calls: [
    {
      name: "Bash",
      input: { command: "touch keyed.txt", description: "Run it" },
    },
  ],
}
const q1 = {
  question: "Which database should we use?",
  header: "Database",
  multiSelect: false,
  options: [
    { label: "Postgres", description: "Relational" },
    { label: "SQLite", description: "Embedded" },
    { label: "DuckDB", description: "Columnar" },
  ],
}
const q2 = {
  question: "Which features should be enabled?",
  header: "Features",
  multiSelect: true,
  options: [
    { label: "Auth", description: "Login" },
    { label: "Billing", description: "Stripe" },
    { label: "Search", description: "FTS" },
  ],
}
const q3 = {
  question: "Which region should it deploy to?",
  header: "Region",
  multiSelect: false,
  options: [
    { label: "eu-west", description: "Ireland" },
    { label: "us-east", description: "Virginia" },
  ],
}
const ask = (...questions: unknown[]) => ({
  calls: [{ name: "AskUserQuestion", input: { questions } }],
})
const dialog = /Do you want to proceed\?/
// Three lines of context follow a change unless the file ends there, so the file is given more.
const after = "ctx1\nctx2\nctx3\nctx4\n"
const askShows = /Which database should we use\?/

surface({
  name: "k-bash-moved-highlight-digit1",
  reply: bash,
  shows: dialog,
  sizes: [],
  drive: async (t, _p, shot) => {
    t.press(Down)
    t.press(Down)
    await shot("moved-to-3")
    t.press("1")
    await shot("pressed-1")
  },
})
surface({
  name: "k-bash-arrows-enter",
  reply: bash,
  shows: dialog,
  sizes: [],
  drive: async (t, _p, shot) => {
    await t.confirm(/❯ 3\. No/, async () => {
      t.press(Down)
      t.press(Down)
    })
    await shot("after-enter-on-3")
  },
})
surface({
  name: "k-bash-esc",
  reply: bash,
  shows: dialog,
  sizes: [],
  drive: async (t, _p, shot) => {
    await t.escape()
    await shot("after-esc")
  },
})
surface({
  name: "k-bash-small-digits",
  reply: {
    calls: [{ name: "mcp__plugin_novadeck_novadeck__agents", input: {} }],
  },
  shows: /Tool use/,
  sizes: [],
  setup: (run) =>
    tweak(run, (s) => {
      s.permissions.allow = ["Bash(claude -p:*)"]
    }),
  drive: async (t, _p, shot) => {
    await shot("wide", 100)
    t.resize(60, 20)
    await shot("narrow-60x20", 1000)
    t.press("3")
    await shot("narrow-after-3", 1000)
    t.press("2")
    await shot("narrow-after-2", 1500)
  },
})

surface({
  name: "k-ask-single-moved-highlight",
  reply: ask(q1),
  shows: askShows,
  sizes: [],
  drive: async (t, _p, shot) => {
    t.press(Down)
    t.press(Down)
    await shot("moved-to-3")
    t.press("1")
    await shot("pressed-1")
  },
})
surface({
  name: "k-ask-other-enter",
  reply: ask(q1),
  shows: askShows,
  sizes: [],
  drive: async (t, _p, shot) => {
    t.press("4")
    await shot("focused-other", 500)
    await t.confirm(/MariaDB for the win/, async () => t.press("MariaDB for the win"))
    await shot("after-enter")
  },
})
surface({
  name: "k-ask-other-then-digit",
  reply: ask(q1),
  shows: askShows,
  sizes: [],
  drive: async (t, _p, shot) => {
    t.press("4")
    t.press("ab")
    await shot("typed-ab")
    t.press("2")
    await shot("then-2")
    t.press(Up)
    await shot("then-up")
    t.press("2")
    await shot("then-2-again")
  },
})
surface({
  name: "k-ask-esc",
  reply: ask(q1),
  shows: askShows,
  sizes: [],
  drive: async (t, _p, shot) => {
    await t.escape()
    await shot("after-esc")
  },
})
surface({
  name: "k-ask-chat",
  reply: ask(q1),
  shows: askShows,
  sizes: [],
  drive: async (t, _p, shot) => {
    t.press("5")
    await shot("pressed-5")
  },
})
surface({
  name: "k-ask-chat-by-arrows",
  reply: ask(q1),
  shows: askShows,
  sizes: [],
  drive: async (t, _p, shot) => {
    await t.confirm(/❯\s+5\. Chat about this|❯ Chat about this/, async () => {
      for (let i = 0; i < 4; i++) t.press(Down)
    })
    await shot("after-enter")
  },
})
surface({
  name: "k-ask-multi-full",
  reply: ask(q1, q2, q3),
  shows: askShows,
  sizes: [],
  drive: async (t, _p, shot) => {
    t.press("2")
    await shot("q2-tab", 500)
    t.press("1")
    await sleep(150)
    t.press("3")
    await shot("toggled", 400)
    t.press(Right)
    await shot("q3-tab", 400)
    t.press("2")
    await shot("review", 600)
    t.press("1")
    await shot("submitted", 1500)
  },
})
surface({
  name: "k-ask-multi-cancel-at-review",
  reply: ask(q1, q3),
  shows: askShows,
  sizes: [],
  drive: async (t, _p, shot) => {
    t.press("1")
    await sleep(300)
    t.press("1")
    await shot("review", 600)
    t.press("2")
    await shot("cancelled", 1500)
  },
})
surface({
  name: "k-ask-multi-back",
  reply: ask(q1, q3),
  shows: askShows,
  sizes: [],
  drive: async (t, _p, shot) => {
    t.press("1")
    await shot("q3-tab", 500)
    t.press(Left)
    await shot("back-on-q1", 500)
    t.press("2")
    await shot("after-change", 500)
    t.press("1")
    await shot("review", 600)
  },
})
surface({
  name: "k-ask-preview-enter",
  reply: ask({
    ...q1,
    options: [
      { ...q1.options[0], preview: "CREATE TABLE a (id int);" },
      { ...q1.options[1], preview: "CREATE TABLE a (id integer);" },
    ],
  }),
  shows: askShows,
  sizes: [],
  drive: async (t, _p, shot) => {
    await t.confirm(/❯ 2\. SQLite/, async () => t.press(Down))
    await shot("after-enter")
  },
})

// ---- plan
const planFile = (seen: { result?: string }) => [
  own((call) => {
    const last = call.turns.at(-1)
    const plans = text(call).match(/\/[^\s"'`]*\/plans\/[\w.-]+\.md/)
    if (call.turns.some((x) => x.role === "assistant")) {
      if (last?.role === "tool" && /File created|updated/.test(last.text))
        return { calls: [{ name: "ExitPlanMode", input: {} }] }
      const r = result(call)
      if (r !== undefined) {
        seen.result = r
        return { text: "Done." }
      }
      return undefined
    }
    if (plans)
      return {
        calls: [
          {
            name: "Write",
            input: {
              file_path: plans[0],
              content: "# Plan\n\n1. Do the thing\n2. Test it\n",
            },
          },
        ],
      }
    return { text: "no plan path found" }
  }),
]
const planMode = (run: Parameters<typeof tweak>[0]) =>
  tweak(run, (s) => {
    s.permissions.defaultMode = "plan"
  })
const planShows = /Would you like to proceed\?/
surface({
  name: "k-plan-1",
  reply: {},
  custom: planFile,
  shows: planShows,
  sizes: [],
  setup: planMode,
  drive: async (t, _p, shot) => {
    t.press("1")
    await shot("after-1", 1500)
  },
})
surface({
  name: "k-plan-3-feedback",
  reply: {},
  custom: planFile,
  shows: planShows,
  sizes: [],
  setup: planMode,
  drive: async (t, _p, shot) => {
    t.press("3")
    await shot("pressed-3", 600)
    await t.confirm(/rollback step please/, async () => t.press("Add a rollback step please"))
    await shot("after-enter", 1500)
  },
})
surface({
  name: "k-plan-esc",
  reply: {},
  custom: planFile,
  shows: planShows,
  sizes: [],
  setup: planMode,
  drive: async (t, _p, shot) => {
    await t.escape()
    await shot("after-esc", 1500)
  },
})

// A lone multi-select question: how it submits, and its "Type something" row.
surface({
  name: "k-ask-multi-lone",
  reply: ask({ ...q2, question: "Which features should be enabled?" }),
  shows: /Which features should be enabled\?/,
  sizes: [[60, 20]],
  drive: async (t, _p, shot) => {
    t.press("1")
    await sleep(200)
    t.press("3")
    await shot("toggled", 500)
    t.press(Right)
    await shot("after-right", 600)
    t.press("1")
    await shot("after-1", 1000)
  },
})
surface({
  name: "k-ask-multi-lone-enter",
  reply: ask(q2),
  shows: /Which features should be enabled\?/,
  sizes: [],
  drive: async (t, _p, shot) => {
    t.press("1")
    await sleep(200)
    await t.confirm(/\[✔\] Search/, async () => t.press("3"))
    await shot("after-enter", 1000)
  },
})
surface({
  name: "k-ask-multi-lone-other",
  reply: ask(q2),
  shows: /Which features should be enabled\?/,
  sizes: [],
  drive: async (t, _p, shot) => {
    t.press("1")
    await sleep(200)
    for (let i = 0; i < 3; i++) t.press(Down)
    await shot("on-other", 700)
    t.press("Webhooks please")
    await shot("typed", 900)
    await t.confirm(/❯\s+Submit/, async () => t.press(Down))
    await shot("review", 900)
    t.press("1")
    await shot("submitted", 1200)
  },
})

// An Edit of an existing file, whose dialog shows a diff.
const edit = {
  calls: [
    {
      name: "Edit",
      input: { file_path: "", old_string: "hello", new_string: "goodbye" },
    },
  ],
}
surface({
  name: "k-edit-existing",
  reply: edit,
  shows: /Do you want to make this edit/,
  setup: (run) => {
    const file = join(run.sandbox.project, "EXISTING.txt")
    writeFileSync(file, `hello\nworld\n${after}`)
    edit.calls[0]!.input.file_path = file
  },
})

// An MCP tool with arguments, and a Write over an existing file.
surface({
  name: "k-mcp-args",
  reply: {
    calls: [
      {
        name: "mcp__plugin_novadeck_novadeck__describe",
        input: { title: "My title", summary: "Doing things", asked: false },
      },
    ],
  },
  shows: /Tool use|Do you want to proceed\?/,
  setup: (run) =>
    tweak(run, (s) => {
      s.permissions.allow = ["Bash(claude -p:*)"]
    }),
})
const overwrite = {
  calls: [{ name: "Write", input: { file_path: "", content: "brand new\nsecond line\n" } }],
}
surface({
  name: "k-write-overwrite",
  reply: overwrite,
  shows: /Do you want to (?:make this edit|overwrite|create)/,
  setup: (run) => {
    const file = join(run.sandbox.project, "EXISTING.txt")
    writeFileSync(file, "old content\n")
    overwrite.calls[0]!.input.file_path = file
  },
})

// The plan's feedback field with words typed in, before Enter.
surface({
  name: "k-plan-3-typed",
  reply: {},
  custom: planFile,
  shows: planShows,
  sizes: [[60, 20]],
  setup: planMode,
  drive: async (t, _p, shot) => {
    t.press("3")
    await shot("pressed-3", 900)
    t.press("Add a rollback step please")
    await shot("typed", 900)
    await t.escape()
  },
})

// Read, Grep, Glob outside the project, MultiEdit and NotebookEdit: their dialogs.
const outside = (run: { sandbox: { root: string } }) => {
  const dir = join(run.sandbox.root, "outside")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "notes.txt"), "alpha\\nbeta needle\\n")
  return dir
}
const reading = { calls: [{ name: "Read", input: { file_path: "" } }] }
surface({
  name: "k-read-outside",
  reply: reading,
  shows: /Do you want to/,
  setup: (run) => {
    reading.calls[0]!.input.file_path = join(outside(run), "notes.txt")
  },
})
const grepping = { calls: [{ name: "Grep", input: { pattern: "needle", path: "" } }] }
surface({
  name: "k-grep-outside",
  reply: grepping,
  shows: /Do you want to|Found|No matches|Error|Searched/,
  setup: (run) => {
    outside(run)
    grepping.calls[0]!.input.path = "/etc"
  },
})
const globbing = { calls: [{ name: "Glob", input: { pattern: "*.txt", path: "" } }] }
surface({
  name: "k-glob-outside",
  reply: globbing,
  shows: /Do you want to|Found|No files|Error|Searched/,
  setup: (run) => {
    outside(run)
    globbing.calls[0]!.input.path = "/etc"
  },
})
const multi = {
  calls: [
    {
      name: "MultiEdit",
      input: {
        file_path: "",
        edits: [
          { old_string: "hello", new_string: "goodbye" },
          { old_string: "world", new_string: "moon" },
        ],
      },
    },
  ],
}
surface({
  name: "k-multiedit",
  reply: multi,
  shows: /Do you want to/,
  setup: (run) => {
    const file = join(run.sandbox.project, "EXISTING.txt")
    writeFileSync(file, "hello\\nworld\\n")
    multi.calls[0]!.input.file_path = file
  },
})
const notebook = {
  calls: [
    {
      name: "NotebookEdit",
      input: { notebook_path: "", new_source: "print(2)", cell_id: "c1", edit_mode: "replace" },
    },
  ],
}
surface({
  name: "k-notebook-edit",
  reply: notebook,
  shows: /Do you want to|Error/,
  setup: (run) => {
    const file = join(run.sandbox.project, "nb.ipynb")
    writeFileSync(
      file,
      JSON.stringify({
        cells: [
          {
            id: "c1",
            cell_type: "code",
            metadata: {},
            source: ["print(1)"],
            outputs: [],
            execution_count: null,
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
    )
    notebook.calls[0]!.input.notebook_path = file
  },
})

// "No" and "Chat about this", then the person's words as the next prompt.
surface({
  name: "k-no-then-prompt",
  reply: bash,
  shows: dialog,
  sizes: [[60, 20]],
  drive: async (t, _p, shot) => {
    t.press("3")
    await shot("after-no", 1200)
    await t.submit("Use ls instead please")
    await shot("after-words", 2500)
  },
})
surface({
  name: "k-chat-then-prompt",
  reply: ask(q1),
  shows: askShows,
  sizes: [],
  drive: async (t, _p, shot) => {
    t.press("5")
    await shot("after-chat", 1200)
    await t.submit("Can you explain the trade-offs first")
    await shot("after-words", 2500)
  },
})
const fetching = {
  calls: [{ name: "WebFetch", input: { url: "https://example.com/page", prompt: "summarize" } }],
}
surface({
  name: "k-webfetch-no",
  reply: fetching,
  shows: /Do you want to allow Claude to fetch/,
  sizes: [[60, 20]],
  drive: async (t, _p, shot) => {
    t.press("3")
    await shot("after-no", 1200)
    await t.submit("Use another address please")
    await shot("after-words", 2500)
  },
})

// "Chat about this" in the preview layout, which has no digits: arrows, then Enter.
surface({
  name: "k-ask-preview-chat",
  reply: ask({
    ...q1,
    options: [
      { ...q1.options[0], preview: "CREATE TABLE a (id int);" },
      { ...q1.options[1], preview: "CREATE TABLE a (id integer);" },
    ],
  }),
  shows: askShows,
  sizes: [],
  drive: async (t, _p, shot) => {
    t.press(Down)
    await shot("on-second", 900)
    await t.confirm(/❯ Chat about this/, async () => {
      t.press(Down)
      await sleep(900)
    })
    await shot("after-enter", 1500)
  },
})

// Edits and writes whose lines are longer than the screen, and large ones.
const longLine = (word: string) => Array.from({ length: 30 }, (_, i) => `${word}${i}`).join(" ")
const manyLines = (word: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${word} line ${i + 1}`).join("\n")
const longEdit = {
  calls: [
    {
      name: "Edit",
      input: {
        file_path: "",
        old_string: `${longLine("old")}\nsecond`,
        new_string: `${longLine("new")}\nsecond changed`,
      },
    },
  ],
}
surface({
  name: "k-edit-long-lines",
  reply: longEdit,
  shows: /Do you want to make this edit/,
  setup: (run) => {
    const file = join(run.sandbox.project, "LONG.txt")
    writeFileSync(file, `${longLine("old")}\nsecond\nthird\n${after}`)
    longEdit.calls[0]!.input.file_path = file
  },
})
const bigEdit = {
  calls: [{ name: "Edit", input: { file_path: "", old_string: "", new_string: "" } }],
}
surface({
  name: "k-edit-large",
  reply: bigEdit,
  shows: /Do you want to make this edit/,
  setup: (run) => {
    const file = join(run.sandbox.project, "BIG.txt")
    writeFileSync(file, `${manyLines("old", 80)}\ntail\n`)
    bigEdit.calls[0]!.input.file_path = file
    bigEdit.calls[0]!.input.old_string = manyLines("old", 80)
    bigEdit.calls[0]!.input.new_string = manyLines("new", 80)
  },
})
const bigWrite = {
  calls: [{ name: "Write", input: { file_path: "", content: "" } }],
}
surface({
  name: "k-write-large",
  reply: bigWrite,
  shows: /Do you want to create/,
  setup: (run) => {
    bigWrite.calls[0]!.input.file_path = join(run.sandbox.project, "BIGNEW.txt")
    bigWrite.calls[0]!.input.content = `${longLine("long")}\n${manyLines("new", 79)}\n`
  },
})

// Edits that share lines or change part of one, in a subfolder, a Write outside the
// project, and "Chat about this" on a lone multi-select.
const editing = (
  name: string,
  file: string,
  content: string,
  oldText: string,
  newText: string,
  tail = after,
) => {
  const reply = {
    calls: [{ name: "Edit", input: { file_path: "", old_string: oldText, new_string: newText } }],
  }
  surface({
    name,
    reply,
    shows: /Do you want to make this edit/,
    setup: (run) => {
      const path = join(run.sandbox.project, file)
      mkdirSync(join(path, ".."), { recursive: true })
      writeFileSync(path, content + tail)
      reply.calls[0]!.input.file_path = path
    },
  })
}
editing("k-edit-shared", "EXISTING.txt", "hello\nworld\n", "hello\nworld", "goodbye\nworld")
editing("k-edit-partial", "EXISTING.txt", "say hello there\nnext\n", "hello", "goodbye")
editing("k-edit-sub", "sub/INNER.txt", "hello\nworld\n", "hello", "goodbye")
const outsideWrite = { calls: [{ name: "Write", input: { file_path: "", content: "out\n" } }] }
surface({
  name: "k-write-outside",
  reply: outsideWrite,
  shows: /Do you want to (?:create|overwrite)/,
  setup: (run) => {
    const dir = join(run.sandbox.root, "outside")
    mkdirSync(dir, { recursive: true })
    outsideWrite.calls[0]!.input.file_path = join(dir, "OUT.txt")
  },
})
surface({
  name: "k-ask-multi-lone-chat",
  reply: ask(q2),
  shows: /Which features should be enabled\?/,
  sizes: [],
  drive: async (t, _p, shot) => {
    t.press("5")
    await shot("after-chat", 1200)
  },
})

// Deletion edits: the new text empty, with or without the line's newline, or blank.
editing("k-edit-delete-line", "EXISTING.txt", "hello\nworld\nend\n", "hello\n", "")
editing("k-edit-delete-text", "EXISTING.txt", "hello\nworld\nend\n", "hello", "")
editing("k-edit-blank", "EXISTING.txt", "hello\nworld\nend\n", "world", "  ")

// Tab-indented text, an edit of long wrapped prose, and replace_all.
editing(
  "k-edit-tabs",
  "EXISTING.txt",
  "\tif (x) {\n\t\thello();\n\t}\n",
  "\t\thello();",
  "\t\tgoodbye();",
)
const tabWrite = {
  calls: [{ name: "Write", input: { file_path: "", content: "a\n\tb\n\t\tc\n" } }],
}
surface({
  name: "k-write-tabs",
  reply: tabWrite,
  shows: /Do you want to create/,
  setup: (run) => {
    tabWrite.calls[0]!.input.file_path = join(run.sandbox.project, "TABS.txt")
  },
})
const para = (word: string) => Array.from({ length: 40 }, (_, i) => `${word}${i}`).join(" ")
editing(
  "k-edit-prose",
  "PROSE.txt",
  `${para("one")}\n${para("two")}\n${para("three")}\nend\n`,
  `${para("one")}\n${para("two")}`,
  `${para("uno")}\n${para("dos")}`,
)
const everywhere = {
  calls: [
    {
      name: "Edit",
      input: { file_path: "", old_string: "hello", new_string: "goodbye", replace_all: true },
    },
  ],
}
surface({
  name: "k-edit-replace-all",
  reply: everywhere,
  shows: /Do you want to make this edit/,
  setup: (run) => {
    const path = join(run.sandbox.project, "EXISTING.txt")
    writeFileSync(path, "hello hello\nmiddle\nhello\n")
    everywhere.calls[0]!.input.file_path = path
  },
})
const tabOver = { calls: [{ name: "Write", input: { file_path: "", content: "a\n\tb\n\t\tc\n" } }] }
surface({
  name: "k-write-tabs-over",
  reply: tabOver,
  shows: /Do you want to (?:overwrite|create)/,
  setup: (run) => {
    const path = join(run.sandbox.project, "TABSOLD.txt")
    writeFileSync(path, "old\n")
    tabOver.calls[0]!.input.file_path = path
  },
})

// A file without a final newline: edited on its last line, and earlier with it in the context.
editing("k-edit-nonl-last", "EXISTING.txt", "a\nb\nhello", "hello", "goodbye", "")
editing("k-edit-nonl-mid", "EXISTING.txt", "a\nb\nhello", "a", "x", "")
editing("k-edit-nonl-line", "EXISTING.txt", "a\nb\nhello\n", "hello\n", "bye\n", "")

// Write content without a final newline, and with extra trailing blank lines.
const writing = (name: string, content: string, existing?: string) => {
  const reply = { calls: [{ name: "Write", input: { file_path: "", content } }] }
  surface({
    name,
    reply,
    shows: /Do you want to (?:create|overwrite)/,
    setup: (run) => {
      const path = join(run.sandbox.project, existing === undefined ? `${name}.txt` : "OLD.txt")
      if (existing !== undefined) writeFileSync(path, existing)
      reply.calls[0]!.input.file_path = path
    },
  })
}
writing("k-write-nonl", "hello\nworld")
writing("k-write-blank-end", "hello\nworld\n\n\n")
writing("k-write-over-nonl", "hello\nworld", "old\n")
writing("k-write-over-blank-end", "hello\nworld\n\n", "old\n")
