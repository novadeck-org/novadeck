import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import {
  choice,
  command,
  gone,
  permissionFacts,
  questionsAnswer,
  read,
  run,
  same,
  scenarios,
  type Screens,
  sent,
  without,
  write,
} from "./dialogs.test-support.js"

describe("Antigravity's command confirmation", () => {
  it("is read from the screen at both sizes, its options as shown, a digit answering at once", () => {
    for (const screen of [command.pending.screen120!.rows, command.pending.screen60!.rows]) {
      const found = read(screen, permissionFacts(run("echo approved")))
      expect(found.dialog).toMatchObject({
        type: "choices",
        title: "Run this command?",
        detail: "echo approved",
        options: [
          { id: "1", label: "Yes, run command", text: null },
          { id: "2", label: expect.stringMatching(/^Yes, and always allow in this conversation/) },
          { id: "3", label: expect.stringMatching(/\(Persist to settings\.json\)$/) },
          { id: "4", label: "No, cancel", text: "prompt" },
        ],
      })
      expect(sent(found.keys(choice("1")))).toEqual(["1"])
      expect(sent(found.keys(choice("4")))).toEqual(["4"])
      // Words go with the No only, as the prompt after it; no other option takes them.
      expect(sent(found.keys(choice("4", "use ls instead")))).toEqual(["4"])
      expect(found.keys(choice("1", "and more"))).toBeUndefined()
      expect(found.keys(choice("2", "and more"))).toBeUndefined()
      // An option it hasn't, or another kind of answer, press nothing.
      expect(found.keys(choice("5"))).toBeUndefined()
      expect(found.keys(questionsAnswer({ question: "1", options: ["1"] }))).toBeUndefined()
    }
  })

  it("shows the call's own command as detail, with its lines, indent and blank lines", () => {
    const multi = "if true; then\n\n    echo a\n\n\n\techo b\nfi"
    const rows = command.pending.screen120!.rows
    const at = rows.indexOf("   echo approved")
    const shown = ["   if true; then", "", "       echo a", "", "", "   \techo b", "   fi"]
    const found = read(
      [...rows.slice(0, at), ...shown, ...rows.slice(at + 1)],
      permissionFacts(run(multi)),
    )
    expect(found.dialog).toMatchObject({ detail: multi })
  })

  it("keeps the screen's text when the call is another, only alike once rows join", () => {
    const rows = command.pending.screen120!.rows
    const at = rows.indexOf("   echo approved")
    const screen = [...rows.slice(0, at), "   echo a", "   rm -rf build", ...rows.slice(at + 1)]
    // The queued call's command reads as the two rows joined, but is not what they show.
    const found = read(screen, permissionFacts(run("echo a rm -rf build")))
    expect(found.dialog).toMatchObject({ detail: "echo a\nrm -rf build" })
    expect(read(screen, permissionFacts(run("echo a\nrm -rf build"))).dialog).toMatchObject({
      detail: "echo a\nrm -rf build",
    })
  })

  it("takes a long command wrapped where its row was full as the call's own", () => {
    const rows = command.pending.screen60!.rows
    const at = rows.indexOf("   echo approved")
    const long = "echo approved and then some more words to fill up the narrow row quite well"
    const screen = [
      ...rows.slice(0, at),
      "   echo approved and then some more words to fill up the",
      "   narrow row quite well",
      ...rows.slice(at + 1),
    ]
    expect(read(screen, permissionFacts(run(long))).dialog).toMatchObject({ detail: long })
  })

  it("joins an option wrapped on a narrow screen", () => {
    const found = read(command.pending.screen60!.rows, permissionFacts(run("echo approved")))
    expect(found.dialog).toMatchObject({
      options: [
        {},
        { label: "Yes, and always allow in this conversation for commands that start with 'echo'" },
        {
          label:
            "Yes, and always allow for commands that start with 'echo' (Persist to settings.json)",
        },
        {},
      ],
    })
  })

  it("is answered once its dialog is gone, and not while it, or the same call's, shows", () => {
    const found = read(command.pending.screen120!.rows, permissionFacts(run("echo approved")))
    expect(found.answered(command.pending.screen120!.rows)).toBe(false)
    expect(found.answered(command.pending.screen60!.rows)).toBe(false)
    expect(found.answered(gone.ask!.rows)).toBe(true)
    // Parallel calls show their dialogs one at a time: the next is another command's.
    expect(
      found.answered(same(command.pending.screen120!.rows, "   echo approved", "   echo another")),
    ).toBe(true)
  })

  it("tells the next of two identical queued commands by how the tool lines moved on", () => {
    const { twin } = scenarios
    const latest = (
      loadProbe(import.meta.dirname, "ask.probe.1.3.0.json") as {
        screens: { [name: string]: ScreenText }
      }
    ).screens
    const twins = permissionFacts(run("echo same"))
    // 1.2.14 marks the queued call ○ until it is its turn; 1.3.0 folds the ran into a count.
    for (const [first, second] of [
      [twin.first.rows, twin.second.rows],
      [latest.twinFirst!.rows, latest.twinSecond!.rows],
    ]) {
      const found = read(first!, twins)
      expect(found.answered(first!)).toBe(false)
      expect(found.answered(second!)).toBe(true)
    }
    // A redraw of the lines above it, a hint toggled, is no progress.
    const pending = command.pending.screen120!.rows
    const found = read(pending, permissionFacts(run("echo approved")))
    const toggled = same(
      pending,
      "● Bash(echo approved) (ctrl+o to expand)",
      "● Bash(echo approved) (ctrl+o to collapse)",
    )
    expect(found.answered(toggled)).toBe(false)
    expect(found.answered(same(pending, "> Run it", "> Run it again"))).toBe(false)
    const queued = read(twin.first!.rows, twins)
    expect(
      queued.answered(same(twin.first!.rows, /^● Bash\(echo same\)$/, "● Bash(echo same) !")),
    ).toBe(false)
    const folded = read(latest.twinFirst!.rows, twins)
    expect(
      folded.answered(same(latest.twinFirst!.rows, /^● Ran \(echo same\)$/, "● Ran (echo same) ·")),
    ).toBe(false)
    // Not at 60 columns, where the lines scrolled off: nothing tells them apart.
    const narrow = read(command.pending.screen60!.rows, permissionFacts(run("echo approved")))
    expect(narrow.answered(command.pending.screen60!.rows)).toBe(false)
  })

  it("agrees with the command of the call it was asked of, or is none", () => {
    const screen = command.pending.screen120!.rows
    expect(dialogs.read(screen, permissionFacts(run("rm -rf /")))).toBeUndefined()
    expect(dialogs.read(screen, permissionFacts(run("echo approved && true")))).toBeUndefined()
    expect(dialogs.read(screen, permissionFacts(undefined))).toBeUndefined()
    expect(dialogs.read(screen, permissionFacts({ name: "run_command", args: {} }))).toBeUndefined()
    expect(
      dialogs.read(screen, permissionFacts({ name: "write_to_file", args: {} })),
    ).toBeUndefined()
    // Whitespace within a row must match; a row break may be a newline or a space.
    expect(dialogs.read(screen, permissionFacts(run("echo   approved")))).toBeUndefined()
    expect(dialogs.read(screen, permissionFacts(run("echo\tapproved")))).toBeUndefined()
    expect(dialogs.read(screen, permissionFacts(run("  echo approved \n")))).toBeDefined()
    const wrapped = [
      ...screen.slice(0, screen.indexOf("   echo approved")),
      "   echo one",
      "   echo two",
      ...screen.slice(screen.indexOf("   echo approved") + 1),
    ]
    expect(dialogs.read(wrapped, permissionFacts(run("echo one\necho two")))).toBeDefined()
    expect(dialogs.read(wrapped, permissionFacts(run("echo one echo two")))).toBeDefined()
    expect(dialogs.read(wrapped, permissionFacts(run("echo one  echo two")))).toBeUndefined()
    // Words are kept apart: `> x` is not `>x`.
    const redirect = same(screen, "   echo approved", "   echo a > x")
    expect(dialogs.read(redirect, permissionFacts(run("echo a > x")))).toBeDefined()
    expect(dialogs.read(redirect, permissionFacts(run("echo a >x")))).toBeUndefined()
  })

  it("reads a command cut short with ... only by a start of its own", () => {
    const request = permissionFacts(run("echo approved"))
    const cut = same(command.pending.screen120!.rows, "   echo approved", "   echo appr...")
    expect(dialogs.read(cut, permissionFacts(run("echo other")))).toBeUndefined()
    expect(dialogs.read(cut, permissionFacts(run("echo approved and more")))).toBeDefined()
    const bare = same(command.pending.screen120!.rows, "   echo approved", "   ...")
    expect(dialogs.read(bare, request)).toBeUndefined()
    const short = same(command.pending.screen120!.rows, "   echo approved", "   echo appr")
    expect(dialogs.read(short, request)).toBeUndefined()
  })

  it("is none once the screen is broken", () => {
    const request = permissionFacts(run("echo approved"))
    for (const screen of [command.pending.screen120!.rows, command.pending.screen60!.rows]) {
      const breaks = [
        // The question, its footer, the command's heading.
        without(screen, /^Run this command\?$/),
        same(screen, "Run this command?", "Run this program?"),
        without(screen, /Navigate/),
        without(screen, /^Requesting permission for:$/),
        // An option gone, renumbered, unmarked, marked twice, or a row between them.
        without(screen, /^ {2}2\. |^2\. /),
        screen.map((row) => row.replace(/^ {2}3\. /, "  5. ")),
        screen.map((row) => row.replace(/^> 1\. /, "  1. ")),
        screen.map((row) => row.replace(/^ {2}4\. /, "> 4. ")),
        // Another question beside it.
        [...screen, "Allow creation of this file?"],
        // Nothing of it.
        [],
        screen.slice(0, 6),
      ]
      for (const broken of breaks) expect(dialogs.read(broken, request)).toBeUndefined()
    }
    expect(dialogs.read(gone.ask!.rows, request)).toBeUndefined()
  })

  it("is none for a request of another kind", () => {
    expect(
      dialogs.read(command.pending.screen120!.rows, {
        ...permissionFacts(run("echo approved")),
        kind: "plan",
      }),
    ).toBeUndefined()
  })
})

