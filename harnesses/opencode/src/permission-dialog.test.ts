import { explain } from "@novadeck/harness-core/dialogs"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import {
  readOn,
  bash,
  choice,
  diffOf,
  edit,
  permissionFacts,
  read,
  right,
  rowsOf,
  screens,
  sent,
  waits,
} from "./dialogs.test-support.js"

// Probed 2026-11-22, 1.19.6 (fixtures/dialogs.probe.json): the permission dialog of each tool
// the fake model called under `permission: ask`.
describe("opencode's permission dialog for a command", () => {
  it("reads the command as the request has it, with the three choices", () => {
    const found = read(rowsOf("permBash"), bash("echo approved"))
    expect(found.dialog).toEqual({
      type: "choices",
      title: "Shell command",
      detail: "echo approved",
      options: [
        { id: "once", label: "Allow once", text: null },
        { id: "always", label: "Allow always", text: null },
        { id: "reject", label: "Reject", text: "prompt" },
      ],
    })
    expect(found.reveal).toBeUndefined()
  })

  it("reads it on 60 columns, where its hint has a row of its own", () => {
    expect(read(rowsOf("permBash60"), bash("echo approved")).dialog).toMatchObject({
      detail: "echo approved",
    })
  })

  it("reads a command of several rows, one wrapped, as the command it is", () => {
    const command = `echo one && echo two && printf '%s\\n' ${"x".repeat(200)}\necho three`
    expect(read(rowsOf("permBashWrapped"), bash(command)).dialog).toMatchObject({ detail: command })
  })

  it("takes Allow once with Enter, Reject with Right Right Enter, from a fresh dialog", () => {
    const found = read(rowsOf("permBash"), bash("echo approved"))
    expect(sent(found.keys(choice("once")))).toEqual(["\r"])
    expect(sent(found.keys(choice("reject")))).toEqual([right, right, "\r"])
    expect(sent(found.keys(choice("reject", "no, do it by hand")))).toEqual([right, right, "\r"])
  })

  it("moves from wherever the selection stands, which only the cells' background says", () => {
    const keys = (name: string, option: string) =>
      sent(read(rowsOf(name), bash("echo approved")).keys(choice(option)))
    // Right wraps: Always selected needs two to Once, one to Reject; Reject selected, one and two.
    expect(keys("permBashAlwaysSelected", "once")).toEqual([right, right, "\r"])
    expect(keys("permBashAlwaysSelected", "always")?.slice(0, 1)).toEqual(["\r"])
    expect(keys("permBashAlwaysSelected", "reject")).toEqual([right, "\r"])
    expect(keys("permBashRejectSelected", "once")).toEqual([right, "\r"])
    expect(keys("permBashRejectSelected", "always")).toEqual([right, right, "\r", "\r"])
    expect(keys("permBashRejectSelected", "reject")).toEqual(["\r"])
  })

  it("reads it on 60 columns the same, the selection too", () => {
    const found = read(rowsOf("permBash60"), bash("echo approved"))
    expect(sent(found.keys(choice("once")))).toEqual(["\r"])
  })

  it("is no read without the screen's lit cells, or with no one choice lit", () => {
    const rows = rowsOf("permBash")
    const { result, refusals } = explain(() => dialogs.read(rows, bash("echo approved")))
    expect(result).toBeUndefined()
    expect(refusals).toContain("permission.selection.1")
    const unlit = { ...screens.permBash!, lit: screens.permBash!.rows.map(() => "") }
    expect(dialogs.read(rows, bash("echo approved"), unlit)).toBeUndefined()
    const two = screens.permBash!.lit!.map((row) => row.replace("Allow once", "Allow once  Reject"))
    expect(
      dialogs.read(rows, bash("echo approved"), { ...screens.permBash!, lit: two }),
    ).toBeUndefined()
  })

  it("takes Allow always through its second dialog, which must list the request's patterns", () => {
    const found = read(rowsOf("permBash"), bash("echo approved"))
    const steps = found.keys(choice("always"))
    expect(sent(steps)).toEqual([right, "\r", "\r"])
    const [listed] = waits(steps)!
    expect(listed!(rowsOf("permAlways"))).toBe(true)
    expect(listed!(rowsOf("permBash"))).toBe(false)
    const other = read(rowsOf("permBash"), bash("echo approved", ["rm *"]))
    expect(waits(other.keys(choice("always")))![0]!(rowsOf("permAlways"))).toBe(false)
  })

  it("takes no words with Allow, and no option it doesn't have", () => {
    const found = read(rowsOf("permBash"), bash("echo approved"))
    expect(found.keys(choice("once", "words"))).toBeUndefined()
    expect(found.keys(choice("maybe"))).toBeUndefined()
    expect(found.keys({ type: "chat", dialog: "d" })).toBeUndefined()
  })

  it("is answered once it is gone, or another has taken its place", () => {
    const found = read(rowsOf("permBash"), bash("echo approved"))
    expect(found.answered(rowsOf("permBash"))).toBe(false)
    expect(found.answered(rowsOf("permAlways"))).toBe(false)
    expect(found.answered(rowsOf("permWrite"))).toBe(true)
    expect(found.answered(rowsOf("models60"))).toBe(true)
  })

  it("does not read it for another command, or another tool", () => {
    expect(readOn(rowsOf("permBash"), bash("echo something else"))).toBeUndefined()
    expect(readOn(rowsOf("permBash"), permissionFacts("bash", { patterns: [] }))).toBeUndefined()
    expect(readOn(rowsOf("permBash"), edit("/home/user/project/new.txt", ""))).toBeUndefined()
  })

  it("says where it stopped reading", () => {
    const { result, refusals } = explain(() =>
      readOn(rowsOf("permBash"), bash("echo something else")),
    )
    expect(result).toBeUndefined()
    expect(refusals).toEqual(["permission.command.2", "permission.permission.2"])
  })
})