describe("Antigravity's file confirmation", () => {
  const target = { name: "write_to_file", args: { TargetFile: "/tmp/sandbox/project/probe.txt" } }

  it("is read by its wording, its options as shown", () => {
    const found = read(write.pending.screen120!.rows, permissionFacts(target))
    expect(found.dialog).toEqual({
      type: "choices",
      title: "Allow creation of this file?",
      detail: "/tmp/sandbox/project/probe.txt  +1\n   1 +  hello",
      options: [
        { id: "1", label: "Yes, allow creation", text: null },
        { id: "2", label: "No, deny creation", text: "prompt" },
      ],
    })
    expect(sent(found.keys(choice("2")))).toEqual(["2"])
    expect(found.answered(write.pending.screen120!.rows)).toBe(false)
    expect(found.answered(gone.ask!.rows)).toBe(true)
  })

  it("shows the whole of what it asks, never a cut of it", () => {
    const long = `echo ${"x".repeat(1500)}`
    const screen = same(command.pending.screen120!.rows, "   echo approved", `   ${long}`)
    const found = read(screen, permissionFacts(run(long)))
    expect(found.dialog).toMatchObject({ detail: long })
  })

  it("agrees with the file of the call, or is none", () => {
    const screen = write.pending.screen120!.rows
    const other = { name: "write_to_file", args: { TargetFile: "/tmp/sandbox/project/other.txt" } }
    expect(dialogs.read(screen, permissionFacts(other))).toBeUndefined()
    expect(
      dialogs.read(screen, permissionFacts({ name: "write_to_file", args: {} })),
    ).toBeUndefined()
    expect(dialogs.read(screen, permissionFacts(run("echo approved")))).toBeUndefined()
    expect(dialogs.read(screen, permissionFacts(undefined))).toBeUndefined()
    expect(dialogs.read(without(screen, /Navigate/), permissionFacts(target))).toBeUndefined()
    expect(
      dialogs.read(
        same(screen, "Allow creation of this file?", "Create it?"),
        permissionFacts(target),
      ),
    ).toBeUndefined()
    expect(dialogs.read(without(screen, /^ {2}2\. /), permissionFacts(target))).toBeUndefined()
    // Another tool on the same file, as a delete, is not a write.
    expect(
      dialogs.read(screen, permissionFacts({ name: "delete_file", args: target.args })),
    ).toBeUndefined()
    // The file's name elsewhere than its own lines (the transcript above, a longer path).
    const elsewhere = same(
      screen,
      "/tmp/sandbox/project/probe.txt  +1",
      "/tmp/sandbox/project/other.txt  +1",
    ).map((row) => (row === "Create file" ? "Create file" : row))
    const above = ["see /tmp/sandbox/project/probe.txt", ...elsewhere]
    expect(dialogs.read(above, permissionFacts(target))).toBeUndefined()
    const longer = same(
      screen,
      "/tmp/sandbox/project/probe.txt  +1",
      "/tmp/sandbox/project/probe.txt.bak  +1",
    )
    expect(dialogs.read(longer, permissionFacts(target))).toBeUndefined()
    expect(
      dialogs.read(same(screen, "Create file", "Delete file"), permissionFacts(target)),
    ).toBeUndefined()
  })
})

describe("Antigravity's file edit confirmation", () => {
  const edit = {
    name: "replace_file_content",
    args: { TargetFile: "/tmp/sandbox/project/probe.txt" },
  }
  const { replace_file_content: replaced } = scenarios as unknown as {
    replace_file_content: { pending: Screens }
  }
  const screen = replaced.pending.screen120!.rows

  it("is read by its wording, without the auto-approval hint", () => {
    const found = read(screen, permissionFacts(edit))
    expect(found.dialog).toEqual({
      type: "choices",
      title: "Accept this file edit?",
      detail: "/tmp/sandbox/project/probe.txt  +1 -1\n   1 -  hello\n   1 +  goodbye",
      options: [
        { id: "1", label: "Yes, accept this change", text: null },
        { id: "2", label: "No, reject this change", text: "prompt" },
      ],
    })
    expect(sent(found.keys(choice("1")))).toEqual(["1"])
    expect(found.answered(screen)).toBe(false)
    expect(found.answered(gone.ask!.rows)).toBe(true)
  })

  it("agrees with the call's file and tool, or is none", () => {
    const other = {
      name: "replace_file_content",
      args: { TargetFile: "/tmp/sandbox/project/b.txt" },
    }
    expect(dialogs.read(screen, permissionFacts(other))).toBeUndefined()
    expect(
      dialogs.read(screen, permissionFacts({ name: "write_to_file", args: edit.args })),
    ).toBeUndefined()
  })
})