describe("opencode's permission dialog for a command its inline view cut", () => {
  const lines = Array.from({ length: 30 }, (_, at) => `echo line ${at}`)
  const request = bash(lines.join("\n"))

  it("asks for Ctrl-F, which shows it whole, and reads the whole one", () => {
    const cut = read(rowsOf("permBashCut"), request)
    expect(cut.reveal).toBe("\x06")
    expect(cut.dialog).toMatchObject({ detail: lines.join("\n") })
    const whole = read(rowsOf("permBashCutFull"), request)
    expect(whole.reveal).toBeUndefined()
    expect(sent(whole.keys(choice("once")))).toEqual(["\r"])
  })

  it("does not read a start of another command as it", () => {
    const other = bash(["echo line 0", "echo line 1", "rm -rf /"].join("\n"))
    expect(readOn(rowsOf("permBashCut"), other)).toBeUndefined()
  })

  it("does not vouch for a command its fullscreen view shows only a start of", () => {
    expect(readOn(rowsOf("permBashFull"), bash("echo approved\necho more"))).toBeUndefined()
  })
})

describe("opencode's permission dialog for a file", () => {
  const file = "/home/user/project/notes.txt"
  const changed = diffOf(" line one", "-line two", "+line 2 changed", " line three")

  it("reads an edit by its path, with the diff it draws", () => {
    const found = read(rowsOf("permEdit"), edit(file, changed))
    expect(found.dialog).toMatchObject({
      title: "Edit notes.txt",
      detail: "1   line one\n2 - line two\n2 + line 2 changed\n3   line three",
    })
    expect(found.reveal).toBeUndefined()
    expect(read(rowsOf("permEdit60"), edit(file, changed)).dialog).toMatchObject({
      title: "Edit notes.txt",
    })
  })

  it("reads a write the same way, a new file's diff all additions", () => {
    const found = read(
      rowsOf("permWrite"),
      edit("/home/user/project/new.txt", diffOf("+hello", "+world")),
    )
    expect(found.dialog).toMatchObject({ title: "Edit new.txt", detail: "1 + hello\n2 + world" })
  })

  it("does not read it for another file", () => {
    expect(
      readOn(rowsOf("permEdit"), edit("/home/user/project/other.txt", changed)),
    ).toBeUndefined()
    expect(
      readOn(rowsOf("permEdit"), edit("/home/user/project/xnotes.txt", changed)),
    ).toBeUndefined()
  })

  it("asks for Ctrl-F where its inline view stopped short of the diff's last line", () => {
    const big = edit(
      "/home/user/project/big.txt",
      diffOf(...Array.from({ length: 60 }, (_, at) => `+row ${at} of the file`)),
    )
    expect(read(rowsOf("permWriteCut"), big).reveal).toBe("\x06")
  })

  it("does not vouch for a diff taller than its fullscreen view, which scrolls", () => {
    const big = edit(
      "/home/user/project/big.txt",
      diffOf(...Array.from({ length: 60 }, (_, at) => `+row ${at} of the file`)),
    )
    const { result, refusals } = explain(() => readOn(rowsOf("permWriteCutFull"), big))
    expect(result).toBeUndefined()
    expect(refusals).toContain("permission.edit.3")
  })
})

describe("opencode's permission dialogs for its other tools", () => {
  it("reads a web fetch by its URL", () => {
    const url = "https://example.com/page"
    const found = read(
      rowsOf("permWebfetch"),
      permissionFacts("webfetch", {
        patterns: [url],
        metadata: { url, format: "text" },
        always: ["*"],
      }),
    )
    expect(found.dialog).toMatchObject({
      title: "WebFetch https://example.com/page",
      detail: "URL: https://example.com/page",
    })
    expect(
      dialogs.read(
        rowsOf("permWebfetch"),
        permissionFacts("webfetch", { patterns: [], metadata: { url: "https://evil.example" } }),
      ),
    ).toBeUndefined()
  })

  it("reads a read by its path, and a glob and a grep by their pattern", () => {
    expect(
      read(
        rowsOf("permRead"),
        permissionFacts("read", { patterns: ["home/user/project/notes.txt"] }),
      ).dialog,
    ).toMatchObject({ title: "Read notes.txt", detail: "notes.txt" })
    expect(
      read(
        rowsOf("permGlob"),
        permissionFacts("glob", { patterns: ["*.txt"], metadata: { pattern: "*.txt" } }),
      ).dialog,
    ).toMatchObject({ title: 'Glob "*.txt"' })
    expect(
      read(
        rowsOf("permGrep"),
        permissionFacts("grep", { patterns: ["line"], metadata: { pattern: "line" } }),
      ).dialog,
    ).toMatchObject({ title: 'Grep "line"' })
    expect(
      dialogs.read(
        rowsOf("permGlob"),
        permissionFacts("grep", { patterns: ["*.txt"], metadata: { pattern: "*.txt" } }),
      ),
    ).toBeUndefined()
  })

  it("reads an access outside the project by its directory and patterns", () => {
    const found = read(
      rowsOf("permExternal"),
      permissionFacts("external_directory", {
        patterns: ["/etc/*"],
        metadata: { filepath: "/etc/hostname", parentDir: "/etc" },
        always: ["/etc/*"],
      }),
    )
    expect(found.dialog).toMatchObject({ title: "Access external directory /etc" })
    expect(
      dialogs.read(
        rowsOf("permExternal"),
        permissionFacts("external_directory", {
          patterns: ["/etc/passwd"],
          metadata: { parentDir: "/etc" },
        }),
      ),
    ).toBeUndefined()
  })

  it("reads a subagent task by its type and description", () => {
    const found = read(
      rowsOf("permTask"),
      permissionFacts("task", {
        patterns: ["general"],
        metadata: { description: "Look around", subagent_type: "general" },
        always: ["*"],
      }),
    )
    expect(found.dialog).toMatchObject({ title: "General Task", detail: "Look around" })
  })

  it("reads an MCP tool's, or any other permission's, by its name", () => {
    expect(
      read(rowsOf("permMcp"), permissionFacts("theirs_ping", { patterns: ["*"], always: ["*"] }))
        .dialog,
    ).toMatchObject({
      title: "Call tool theirs_ping",
    })
    expect(
      read(rowsOf("permMcpArgs"), permissionFacts("theirs_say", { patterns: ["*"] })).dialog,
    ).toMatchObject({
      detail: "Tool: theirs_say",
    })
    expect(
      readOn(rowsOf("permMcp"), permissionFacts("theirs_other", { patterns: ["*"] })),
    ).toBeUndefined()
  })
})

describe("opencode's permission dialog behind another view", () => {
  const request = bash("echo child")

  it("reads in the parent's view, which shows a child session's request", () => {
    expect(read(rowsOf("permSubParent"), request).dialog).toMatchObject({ detail: "echo child" })
    expect(read(rowsOf("permSubParent60"), request).dialog).toMatchObject({ detail: "echo child" })
  })

  it("is not read in the child's own view, which asks Up to go back to the parent", () => {
    expect(readOn(rowsOf("permSubChild"), request)).toBeUndefined()
    expect(dialogs.reveal?.(rowsOf("permSubChild"))).toBe("\x1b[A")
    expect(dialogs.reveal?.(rowsOf("permSubChild60"))).toBe("\x1b[A")
    expect(dialogs.reveal?.(rowsOf("permSubParent"))).toBeUndefined()
  })

  it("is not read under a modal dialog, which asks Escape to close it", () => {
    expect(readOn(rowsOf("permSessions"), bash("echo approved"))).toBeUndefined()
    for (const name of ["permSessions", "permPalette"])
      expect(dialogs.reveal?.(rowsOf(name)), name).toBe("\x1b")
  })

  it("asks for nothing at rest or with the dialog in view, as Escape would reject it", () => {
    for (const name of ["permBash", "permBashFull", "permAlways", "qOne", "models60"])
      expect(dialogs.reveal?.(rowsOf(name)), name).toBeUndefined()
  })
})