describe("Antigravity's confirmation of a command taller than it", () => {
  const { scenarios: probed } = loadProbe(import.meta.dirname, "tall.probe.json") as {
    scenarios: { [name: string]: { commands: string[]; screens: { [size: string]: ScreenText } } }
  }
  const tall = probed.tall!
  const [script] = tall.commands
  const facts = (asked: string) => permissionFacts(run(asked))

  it("reads the whole command by its start where it says it hid the rest", () => {
    const found = read(tall.screens["120x40"]!.rows, facts(script!))!
    expect(found.dialog).toMatchObject({ detail: script, title: "Run this command?" })
    expect(found.keys({ type: "choice", dialog: "id", option: "1" })).toEqual([{ press: "1" }])
  })

  it("reads a start that ends in dots with the rows above it scrolled away", () => {
    const found = read(tall.screens["60x20"]!.rows, facts(script!))!
    expect(found.dialog).toMatchObject({ title: "Run this command?" })
    // No rows above to say that no other call waits: it shows as the TUI words it.
    expect((found.dialog as { detail: string }).detail).toMatch(/\.\.\.$/)
  })

  it("shows it as the TUI words it where another call goes on above it", () => {
    const { commands, screens } = probed.twins!
    const screen = screens["120x40"]!.rows
    expect(screen.some((row) => /^[●○] Running/.test(row))).toBe(true)
    const worded = (rows: readonly string[]): string =>
      (read(rows, facts(commands[1]!)).dialog as { detail: string }).detail
    expect(worded(screen)).toMatch(/\(\d+ lines hidden\)$/)
    // Its dot blinks, and the dialog stays the same.
    const blinked = screen.map((row) => row.replace(/^● Running/, "○ Running"))
    expect(worded(blinked)).toBe(worded(screen))
  })

  it("claims no whole command where the rows above its heading are gone", () => {
    const { commands, screens } = probed.wide!
    const drawn = screens["60x20"]!.rows
    expect(drawn[0]?.trim()).toBe("Command")
    // Another call that starts alike: the dialog may be this one's, or that one's.
    const another = `${commands[0]!} && rm -rf ~/precious`
    expect((read(drawn, facts(another)).dialog as { detail: string }).detail).toMatch(/\.\.\.$/)
  })

  it("claims no whole command beside a tool line it doesn't know, wherever that is", () => {
    const { commands, screens } = probed.twins!
    const screen = screens["120x40"]!.rows
    const running = screen.findIndex((row) => /^[●○] Running/.test(row))
    const worded = (rows: readonly string[]): string =>
      (read(rows, facts(commands[1]!)).dialog as { detail: string }).detail
    for (const row of [
      "● Queued (x)",
      "⠋ Running (x)",
      "  ● Running (x)",
      "● Bash(x)",
      "▸ x",
      "◐ Running (x)",
      "* Running (x)",
      "Running (x)",
    ])
      expect(worded(screen.with(running, row))).toMatch(/lines hidden\)$/)
    // A quote or a rule under it hides nothing.
    const under = [
      ...screen.slice(0, running + 1),
      "> a quote",
      "─".repeat(9),
      ...screen.slice(running + 1),
    ]
    expect(worded(under)).toMatch(/lines hidden\)$/)
  })

  it("takes no rows as a whole command where the row that heads them is gone", () => {
    const rows = command.pending.screen120!.rows
    const headless = rows.slice(rows.indexOf("   echo approved"))
    expect(dialogs.read(headless, facts("echo approved"))).toBeUndefined()
  })

  it("counts no blink of a running call's dot as the dialog answered", () => {
    const { commands, screens } = probed.twins!
    const lit = screens["120x40"]!.rows.map((row) => row.replace(/^○ Running/, "● Running"))
    const dim = lit.map((row) => row.replace(/^● Running/, "○ Running"))
    expect(read(dim, facts(commands[1]!)).answered(lit)).toBe(false)
    expect(read(lit, facts(commands[1]!)).answered(dim)).toBe(false)
  })

  it("keeps a tab of a command shown whole", () => {
    const rows = same(command.pending.screen120!.rows, "   echo approved", "   echo    approved")
    const asked = "echo\tapproved"
    expect(read(rows, facts(asked)).dialog).toMatchObject({ detail: asked })
  })

  it("reads no start that isn't the request's, nor one cut where the call isn't", () => {
    const screen = tall.screens["120x40"]!.rows
    expect(dialogs.read(screen, facts(`echo other\n${script}`))).toBeUndefined()
    expect(dialogs.read(screen, facts("cat <<'E' > tall.txt"))).toBeUndefined()
  })
})
