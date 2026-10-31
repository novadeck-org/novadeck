import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import {
  asks,
  blanksBefore,
  choice,
  effect,
  factsOf,
  linesOfText,
  need,
  other,
  pressed,
  readOf,
  scenario,
  screen,
  sizes,
  step,
  swap,
  time,
  wrapRow,
  writing,
} from "./dialogs.test-support.js"

describe("Claude Code's permission dialogs", () => {
  it.each(sizes)("shows a Bash command as the request's own, at %s", (size) => {
    const facts = factsOf("bash-long")
    const found = need(readOf("bash-long", size))
    expect(found.dialog).toMatchObject({ detail: (facts.input as { command: string }).command })
  })

  it("shows a multi-line, indented command with blank lines exactly as it will run", () => {
    const command = "touch approved.txt && ls /tmp &&\n\n    echo a\n\n\n\techo b\nls"
    const rows = screen("bash-long", "120x40")
    const from = rows.findIndex((row) => row.startsWith(" │ touch"))
    const shown = [
      " │ touch approved.txt && ls /tmp &&",
      " │ ",
      " │     echo a",
      " │ ",
      " │ ",
      " │ \techo b",
      " │ ls",
    ]
    const custom = [
      ...rows.slice(0, from),
      ...shown,
      ...rows.slice(rows.findLastIndex((row) => row.startsWith(" │ ")) + 1),
    ]
    const found = need(
      dialogs.read(custom, {
        ...factsOf("bash-long"),
        input: { command, description: "Make a file" },
      }),
    )
    expect(found.dialog).toMatchObject({ detail: command })
  })

  it.each(sizes)("reads a Bash command's options at %s", (size) => {
    const dialog = need(readOf("bash-long", size))
    expect(dialog.dialog).toEqual({
      type: "choices",
      title: "Do you want to proceed?",
      detail: expect.stringContaining("touch approved.txt && echo"),
      options: [
        { id: "1", label: "Yes", text: null },
        {
          id: "2",
          label: "Yes, and allow access to /tmp and touch approved.txt commands",
          text: null,
        },
        { id: "3", label: "No", text: null },
        { id: "tell", label: "No, and tell Claude what to do", text: "prompt" },
      ],
    })
    expect(pressed(dialog.keys(choice("1")))).toEqual(["1"])
    expect(pressed(dialog.keys(choice("3")))).toEqual(["3"])
    expect(dialog.keys(choice("4"))).toBeUndefined()
    expect(dialog.keys(choice("1", "words"))).toBeUndefined()
    expect(dialog.answered(screen("bash-long", size))).toBe(false)
    expect(dialog.answered(step("bash-long", "after"))).toBe(true)
  })

  it("takes the digits from the screen, which at 60 columns drops an MCP tool's second option", () => {
    const wide = need(readOf("mcp", "120x40"))
    const narrow = need(readOf("mcp", "60x20"))
    expect(wide.dialog).toMatchObject({
      options: [{ id: "1" }, { id: "2" }, { id: "3", label: "No" }, { id: "tell", text: "prompt" }],
    })
    expect(narrow.dialog).toMatchObject({
      options: [
        { id: "1", label: "Yes" },
        { id: "2", label: "No" },
        { id: "tell", text: "prompt" },
      ],
    })
    expect(pressed(narrow.keys(choice("2")))).toEqual(["2"])
    expect(narrow.keys(choice("3"))).toBeUndefined()
    expect(narrow.answered(step("mcp", "after"))).toBe(true)
  })

  it.each(sizes)("reads a WebFetch's options at %s", (size) => {
    const dialog = need(readOf("webfetch", size))
    expect(dialog.dialog).toMatchObject({
      title: "Do you want to allow Claude to fetch this content?",
      options: [
        { id: "1", label: "Yes" },
        { id: "2", label: "Yes, and don't ask again for example.com" },
        { id: "3", label: "No, and tell Claude what to do differently (esc)" },
      ],
    })
    expect(dialog.answered(step("webfetch", "after"))).toBe(true)
  })

  it.each(sizes)("reads a Write's options at %s, in full when wrapped", (size) => {
    const dialog = need(readOf("write", size))
    expect(dialog.dialog).toMatchObject({
      title: "Do you want to create NEWFILE.txt?",
      options: [
        { id: "1", label: "Yes" },
        {
          id: "2",
          label:
            "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)",
        },
        { id: "3", label: "No" },
        { id: "tell", text: "prompt" },
      ],
    })
    expect(dialog.answered(step("write", "after"))).toBe(true)
  })

  it("recognises a dialog whose highlight the person moved", () => {
    const moved = step("k-bash-moved-highlight-digit1", "moved-to-3")
    expect(
      dialogs.read(moved, {
        kind: "permission",
        tool: "Bash",
        input: { command: "touch keyed.txt" },
        cwd: null,
      }),
    ).toBeDefined()
  })

  it("offers No with words, which go as the next prompt once No has interrupted the turn", () => {
    for (const size of sizes) {
      const bash = need(readOf("bash-long", size))
      const tell = (bash.dialog as { options: { id: string; text: string | null }[] }).options.find(
        ({ id }) => id === "tell",
      )
      expect(tell).toMatchObject({ label: "No, and tell Claude what to do", text: "prompt" })
      // It presses No, and leaves the words to the driver.
      expect(pressed(bash.keys(choice("tell", "use ls instead")))).toEqual(["3"])
      expect(pressed(bash.keys(choice("tell")))).toEqual(["3"])
      // The screen's own digit, which at 60 columns an MCP tool's No has moved.
      const mcp = need(readOf("mcp", size))
      expect(pressed(mcp.keys(choice("tell", "x")))).toEqual([size === "120x40" ? "3" : "2"])
    }
    // Where the dialog's own option says it, that takes the words and no copy is added.
    const fetch = need(readOf("webfetch", "120x40"))
    expect(fetch.dialog).toMatchObject({
      options: [{ text: null }, { text: null }, { id: "3", text: "prompt" }],
    })
    expect((fetch.dialog as { options: unknown[] }).options).toHaveLength(3)
    expect(pressed(fetch.keys(choice("3", "use another address")))).toEqual(["3"])
    // Words go only with an option that takes them.
    expect(need(readOf("bash-long", "120x40")).keys(choice("1", "words"))).toBeUndefined()
    expect(need(readOf("bash-long", "120x40")).keys(choice("9", "words"))).toBeUndefined()
  })

  it("shows the words reach the agent as the person's next prompt, after the interrupt", () => {
    for (const name of [
      "k-no-then-prompt",
      "k-no-then-prompt@2.1.291",
      "k-webfetch-no",
      "k-webfetch-no@2.1.291",
    ]) {
      const dialog = need(readOf(name, "120x40"))
      expect(dialog.answered(step(name, "after-no")), name).toBe(true)
      // The box is empty after the No: nothing of a draft is restored into it.
      expect(
        step(name, "after-no").filter((row) => /^❯ ?\S/.test(row)),
        name,
      ).toEqual(["❯ Ask now"])
      expect(scenario(name).prompts?.at(-1), name).toMatch(/^Use /)
    }
  })

  it("offers no copy of No where the screen has no No", () => {
    const rows = swap(screen("bash-long", "120x40"), "3. No", "3. Never")
    const dialog = need(dialogs.read(rows, factsOf("bash-long")))
    expect(dialog.dialog).toMatchObject({ options: [{ id: "1" }, { id: "2" }, { id: "3" }] })
    expect((dialog.dialog as { options: unknown[] }).options).toHaveLength(3)
  })

  it("refuses a dialog that asks about another command, file, address or tool", () => {
    const bash = factsOf("bash-long")
    expect(dialogs.read(screen("bash-long", "120x40"), other(bash, { command: "rm -rf /" }))).toBe(
      undefined,
    )
    expect(dialogs.read(screen("bash-long", "120x40"), other(bash, {}))).toBeUndefined()
    expect(dialogs.read(screen("bash-long", "120x40"), { ...bash, input: undefined })).toBe(
      undefined,
    )
    const write = factsOf("write")
    expect(
      dialogs.read(screen("write", "120x40"), other(write, { file_path: "/project/OTHER.txt" })),
    ).toBeUndefined()
    const fetch = factsOf("webfetch")
    expect(
      dialogs.read(screen("webfetch", "120x40"), other(fetch, { url: "https://evil.example/" })),
    ).toBeUndefined()
    const mcp = factsOf("mcp")
    expect(
      dialogs.read(screen("mcp", "120x40"), { ...mcp, tool: "mcp__other__thing" }),
    ).toBeUndefined()
    // Another kind of request never reads a permission's dialog.
    expect(dialogs.read(screen("mcp", "120x40"), { ...mcp, kind: "question" })).toBeUndefined()
  })

  it("never reads a dialog for a tool it doesn't know, or for the wrong tool", () => {
    const rows = screen("bash-long", "120x40")
    expect(dialogs.read(rows, asks("Read", { file_path: "/home/x/approved.txt" }))).toBeUndefined()
    expect(dialogs.read(rows, asks("Grep", { pattern: "tmp" }))).toBeUndefined()
    expect(dialogs.read(rows, asks("Glob", { pattern: "*.txt", path: "/tmp" }))).toBeUndefined()
    expect(dialogs.read(rows, asks("MultiEdit", { file_path: "approved.txt" }))).toBeUndefined()
    expect(
      dialogs.read(rows, asks("Write", { file_path: "approved.txt", content: "x" })),
    ).toBeUndefined()
    expect(
      dialogs.read(screen("write", "120x40"), asks("Bash", { command: "NEWFILE.txt" })),
    ).toBeUndefined()
  })

  it("compares a command's whitespace as it is, a row break standing for a space or a newline", () => {
    const bash = factsOf("bash-long")
    const command = (bash.input as { command: string }).command
    const reads = (rows: string[], changed: string) =>
      dialogs.read(rows, other(bash, { command: changed })) !== undefined
    for (const size of sizes) {
      const rows = screen("bash-long", size)
      expect(reads(rows, command)).toBe(true)
      // Two spaces where the screen shows one, a newline where it shows a space, no space.
      expect(reads(rows, command.replace("&& echo", "&&  echo"))).toBe(false)
      expect(reads(rows, command.replace("&& echo", "&&\necho"))).toBe(false)
      expect(reads(rows, command.replace("&& echo", "&&echo"))).toBe(false)
      expect(reads(rows, command.replace("touch ", "touch"))).toBe(false)
      expect(reads(rows, command.replace("touch approved", "touch  approved"))).toBe(false)
      expect(reads(rows, `${command} #`)).toBe(false)
      expect(reads(rows, command.slice(0, -4))).toBe(false)
    }
    // At 120 columns the row breaks after "wrap or": there a newline reads as the break.
    expect(
      reads(
        screen("bash-long", "120x40"),
        command.replace("wrap or truncate", "wrap or\ntruncate"),
      ),
    ).toBe(true)
  })

  it("shows what an MCP tool is asked, its arguments as the dialog prints them", () => {
    for (const size of sizes) {
      const dialog = need(readOf("k-mcp-args", size))
      expect(dialog.dialog).toMatchObject({
        title: "Do you want to proceed?",
        detail: 'title: "My title"\nsummary: "Doing things"\nasked: false',
      })
    }
    const mcp = factsOf("k-mcp-args")
    const rows = screen("k-mcp-args", "120x40")
    const withArgs = (args: object) => other(mcp, args)
    const same = { title: "My title", summary: "Doing things", asked: false }
    expect(dialogs.read(rows, withArgs(same))).toBeDefined()
    expect(dialogs.read(rows, withArgs({ ...same, title: "Other" }))).toBeUndefined()
    expect(dialogs.read(rows, withArgs({ ...same, asked: true }))).toBeUndefined()
    expect(
      dialogs.read(rows, withArgs({ title: "My title", summary: "Doing things" })),
    ).toBeUndefined()
    expect(dialogs.read(rows, withArgs({ ...same, extra: 1 }))).toBeUndefined()
    expect(dialogs.read(rows, withArgs({}))).toBeUndefined()
    // The tool's name, exactly: a prefix of it, or another tool's, is no match.
    expect(
      dialogs.read(rows, { ...mcp, tool: "mcp__plugin_novadeck_novadeck__descri" }),
    ).toBeUndefined()
    expect(
      dialogs.read(rows, { ...mcp, tool: "mcp__plugin_novadeck_novadeck__agents" }),
    ).toBeUndefined()
    expect(
      dialogs.read(rows, { ...mcp, tool: "mcp__plugin_novadeck_other__describe" }),
    ).toBeUndefined()
    // A tool without arguments, shown without any, takes no arguments in the request.
    const none = factsOf("mcp")
    expect(dialogs.read(screen("mcp", "120x40"), other(none, { x: 1 }))).toBeUndefined()
    expect(dialogs.read(screen("mcp", "120x40"), none)).toBeDefined()
  })

  it("checks a file's header, its path, and the start of its diff", () => {
    const create = factsOf("write")
    const rows = screen("write", "120x40")
    expect(dialogs.read(rows, { ...create, tool: "Edit" })).toBeUndefined()
    expect(
      dialogs.read(
        rows,
        other(create, { file_path: "<sandbox>/project/NEWFILE.txt", content: "other\n" }),
      ),
    ).toBeUndefined()
    expect(
      dialogs.read(
        rows,
        other(create, {
          file_path: "<sandbox>/project/sub/NEWFILE.txt",
          content: "hello\nworld\n",
        }),
      ),
    ).toBeDefined()
    expect(
      dialogs.read(
        rows,
        other(create, { file_path: "<sandbox>/project/XNEWFILE.txt", content: "hello\nworld\n" }),
      ),
    ).toBeUndefined()
    expect(
      dialogs.read(rows, other(create, { file_path: "<sandbox>/project/NEWFILE.txt" })),
    ).toBeUndefined()
    expect(dialogs.read(swap(rows, "Create file", "Edit file"), create)).toBeUndefined()
    expect(dialogs.read(swap(rows, "create NEWFILE", "overwrite NEWFILE"), create)).toBeUndefined()
    // Over an existing file: its own header and question, and its diff.
    const overwrite = need(readOf("k-write-overwrite", "120x40"))
    expect(overwrite.dialog).toMatchObject({ title: "Do you want to overwrite EXISTING.txt?" })
    expect(readOf("k-write-overwrite", "60x20")).toBeDefined()
    expect(
      dialogs.read(screen("k-write-overwrite", "120x40"), {
        ...factsOf("k-write-overwrite"),
        tool: "Edit",
      }),
    ).toBeUndefined()
    // An Edit: old and new text both lead its diff.
    const edit = factsOf("k-edit-existing")
    const editRows = screen("k-edit-existing", "120x40")
    expect(dialogs.read(editRows, edit)).toBeDefined()
    expect(
      dialogs.read(editRows, other(edit, { ...(edit.input as object), new_string: "other" })),
    ).toBeUndefined()
    expect(
      dialogs.read(editRows, other(edit, { ...(edit.input as object), old_string: "other" })),
    ).toBeUndefined()
    expect(
      dialogs.read(editRows, {
        ...edit,
        tool: "Write",
        input: { file_path: "EXISTING.txt", content: "goodbye" },
      }),
    ).toBeUndefined()
  })

  it("resolves a shown file against the folder Claude Code runs in", () => {
    const create = factsOf("write")
    const rows = screen("write", "120x40")
    const inFolder = (cwd: string | null, file: string): RequestFacts => ({
      ...create,
      cwd,
      input: writing(file),
    })
    // The same name and first line, in another folder, is another request's.
    expect(dialogs.read(rows, inFolder("/work/project", "/other/NEWFILE.txt"))).toBeUndefined()
    expect(
      dialogs.read(rows, inFolder("/work/project", "/work/project/sub/NEWFILE.txt")),
    ).toBeUndefined()
    expect(dialogs.read(rows, inFolder("/work/project", "/work/project/NEWFILE.txt"))).toBeDefined()
    // Without it, the name at a folder boundary is all there is to go by.
    expect(dialogs.read(rows, inFolder(null, "/other/NEWFILE.txt"))).toBeDefined()
    expect(dialogs.read(rows, inFolder(null, "/other/XNEWFILE.txt"))).toBeUndefined()
  })

  it("resolves a shown file against a Windows folder as Windows does", () => {
    const create = factsOf("write")
    const rows = screen("write", "120x40")
    const inFolder = (cwd: string, file: string): RequestFacts => ({
      ...create,
      cwd,
      input: writing(file),
    })
    expect(
      dialogs.read(rows, inFolder("C:/Users/me/proj", "C:/Users/me/proj/NEWFILE.txt")),
    ).toBeDefined()
    expect(
      dialogs.read(rows, inFolder("C:\\Users\\me\\proj", "c:\\users\\me\\proj\\NEWFILE.txt")),
    ).toBeDefined()
    expect(dialogs.read(rows, inFolder("C:/Users/me/proj", "D:/other/NEWFILE.txt"))).toBeUndefined()
    expect(
      dialogs.read(rows, inFolder("C:/Users/me/proj", "C:/Users/me/proj/sub/NEWFILE.txt")),
    ).toBeUndefined()
  })

  it("matches every line the diff shows, not only its first", () => {
    const create = factsOf("write")
    const rows = screen("write", "120x40")
    const writes = (content: string) =>
      dialogs.read(rows, other(create, { file_path: "<sandbox>/project/NEWFILE.txt", content })) !==
      undefined
    expect(writes("hello\nworld\n")).toBe(true)
    // Without a final break it draws as with one: not vouched for. Nor extra blank lines.
    expect(writes("hello\nworld")).toBe(false)
    expect(writes("hello\nworld\n\n\n")).toBe(false)
    expect(writes("hello\nworld\n  \n")).toBe(false)
    expect(writes("hello  \nworld\n")).toBe(false)
    // The same first line, other lines after it, or fewer, or more.
    expect(writes("hello\nmoon\n")).toBe(false)
    expect(writes("hello\n")).toBe(false)
    expect(writes("hello\nworld\nand more\n")).toBe(false)
    expect(writes("hello\n\nworld\n")).toBe(false)
    const over = factsOf("k-write-overwrite")
    const overRows = screen("k-write-overwrite", "120x40")
    const overwrites = (content: string) =>
      dialogs.read(
        overRows,
        other(over, { file_path: (over.input as { file_path: string }).file_path, content }),
      ) !== undefined
    expect(overwrites("brand new\nsecond line\n")).toBe(true)
    expect(overwrites("brand new\nsecond\n")).toBe(false)
    expect(overwrites("brand new\n")).toBe(false)
    const edit = factsOf("k-edit-existing")
    const editRows = screen("k-edit-existing", "120x40")
    const edits = (old_string: string, new_string: string) =>
      dialogs.read(
        editRows,
        other(edit, {
          file_path: (edit.input as { file_path: string }).file_path,
          old_string,
          new_string,
        }),
      ) !== undefined
    expect(edits("hello", "goodbye")).toBe(true)
    // The edit's own text with a line it leaves alone: that line is context, in both.
    expect(edits("hello\nworld", "goodbye")).toBe(false)
    expect(edits("hello\nworld", "goodbye\nworld")).toBe(true)
    expect(edits("hello\nmoon", "goodbye")).toBe(false)
    expect(edits("hello", "goodbye\nmoon")).toBe(false)
    expect(edits("hello", "goodbye\n")).toBe(false)
  })

  it("reads lines longer than the screen, joined from the rows they wrapped onto", () => {
    for (const name of ["k-edit-long-lines", "k-edit-long-lines@2.1.291"]) {
      expect(readOf(name, "120x40"), name).toBeDefined()
      // At 60 columns the diff has pushed its header and subtitle off the screen.
      expect(readOf(name, "60x20"), name).toBeUndefined()
    }
    const facts = factsOf("k-edit-long-lines")
    const input = facts.input as { old_string: string; new_string: string; file_path: string }
    const rows = screen("k-edit-long-lines", "120x40")
    const edits = (changes: object) =>
      dialogs.read(rows, other(facts, { ...input, ...changes })) !== undefined
    // A word changed in the middle of a wrapped line, at the end, or a line dropped.
    expect(edits({})).toBe(true)
    expect(edits({ new_string: input.new_string.replace("new15", "new15x") })).toBe(false)
    expect(edits({ new_string: input.new_string.replace("new29", "new28") })).toBe(false)
    expect(edits({ old_string: input.old_string.replace("old21", "old2") })).toBe(false)
    // A line the edit leaves out of its text, though the screen shows it changed.
    expect(edits({ old_string: "second" })).toBe(false)
  })

  it("never reads a diff whose top has scrolled off, which leaves the file unnamed in full", () => {
    for (const name of [
      "k-edit-large",
      "k-write-large",
      "k-edit-large@2.1.291",
      "k-write-large@2.1.291",
    ]) {
      for (const size of sizes) expect(readOf(name, size), `${name} ${size}`).toBeUndefined()
    }
    // Not for another file of the same name either, with the folder known or not.
    const edit = factsOf("k-edit-large")
    const input = edit.input as { file_path: string }
    for (const [cwd, file] of [
      ["/work/project", "/work/project/BIG.txt"],
      ["/work/project", "/work/project/sub/BIG.txt"],
      [null, "/elsewhere/BIG.txt"],
    ] as const) {
      expect(
        dialogs.read(screen("k-edit-large", "120x40"), {
          ...edit,
          cwd,
          input: { ...input, file_path: file },
        }),
        `${cwd} ${file}`,
      ).toBeUndefined()
    }
  })

  it("reads an edit that shares a line with what it leaves, or changes part of a line", () => {
    for (const name of [
      "k-edit-shared",
      "k-edit-shared@2.1.291",
      "k-edit-partial",
      "k-edit-partial@2.1.291",
    ]) {
      for (const size of sizes) expect(readOf(name, size), `${name} ${size}`).toBeDefined()
    }
    const shared = factsOf("k-edit-shared")
    const rows = screen("k-edit-shared", "120x40")
    const file = (shared.input as { file_path: string }).file_path
    const edits = (facts: RequestFacts, old_string: string, new_string: string, shown = rows) =>
      dialogs.read(shown, other(facts, { file_path: file, old_string, new_string })) !== undefined
    expect(edits(shared, "hello\nworld", "goodbye\nworld")).toBe(true)
    expect(edits(shared, "hello", "goodbye")).toBe(true)
    // Texts the screen doesn't hold, in either side.
    expect(edits(shared, "hello\nmoon", "goodbye\nworld")).toBe(false)
    expect(edits(shared, "hello\nworld", "goodbye\nmoon")).toBe(false)
    expect(edits(shared, "hello", "farewell")).toBe(false)
    // A changed line outside the old text's span: the screen changes more than was asked.
    expect(edits(shared, "world", "world")).toBe(false)
    expect(edits(shared, "hello\nworld", "world")).toBe(false)
    // Nothing changed at all.
    expect(
      edits(
        shared,
        "hello",
        "goodbye",
        swap(swap(rows, "-hello", " hello"), "+goodbye", " goodbye"),
      ),
    ).toBe(false)
    const partial = factsOf("k-edit-partial")
    const partialRows = screen("k-edit-partial", "120x40")
    expect(edits(partial, "hello", "goodbye", partialRows)).toBe(true)
    expect(edits(partial, "say hello there", "say goodbye there", partialRows)).toBe(true)
    expect(edits(partial, "hello there\nnext", "goodbye there\nnext", partialRows)).toBe(true)
    expect(edits(partial, "say hell", "say goodb", partialRows)).toBe(false)
    expect(edits(partial, "hello", "goodbye now", partialRows)).toBe(false)
    expect(edits(partial, "helo", "goodbye", partialRows)).toBe(false)
    expect(
      edits(partial, "hello", "good", swap(partialRows, "+say goodbye there", "+say good there")),
    ).toBe(true)
    expect(
      edits(
        partial,
        "hello",
        "goodbye",
        swap(partialRows, "+say goodbye there", "+say farewell there"),
      ),
    ).toBe(false)
  })

  it("reads an edit only when the diff is exactly the request's change, edge rows included", () => {
    const partial = factsOf("k-edit-partial")
    const file = (partial.input as { file_path: string }).file_path
    const read = (rows: string[], old_string: string, new_string: string) =>
      dialogs.read(rows, other(partial, { file_path: file, old_string, new_string })) !== undefined
    const rows = screen("k-edit-partial", "120x40")
    expect(read(rows, "hello", "goodbye")).toBe(true)
    // A: the edge row also changes elsewhere than the edit.
    expect(read(swap(rows, "+say goodbye there", "+say goodbye here"), "hello", "goodbye")).toBe(
      false,
    )
    // B: only an added line, nothing of the old text removed.
    const alone = rows.filter((row) => !row.includes("-say hello there"))
    expect(read(alone, "hello", "goodbye")).toBe(false)
    // C: the same words around, the rest of the line different.
    const run = swap(
      swap(rows, "say hello there", "run safe-cmd hello"),
      "say goodbye there",
      "run rm -rf / goodbye",
    )
    expect(read(run, "hello", "goodbye")).toBe(false)
    // D: an unrequested change on an edge row of either side, or a context row both share.
    expect(read(swap(rows, " next", " nxt"), "hello", "goodbye")).toBe(true)
    const sides = rows.flatMap((row) => (row.includes("2  next") ? [row, " 3  extra"] : [row]))
    expect(read(sides, "hello", "goodbye")).toBe(true)
    expect(read(swap(rows, "+say goodbye there", "+say goodbye there!"), "hello", "goodbye")).toBe(
      false,
    )
    expect(read(swap(rows, "-say hello there", "-say hello there!"), "hello", "goodbye")).toBe(
      false,
    )
    // H: a leading empty line in the old text does not free the row before it.
    expect(read(rows, "\nhello", "\ngoodbye")).toBe(false)
    // The row before the old text, which begins with a line break, changes by itself.
    const shown = [
      ...rows.slice(
        0,
        rows.findIndex((row) => row.includes("1 -say hello there")),
      ),
      " 1 -aaa",
      " 1 +bbb",
      " 2 -hello",
      " 2 +goodbye",
      ...rows.slice(rows.findIndex((row) => row.includes("2  next"))),
    ]
    expect(read(shown, "hello", "goodbye")).toBe(false)
    expect(read(shown, "\nhello", "\ngoodbye")).toBe(false)
    expect(read(shown, "aaa\nhello", "bbb\ngoodbye")).toBe(true)
  })

  it("refuses every edit whose screen only removes lines, or replaces text by a blank row", () => {
    for (const tag of ["", "@2.1.291"]) {
      for (const size of sizes) {
        // A whole line removed with nothing added is also how a text that begins with a line
        // break, replaced by nothing, is drawn: it joins the lines either side.
        expect(
          readOf("k-edit-delete-line" + tag, size),
          `delete-line${tag} ${size}`,
        ).toBeUndefined()
        // Claude Code takes the line break away with a text it replaces by nothing, and
        // draws a blank row where the line was: that screen is not vouched for.
        expect(
          readOf("k-edit-delete-text" + tag, size),
          `delete-text${tag} ${size}`,
        ).toBeUndefined()
        expect(readOf("k-edit-blank" + tag, size), `blank${tag} ${size}`).toBeUndefined()
      }
    }
    const line = factsOf("k-edit-delete-line")
    const lineRows = screen("k-edit-delete-line", "120x40")
    const text = factsOf("k-edit-delete-text")
    const textRows = screen("k-edit-delete-text", "120x40")
    const edits = (facts: RequestFacts, old_string: string, new_string: string, rows: string[]) =>
      dialogs.read(
        rows,
        other(facts, {
          file_path: (facts.input as { file_path: string }).file_path,
          old_string,
          new_string,
        }),
      ) !== undefined
    for (const [old, fresh] of [
      ["hello\n", ""],
      ["hello", ""],
      ["\nhello", ""],
      ["hello\n", "x"],
      ["hello\nworld\n", ""],
    ]) {
      expect(edits(line, old!, fresh!, lineRows), JSON.stringify([old, fresh])).toBe(false)
    }
    for (const [old, fresh] of [
      ["hello", ""],
      ["hello\n", "\n"],
      ["hello\n", ""],
    ]) {
      expect(edits(text, old!, fresh!, textRows), JSON.stringify([old, fresh])).toBe(false)
    }
  })

  // A screen's frame with its diff rows replaced: the real header, question and options.
  const framed = (diff: string[], from = "k-edit-existing"): string[] => {
    const rows = screen(from, "120x40")
    const open = rows.findIndex((each) => /^╌+$/.test(each))
    const close = rows.findIndex((each, at) => at > open && /^╌+$/.test(each))
    return [...rows.slice(0, open + 1), ...diff, ...rows.slice(close)]
  }
  const editing = (diff: string[], old_string: string, new_string: string): boolean => {
    const base = factsOf("k-edit-existing")
    return (
      dialogs.read(
        framed(diff),
        other(base, {
          file_path: (base.input as { file_path: string }).file_path,
          old_string,
          new_string,
        }),
      ) !== undefined
    )
  }

  it("refuses the drawings that an empty replacement, a joining deletion or a wrap can share", () => {
    // G1: a wrapped removed row and one blank added row is how a long line replaced by
    // nothing is drawn, and the edit deletes the line.
    const wrapped = [
      " 1  a",
      " 2 -alpha beta gamma delta epsilon zeta",
      "   -eta theta iota kappa",
      " 2 +",
      " 3  b",
      " 4  c",
      " 5  d",
    ]
    const long = "alpha beta gamma delta epsilon zeta eta theta iota kappa"
    expect(editing(wrapped, `${long}\n`, "\n")).toBe(false)
    expect(editing(wrapped, long, "")).toBe(false)
    // One added row that starts the removed one, wrapped or not.
    const start = [
      " 1  a",
      " 2 -alpha beta gamma delta epsilon zeta",
      "   -eta theta iota kappa",
      " 2 +alpha beta",
      " 3  b",
      " 4  c",
      " 5  d",
    ]
    expect(editing(start, long, "alpha beta")).toBe(false)
    // The added row runs on past where the removed one wrapped.
    const across = start.map((row) =>
      row === " 2 +alpha beta" ? " 2 +alpha beta gamma delta epsilon zeta eta" : row,
    )
    expect(editing(across, long, "alpha beta gamma delta epsilon zeta eta")).toBe(false)
    // G2: a line removed and none added is how "\nfoo()" replaced by nothing is drawn.
    const joining = [" 1  x = 1", " 2 -foo()", " 2  y = 2", " 3  a", " 4  b", " 5  c"]
    expect(editing(joining, "\nfoo()", "")).toBe(false)
    expect(editing(joining, "foo()\n", "")).toBe(false)
    expect(editing(joining, "x = 1\nfoo()\n", "x = 1\n")).toBe(false)
    // G3: a break inside a wrapped line is a space, unless its row is full.
    const spaced = [
      " 1 -alpha beta gamma",
      "   -kappa lambda",
      " 1 +alpha beta gammaQ",
      "   +kappa lambda",
      " 2  b",
      " 3  c",
      " 4  d",
    ]
    expect(
      editing(spaced, "alpha beta gamma kappa lambda\n", "alpha beta gammaQ kappa lambda\n"),
    ).toBe(true)
    expect(
      editing(spaced, "alpha beta gamma kappa lambda\n", "alpha beta gammaQkappa lambda\n"),
    ).toBe(false)
    expect(
      editing(spaced, "alpha beta gammakappa lambda\n", "alpha beta gammaQ kappa lambda\n"),
    ).toBe(false)
    // A word wider than the screen breaks where its row is full, with no space.
    const word = "Q".repeat(200)
    const full = [
      ` 1 -${word.slice(0, 116)}`,
      `   -${word.slice(116)}`,
      ` 1 +${"R".repeat(116)}`,
      `   +${"R".repeat(84)}`,
      " 2  b",
      " 3  c",
      " 4  d",
    ]
    expect(full[0]!.length).toBe(120)
    expect(editing(full, word, "R".repeat(200))).toBe(true)
    // The same break in rows that are not full is not one inside a word.
    const short = [" 1 -aaaa", "   -bbbb", " 1 +cccc", "   +dddd", " 2  b", " 3  c", " 4  d"]
    expect(editing(short, "aaaa bbbb\n", "cccc dddd\n")).toBe(true)
    expect(editing(short, "aaaabbbb\n", "cccc dddd\n")).toBe(false)
  })

  it("reads written text only where it can be told from what draws the same", () => {
    const overwrite = factsOf("k-write-overwrite")
    const file = (overwrite.input as { file_path: string }).file_path
    const rows = screen("k-write-overwrite", "120x40")
    const writes = (content: string) =>
      dialogs.read(rows, other(overwrite, { file_path: file, content })) !== undefined
    expect(writes("brand new\nsecond line\n")).toBe(true)
    for (const content of [
      "brand new\nsecond line",
      "brand new\nsecond line\n\n\n",
      "brand new\nsecond line  \n",
      "brand new\nsecond line\n \n\t\n",
    ]) {
      expect(writes(content), JSON.stringify(content)).toBe(false)
    }
    const create = factsOf("write")
    const createRows = screen("write", "120x40")
    const creates = (content: string) =>
      dialogs.read(
        createRows,
        other(create, { file_path: "<sandbox>/project/NEWFILE.txt", content }),
      ) !== undefined
    expect(creates("hello\nworld\n")).toBe(true)
    for (const content of ["hello\nworld", "hello\nworld\n\n\n", "hello\nworld\n  \n"]) {
      expect(creates(content), JSON.stringify(content)).toBe(false)
    }
    // Claude Code's own screens for text written without a final break or with blank lines
    // at its end: the first draws as with a break (create), or with a row that says it.
    for (const name of ["k-write-nonl", "k-write-over-nonl"]) {
      for (const tag of ["", "@2.1.291"])
        expect(readOf(name + tag, "120x40"), name + tag).toBeUndefined()
    }
  })

  // The screen of an edit of EXISTING.txt, as its dialog draws it: the plain replacement
  // diffed line by line, one hunk with three lines of context either side, the numbers
  // right-aligned, and a row where a text has no final line break.
  const drawEdit = (file: string, old: string, fresh: string): string[] | undefined => {
    if (old === "" || file.indexOf(old) < 0 || file.indexOf(old) !== file.lastIndexOf(old)) {
      return undefined
    }
    const changed = file.replace(old, () => fresh)
    if (changed === file) return undefined
    const before = linesOfText(file)
    const after = linesOfText(changed)
    // A longest-common-subsequence line diff.
    const table = Array.from({ length: before.length + 1 }, () =>
      Array.from({ length: after.length + 1 }, () => 0),
    )
    for (let i = before.length - 1; i >= 0; i--) {
      for (let j = after.length - 1; j >= 0; j--) {
        table[i]![j] =
          before[i] === after[j]
            ? table[i + 1]![j + 1]! + 1
            : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
      }
    }
    const ops: { marker: string; text: string; number: number }[] = []
    let i = 0
    let j = 0
    while (i < before.length || j < after.length) {
      if (i < before.length && j < after.length && before[i] === after[j]) {
        ops.push({ marker: " ", text: before[i]!, number: i + 1 })
        i++
        j++
      } else if (
        j < after.length &&
        (i === before.length || table[i]![j + 1]! >= table[i + 1]![j]!)
      ) {
        ops.push({ marker: "+", text: after[j]!, number: j + 1 })
        j++
      } else {
        ops.push({ marker: "-", text: before[i]!, number: i + 1 })
        i++
      }
    }
    // jsdiff lists a change's removed rows, then its added ones.
    const ordered: typeof ops = []
    for (let at = 0; at < ops.length;) {
      if (ops[at]!.marker === " ") ordered.push(ops[at++]!)
      else {
        const run: typeof ops = []
        while (at < ops.length && ops[at]!.marker !== " ") run.push(ops[at++]!)
        ordered.push(
          ...run.filter(({ marker }) => marker === "-"),
          ...run.filter(({ marker }) => marker === "+"),
        )
      }
    }
    const firstChange = ordered.findIndex(({ marker }) => marker !== " ")
    const lastChange = ordered.findLastIndex(({ marker }) => marker !== " ")
    const hunk = ordered.slice(Math.max(0, firstChange - 3), lastChange + 4)
    const width = String(Math.max(...hunk.map(({ number }) => number))).length
    const frame = screen("k-edit-existing", "120x40")
    const cols = frame.find((each) => /^╌+$/.test(each))!.length
    const diff = hunk.flatMap(({ marker, text, number }) =>
      wrapRow(
        ` ${String(number).padStart(width)} ${marker}`,
        text.replace(/^\t+/, (tabs) => "  ".repeat(tabs.length)),
        cols,
      ),
    )
    if (!file.endsWith("\n") && lastChange + 4 >= ordered.length) {
      diff.push(
        ` ${String(Math.max(...hunk.map(({ number }) => number)) + 1).padStart(width)}   No newline at end of file`,
      )
    }
    const rows = screen("k-edit-existing", "120x40")
    const open = rows.findIndex((each) => /^╌+$/.test(each))
    const close = rows.findIndex((each, at) => at > open && /^╌+$/.test(each))
    return [...rows.slice(0, open + 1), ...diff, ...rows.slice(close)]
  }
  const editAsks = (old_string: string, new_string: string): RequestFacts => {
    const base = factsOf("k-edit-existing")
    return other(base, {
      file_path: (base.input as { file_path: string }).file_path,
      old_string,
      new_string,
    })
  }

  const tail = "\nc1\nc2\nc3\nc4\n"

  it("never reads a unique request in another place, however its text is normalised", () => {
    // The real screen draws one line, mid-way; a text with a break after it is not that.
    const partial = factsOf("k-edit-partial")
    const rows = screen("k-edit-partial", "120x40")
    const file = (partial.input as { file_path: string }).file_path
    const reads = (changes: object) =>
      dialogs.read(rows, other(partial, { file_path: file, ...changes })) !== undefined
    expect(reads({ old_string: "hello", new_string: "goodbye" })).toBe(true)
    expect(reads({ old_string: "hello\n", new_string: "goodbye\n" })).toBe(false)
    expect(reads({ old_string: "say hello\n", new_string: "say goodbye\n" })).toBe(false)
    expect(reads({ old_string: "hello\n", new_string: "goodbye\n", replace_all: true })).toBe(false)
    // Mid-file, "hello\n" is a whole line and its replacement draws the same rows as the
    // line alone; with another line after it that is the same edit.
    const middle = drawEdit(`a\nhello\nb${tail}`, "hello", "goodbye")!
    expect(dialogs.read(middle, editAsks("hello\n", "goodbye\n")) !== undefined).toBe(true)
    // But not "hello\n" for a line that has more after hello.
    const longer = drawEdit(`a\nhello there\nb${tail}`, "hello", "goodbye")!
    expect(dialogs.read(longer, editAsks("hello\n", "goodbye\n"))).toBeUndefined()
    // Blanks before a line break: not drawn, and not read.
    const twice = drawEdit(
      `rm_old)\ndone()\nx\nrm_old)\ndone()!${tail}`,
      "rm_old)\ndone()!",
      "rm_new)\ndone()!",
    )!
    expect(
      dialogs.read(twice, editAsks("rm_old)\ndone()!", "rm_new)\ndone()!")) !== undefined,
    ).toBe(true)
    expect(dialogs.read(twice, editAsks("rm_old) \ndone()!", "rm_new) \ndone()!"))).toBeUndefined()
    expect(dialogs.read(twice, editAsks("rm_old)\ndone()!", "rm_new)\ndone()! \n"))).toBeUndefined()
    // Tabs drawn as two spaces do not move an edit to where two spaces stand.
    const indented = drawEdit(`a\n  foo\nb\n\tfoo\nc${tail}`, "\tfoo", "\tbar")!
    expect(dialogs.read(indented, editAsks("\tfoo", "\tbar")) !== undefined).toBe(true)
    expect(dialogs.read(indented, editAsks("  foo\nb", "  bar\nb"))).toBeUndefined()
    const mixed = drawEdit(`\tx\n  y\nz\n  y\n\tx${tail}`, "  y\nz", "  w\nz")!
    expect(dialogs.read(mixed, editAsks("\ty\nz", "\tw\nz"))).toBeDefined()
  })

  it("refuses a change that reaches the end of the file, and a file's missing final newline", () => {
    // Claude Code's real screens: the last line edited, with and without a final newline.
    for (const tag of ["", "@2.1.291"]) {
      for (const size of sizes) {
        for (const name of ["k-edit-nonl-last", "k-edit-nonl-mid", "k-edit-nonl-line"]) {
          expect(readOf(name + tag, size), `${name}${tag} ${size}`).toBeUndefined()
        }
      }
    }
    const last = screen("k-edit-nonl-last", "120x40")
    expect(last.some((row) => row.includes("No newline at end of file"))).toBe(true)
    // A: the text "x\n" is not "x = x" with its break dropped, nor a change at the end.
    const one = drawEdit("a\nx = x\n", "x = x", "y = x")!
    expect(dialogs.read(one, editAsks("x = x", "y = x"))).toBeUndefined()
    expect(dialogs.read(one, editAsks("x\n", "y\n"))).toBeUndefined()
    // The same with lines after the change: read, and still not for "x\n".
    const mid = drawEdit(`a\nx = x${tail}`, "x = x", "y = x")!
    expect(dialogs.read(mid, editAsks("x = x", "y = x")) !== undefined).toBe(true)
    expect(dialogs.read(mid, editAsks("x\n", "y\n"))).toBeUndefined()
    const two = drawEdit(`a\nb = b${tail}`, "b = b", "c = b")!
    expect(dialogs.read(two, editAsks("b\n", "c\n"))).toBeUndefined()
    // B: a blank line at the end of the text, and the text not where the screen has the edit.
    const long = drawEdit(`k\nfoo()\n\nz\nfoo()\nend${tail}`, "foo()\nend", "bar()\nend")!
    expect(dialogs.read(long, editAsks("foo()\nend", "bar()\nend")) !== undefined).toBe(true)
    expect(dialogs.read(long, editAsks("foo()\n\n", "bar()\n\n"))).toBeUndefined()
    // Fewer than three rows of context after the change: it may be the end of the file.
    const shortTail = drawEdit("a\nhello\nb\nc\n", "hello", "goodbye")!
    expect(dialogs.read(shortTail, editAsks("hello", "goodbye"))).toBeUndefined()
    const three = drawEdit("a\nhello\nb\nc\nd\ne\n", "hello", "goodbye")!
    expect(dialogs.read(three, editAsks("hello", "goodbye")) !== undefined).toBe(true)
    // An empty replacement of a text takes its line's break: drawn as a blank row.
    const gone = drawEdit(`a\nhello\nb${tail}`, "hello", "")!
    expect(dialogs.read(gone, editAsks("hello", ""))).toBeUndefined()
    expect(dialogs.read(gone, editAsks("hello\n", "\n"))).toBeUndefined()
    expect(dialogs.read(gone, editAsks("hello\n", ""))).toBeUndefined()
    // One added row that is the start of the removed row draws like an empty replacement.
    const prefix = drawEdit(`a\nsay hello${tail}`, "say hello", "say")!
    expect(dialogs.read(prefix, editAsks("say hello", "say"))).toBeUndefined()
    // A whole line removed, its break and all, is drawn like a joining deletion: refused.
    const removed = drawEdit(`a\nhello\nb${tail}`, "hello\n", "")!
    expect(dialogs.read(removed, editAsks("hello\n", ""))).toBeUndefined()
  })

  it("never accepts one request's diff for another's, judged by what each does to the file", () => {
    let seed = 12_345
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return Math.floor(seed / 65_536) % n
    }
    // Lines that wrap, one of them a single word wider than the screen.
    const LONG =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau"
    const WORD = "Q".repeat(150)
    // A line that wraps at a space, and the same line with that space left out.
    const TWICE = `${LONG} ${LONG}`
    const cut = TWICE.lastIndexOf(" ", 116)
    const SQUASHED = TWICE.slice(0, cut) + TWICE.slice(cut + 1)
    const words = [
      "a",
      "b",
      "rm_old)",
      "done()",
      "x y",
      "hello",
      "foo",
      "  indented",
      "\tabbed",
      "",
      "end",
      "x = x",
      "b = b",
      "foo()",
      "z",
      "k",
      LONG,
      WORD,
      TWICE,
      SQUASHED,
    ]
    const pick = <T>(items: readonly T[]): T => items[next(items.length)]!
    let accepted = 0
    let compared = 0
    for (let round = 0; round < 200; round++) {
      // Half the files number their lines, so that short texts are unique in them.
      const numbered = next(2) === 0
      const file =
        Array.from(
          { length: 3 + next(6) },
          (_, at) => pick(words) + (numbered ? `~${at}` : ""),
        ).join("\n") + pick(["", "\n", tail, tail, tail.slice(0, -1)])
      const edits: { old: string; fresh: string; rows: string[] }[] = []
      for (let tries = 0; tries < 60 && edits.length < 12; tries++) {
        // Anywhere, ending at the last line, a whole line with or without its break.
        const start = next(file.length)
        const how = next(8)
        const lineStart = file.lastIndexOf("\n", start - 1) + 1
        const lineEnd = file.indexOf("\n", start)
        const old =
          how === 0
            ? file.slice(Math.max(0, file.length - 1 - next(12)))
            : how === 1
              ? file.slice(lineStart, lineEnd < 0 ? file.length : lineEnd + 1)
              : how === 2
                ? file.slice(lineStart, lineEnd < 0 ? file.length : lineEnd)
                : how === 3
                  ? // The break before a line with the line, which joins its neighbours.
                    file.slice(Math.max(0, lineStart - 1), lineEnd < 0 ? file.length : lineEnd)
                  : how === 4
                    ? file.slice(lineStart, lineStart + 1 + next(60))
                    : how >= 6
                      ? // Part of one line, the commonest edit.
                        file.slice(
                          start,
                          Math.min(start + 3 + next(6), lineEnd < 0 ? file.length : lineEnd),
                        )
                      : file.slice(start, start + 1 + next(24))
        // Also the same text with a letter changed, so that edits of one place look alike.
        const fresh = pick([
          "",
          "",
          "z",
          "hello",
          "foo\nbar",
          "\n",
          "a\nb\nc",
          "x y",
          " ",
          "\tq",
          pick(words) + pick(words),
          old.replace(/[a-z]/, "y"),
          old.replace(/[a-z]/, "y"),
          old.replace(/[a-z]/, "y"),
          old.replace(/ /, ""),
          old.replace(/ /, "  "),
          // The start of the text, as a replacement that leaves the rest out.
          old.slice(0, Math.max(1, next(old.length + 1))),
          old.slice(0, Math.max(1, next(old.length + 1))),
        ])
        if (old.trim() === "" || blanksBefore(old) || blanksBefore(fresh)) continue
        const rows = drawEdit(file, old, fresh)
        if (rows && effect(file, old, fresh) !== undefined) edits.push({ old, fresh, rows })
      }
      for (const [i, one] of edits.entries()) {
        const effectOne = effect(file, one.old, one.fresh)
        // The request that drew the screen reads it, where it can: count how often.
        if (dialogs.read(one.rows, editAsks(one.old, one.fresh)) !== undefined) accepted++
        for (const [j, two] of edits.entries()) {
          if (i === j) continue
          compared++
          if (dialogs.read(one.rows, editAsks(two.old, two.fresh)) !== undefined) {
            // Only where the other request does to the file what this one does.
            // oxlint-disable-next-line vitest/no-conditional-expect -- Only the pairs that agree are checked.
            expect(
              effect(file, two.old, two.fresh),
              `${JSON.stringify(file)} ${JSON.stringify([one.old, one.fresh])} / ${JSON.stringify([two.old, two.fresh])}`,
            ).toBe(effectOne)
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1000)
    expect(accepted).toBeGreaterThan(50)
  })

  it("never accepts one written text's screen for another's", () => {
    let seed = 777
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return Math.floor(seed / 65_536) % n
    }
    const words = ["a", "b", "", "  x", "x y", "\ttab", "end", " ", "Q".repeat(130)]
    const pick = <T>(items: readonly T[]): T => items[next(items.length)]!
    const create = factsOf("write")
    const base = screen("write", "120x40")
    const cols = base.find((each) => /^╌+$/.test(each))!.length
    const drawCreate = (content: string): string[] => {
      const lines = content.split("\n")
      if (content.endsWith("\n")) lines.pop()
      const width = String(lines.length).length
      const diff = lines.flatMap((text, at) =>
        wrapRow(
          `  ${String(at + 1).padStart(width)} `.slice(-(width + 3)).padStart(width + 3),
          text.replace(/^\t+/, (tabs) => " ".repeat(8 * tabs.length)),
          cols,
        ),
      )
      const open = base.findIndex((each) => /^╌+$/.test(each))
      const close = base.findIndex((each, at) => at > open && /^╌+$/.test(each))
      return [...base.slice(0, open + 1), ...diff, ...base.slice(close)]
    }
    let accepted = 0
    for (let round = 0; round < 60; round++) {
      const texts = Array.from({ length: 10 }, () => {
        const lines = Array.from({ length: 1 + next(4) }, () => pick(words)).join("\n")
        return lines + pick(["\n", "\n", "", "\n\n", "\n\n\n", "  \n", "\n \n"])
      })
      for (const one of texts) {
        // A text the adapter itself would not vouch for (no final break, or blanks before
        // one) draws like another that it does: that ambiguity is the screen's, not read.
        if (!one.endsWith("\n") || blanksBefore(one)) continue
        const rows = drawCreate(one)
        for (const two of texts) {
          if (
            dialogs.read(
              rows,
              other(create, { file_path: "<sandbox>/project/NEWFILE.txt", content: two }),
            ) !== undefined
          ) {
            if (two === one) accepted++
            // Only what draws this very screen, and then it is the same text.
            // oxlint-disable-next-line vitest/no-conditional-expect -- Only the pairs that draw it are checked.
            expect(two, JSON.stringify([one, two])).toBe(one)
          }
        }
      }
    }
    expect(accepted).toBeGreaterThan(20)
  })

  it("stays fast on long blanks, long texts and large screens", () => {
    const shared = factsOf("k-edit-shared")
    const rows = screen("k-edit-shared", "120x40")
    const file = (shared.input as { file_path: string }).file_path
    const edit = (old_string: string, new_string: string, shown = rows) =>
      dialogs.read(shown, other(shared, { file_path: file, old_string, new_string }))
    for (const blank of [
      " ".repeat(100_000),
      "\t".repeat(100_000),
      " ".repeat(60_000) + "\n" + " ".repeat(2000),
    ]) {
      expect(
        time(() => edit(blank, "x")),
        "blank",
      ).toBeLessThan(100)
      expect(
        time(() => edit("hello", blank)),
        "blank new",
      ).toBeLessThan(100)
      expect(
        time(() => edit(`x${blank}\nhello`, "y")),
        "blank before",
      ).toBeLessThan(100)
      expect(
        time(() =>
          dialogs.read(
            screen("write", "120x40"),
            other(factsOf("write"), { file_path: "<sandbox>/project/NEWFILE.txt", content: blank }),
          ),
        ),
        "content",
      ).toBeLessThan(100)
    }
    // A large synthetic diff: thousands of rows, a repeated word everywhere.
    const big = [
      ...rows.slice(
        0,
        rows.findIndex((row) => row.startsWith(" 1 -hello")),
      ),
      ...Array.from({ length: 3000 }, (_, i) => ` ${i + 1}  hello hello hello`),
      " 3001 -hello hello",
      " 3001 +goodbye goodbye",
      ...Array.from({ length: 3000 }, (_, i) => ` ${i + 3002}  hello hello hello`),
      ...rows.slice(rows.findIndex((row) => row.includes("Do you want to")) - 1),
    ]
    expect(
      time(() => edit("hello hello", "goodbye goodbye", big)),
      "big",
    ).toBeLessThan(500)
    expect(
      time(() => edit("hello", "goodbye", big)),
      "big short",
    ).toBeLessThan(500)
  })

  it("returns promptly for an old text of only blanks, and never reads it", () => {
    const shared = factsOf("k-edit-shared")
    const rows = screen("k-edit-shared", "120x40")
    const file = (shared.input as { file_path: string }).file_path
    const started = Date.now()
    for (const old_string of ["  ", "\t", " \t ", "\n", " \n", "\n\n", "   \n  "]) {
      for (const new_string of ["x", "", "\n", "  \n", "goodbye\n"]) {
        expect(
          dialogs.read(rows, other(shared, { file_path: file, old_string, new_string })),
          JSON.stringify([old_string, new_string]),
        ).toBeUndefined()
      }
    }
    for (const name of ["k-edit-delete-line", "k-edit-blank", "k-edit-partial"]) {
      const facts = factsOf(name)
      for (const old_string of [" ", "\n ", " \n"]) {
        dialogs.read(
          screen(name, "120x40"),
          other(facts, { file_path: file, old_string, new_string: "\n" }),
        )
      }
    }
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it("keeps trailing whitespace that isn't before a line break", () => {
    const partial = factsOf("k-edit-partial")
    const file = (partial.input as { file_path: string }).file_path
    const rows = screen("k-edit-partial", "120x40")
    const read = (old_string: string, new_string: string, shown = rows) =>
      dialogs.read(shown, other(partial, { file_path: file, old_string, new_string })) !== undefined
    expect(read("hello", "goodbye")).toBe(true)
    // Each of these would leave the line other than the screen shows.
    expect(read("hello ", "goodbye")).toBe(false)
    expect(read("hello", "goodbye ")).toBe(false)
    expect(read("hello", "goodbye\t")).toBe(false)
    expect(read("hello\t", "goodbye")).toBe(false)
    // And the screens those would draw, which are not this one.
    expect(read("hello ", "goodbye", swap(rows, "+say goodbye there", "+say goodbyethere"))).toBe(
      true,
    )
    expect(read("hello", "goodbye ", swap(rows, "+say goodbye there", "+say goodbye  there"))).toBe(
      true,
    )
    // Before a line break it is never drawn, so a text with it is not read.
    const shared = factsOf("k-edit-shared")
    const sharedRows = screen("k-edit-shared", "120x40")
    const at = (old_string: string, new_string: string) =>
      dialogs.read(
        sharedRows,
        other(shared, {
          file_path: (shared.input as { file_path: string }).file_path,
          old_string,
          new_string,
        }),
      ) !== undefined
    expect(at("hello  \nworld", "goodbye\nworld")).toBe(false)
    expect(at("hello\nworld", "goodbye \nworld")).toBe(false)
  })

  it("draws leading tabs as the diff does: two spaces in an edit, eight in a new file", () => {
    for (const tag of ["", "@2.1.291"]) {
      for (const size of sizes) {
        for (const name of ["k-edit-tabs", "k-write-tabs", "k-write-tabs-over"]) {
          expect(readOf(name + tag, size), `${name}${tag} ${size}`).toBeDefined()
        }
      }
    }
    const edit = factsOf("k-edit-tabs")
    const editRows = screen("k-edit-tabs", "120x40")
    const file = (edit.input as { file_path: string }).file_path
    const edits = (old_string: string, new_string: string) =>
      dialogs.read(editRows, other(edit, { file_path: file, old_string, new_string })) !== undefined
    expect(edits("\t\thello();", "\t\tgoodbye();")).toBe(true)
    expect(edits("    hello();", "    goodbye();")).toBe(true)
    // One tab less ends where the line's own text begins: a substring of the same line.
    expect(edits("\thello();", "\tgoodbye();")).toBe(true)
    expect(edits("\t\thello();", "\t\t\tgoodbye();")).toBe(false)
    // Tabs inside a line are not leading ones, and are drawn as they are.
    expect(edits("\t\thello();", "\t\tgood\tbye();")).toBe(false)
    const create = factsOf("k-write-tabs")
    const writes = (content: string, tool = create) =>
      dialogs.read(
        screen("k-write-tabs", "120x40"),
        other(tool, { file_path: (create.input as { file_path: string }).file_path, content }),
      ) !== undefined
    expect(writes("a\n\tb\n\t\tc\n")).toBe(true)
    expect(writes("a\n  b\n    c\n")).toBe(false)
    const over = factsOf("k-write-tabs-over")
    const overwrites = (content: string) =>
      dialogs.read(
        screen("k-write-tabs-over", "120x40"),
        other(over, { file_path: (over.input as { file_path: string }).file_path, content }),
      ) !== undefined
    expect(overwrites("a\n\tb\n\t\tc\n")).toBe(true)
    expect(overwrites("a\n        b\n                c\n")).toBe(false)
  })

  it("reads an edit of long wrapped prose without limit, context included", () => {
    for (const tag of ["", "@2.1.291"]) {
      expect(readOf("k-edit-prose" + tag, "120x40"), tag).toBeDefined()
      expect(readOf("k-edit-prose" + tag, "60x20"), tag).toBeUndefined()
    }
    const prose = factsOf("k-edit-prose")
    const input = prose.input as { file_path: string; old_string: string; new_string: string }
    const rows = screen("k-edit-prose", "120x40")
    const edits = (changes: object, shown = rows) =>
      dialogs.read(shown, other(prose, { ...input, ...changes })) !== undefined
    expect(edits({})).toBe(true)
    expect(edits({ new_string: input.new_string.replace("dos20", "dos2x") })).toBe(false)
    expect(edits({ old_string: input.old_string.replace("one7", "one7x") })).toBe(false)
    expect(edits({ new_string: input.new_string.replace("uno0", "uno0 ") })).toBe(false)
    // The wrapped context line after the edit is the same in both sides, however it broke.
    expect(
      edits({
        old_string: input.old_string.split("\n")[0]!,
        new_string: input.new_string.split("\n")[0]!,
      }),
    ).toBe(false)
  })

  it("never reads an edit that replaces every occurrence, which no screen can show", () => {
    const all = factsOf("k-edit-replace-all")
    // Three occurrences drawn as three hunks.
    expect(dialogs.read(screen("k-edit-replace-all", "120x40"), all)).toBeUndefined()
    expect(readOf("k-edit-replace-all", "120x40")).toBeUndefined()
    // Even a screen of one hunk: the others may stand untouched in the context.
    const shared = factsOf("k-edit-shared")
    const file = (shared.input as { file_path: string }).file_path
    const rows = screen("k-edit-shared", "120x40")
    const reads = (changes: object, shown = rows) =>
      dialogs.read(
        shown,
        other(shared, { file_path: file, old_string: "hello", new_string: "goodbye", ...changes }),
      ) !== undefined
    expect(reads({})).toBe(true)
    expect(reads({ replace_all: false })).toBe(true)
    expect(reads({ replace_all: true })).toBe(false)
    const untouched = drawEdit("foo() + foo()\nfoo()", "foo() + foo()", "bar() + foo()")!
    const asAll = other(factsOf("k-edit-existing"), {
      file_path: (factsOf("k-edit-existing").input as { file_path: string }).file_path,
      old_string: "foo()",
      new_string: "bar()",
      replace_all: true,
    })
    expect(dialogs.read(untouched, asAll)).toBeUndefined()
  })

  it("tells a wrapped row that begins with digits and a marker from a numbered line", () => {
    const prose = factsOf("k-edit-prose")
    const rows = screen("k-edit-prose", "120x40")
    const mutated = rows.map((row) =>
      row.includes("   5 three16") ? row.replace("5 three16", "5 -three16") : row,
    )
    expect(mutated).not.toEqual(rows)
    expect(dialogs.read(mutated, prose)).toBeDefined()
    // The same with a plus, and a number that would follow the one before.
    const plus = rows.map((row) =>
      row.includes("   5 three16") ? row.replace("5 three16", "4 +three16") : row,
    )
    expect(dialogs.read(plus, prose)).toBeDefined()
  })

  it("resolves the subtitle against the folder, and the question against the file's own name", () => {
    for (const name of ["k-edit-sub", "k-edit-sub@2.1.291"]) {
      for (const size of sizes) expect(readOf(name, size), `${name} ${size}`).toBeDefined()
    }
    for (const name of ["k-write-outside", "k-write-outside@2.1.291"]) {
      for (const size of sizes) {
        const base = factsOf(name)
        const facts = {
          ...base,
          cwd: "/tmp/sbx/project",
          input: { ...(base.input as object), file_path: "/tmp/sbx/outside/OUT.txt" },
        }
        expect(dialogs.read(screen(name, size), facts), `${name} ${size}`).toBeDefined()
      }
    }
    const sub = factsOf("k-edit-sub")
    const rows = screen("k-edit-sub", "120x40")
    const at = (cwd: string | null, file: string) =>
      dialogs.read(rows, {
        ...sub,
        cwd,
        input: { file_path: file, old_string: "hello", new_string: "goodbye" },
      }) !== undefined
    expect(at("/tmp/sbx/project", "/tmp/sbx/project/sub/INNER.txt")).toBe(true)
    // The same name under another folder, or a folder level too many or few.
    expect(at("/tmp/sbx/project", "/tmp/sbx/project/other/INNER.txt")).toBe(false)
    expect(at("/tmp/sbx/project", "/tmp/sbx/project/INNER.txt")).toBe(false)
    expect(at("/tmp/sbx/project", "/tmp/sbx/project/a/sub/INNER.txt")).toBe(false)
    expect(at("/tmp/sbx/project", "/elsewhere/sub/INNER.txt")).toBe(false)
    // Without the folder the subtitle's whole relative path must end the request's.
    expect(at(null, "/any/where/sub/INNER.txt")).toBe(true)
    expect(at(null, "/any/where/INNER.txt")).toBe(false)
    expect(
      dialogs.read(swap(rows, "make this edit to INNER.txt", "make this edit to OTHER.txt"), sub),
    ).toBeUndefined()
    // A write outside the project is shown relative with ../ from the folder.
    const out = factsOf("k-write-outside")
    const outRows = screen("k-write-outside", "120x40")
    const written = (cwd: string | null, file: string) =>
      dialogs.read(outRows, { ...out, cwd, input: { file_path: file, content: "out\n" } }) !==
      undefined
    expect(written("/tmp/sbx/project", "/tmp/sbx/outside/OUT.txt")).toBe(true)
    expect(written("/tmp/sbx/project", "/tmp/sbx/project/OUT.txt")).toBe(false)
    expect(written("/tmp/sbx/project", "/tmp/sbx/other/OUT.txt")).toBe(false)
  })

  it("is answered only by the prompt coming back, not by a dialog that fails to read", () => {
    const dialog = need(readOf("bash-long", "120x40"))
    const after = step("bash-long", "after")
    expect(dialog.answered(after)).toBe(true)
    // A half-drawn frame: the dialog gone, nothing else yet.
    expect(dialog.answered(after.filter((row) => !row.startsWith("❯") && !/^─+$/.test(row)))).toBe(
      false,
    )
    expect(dialog.answered(screen("bash-long", "120x40").slice(0, 20))).toBe(false)
    expect(dialog.answered([])).toBe(false)
    expect(dialog.answered(swap(screen("bash-long", "120x40"), "Do you want", "Shall we"))).toBe(
      false,
    )
  })

  it("refuses a screen without a dialog, or with a changed one", () => {
    const facts = factsOf("write")
    expect(dialogs.read(step("write", "after"), facts)).toBeUndefined()
    const rows = screen("write", "120x40")
    const mutations: { [name: string]: (rows: string[]) => string[] } = {
      "a changed question": (all) => all.map((row) => row.replace("Do you want to", "Shall we")),
      "a different marker glyph": (all) => all.map((row) => row.replace("❯ 1.", "> 1.")),
      "a second marker": (all) => all.map((row) => row.replace("  3. No", "❯ 3. No")),
      "an extra option out of numbering": (all) =>
        all.flatMap((row) => (row.startsWith("   3. No") ? [row, "   5. Maybe"] : [row])),
      "numbers that skip": (all) => all.map((row) => row.replace("   3. No", "   4. No")),
      "an unknown footer": (all) => [...all, " Press q to quit"],
      "a changed footer": (all) =>
        all.map((row) => row.replace("Esc to cancel · Tab to amend", "Esc to cancel")),
    }
    for (const [name, mutate] of Object.entries(mutations)) {
      expect(dialogs.read(mutate(rows), facts), name).toBeUndefined()
    }
  })
})

describe("Claude Code's Edit permission", () => {
  it.each(sizes)("reads it, with its diff, at %s", (size) => {
    const dialog = need(readOf("k-edit-existing", size))
    expect(dialog.dialog).toMatchObject({
      title: "Do you want to make this edit to EXISTING.txt?",
      options: [{ id: "1" }, { id: "2" }, { id: "3", label: "No" }, { id: "tell", text: "prompt" }],
    })
    expect(pressed(dialog.keys(choice("1")))).toEqual(["1"])
  })

  it("refuses it for another file", () => {
    const facts = factsOf("k-edit-existing")
    const rows = screen("k-edit-existing", "120x40")
    expect(
      dialogs.read(rows, { ...facts, input: { file_path: "<sandbox>/project/OTHER.txt" } }),
    ).toBeUndefined()
    expect(dialogs.read(swap(rows, "EXISTING.txt", "RENAMED.txt"), facts)).toBeUndefined()
  })
})

describe("Claude Code's Read permission", () => {
  it.each(sizes)("reads it, with its path as detail, at %s", (size) => {
    const dialog = need(readOf("k-read-outside", size))
    expect(dialog.dialog).toMatchObject({
      title: "Do you want to proceed?",
      detail: expect.stringContaining("Read(<sandbox>/outside/notes.txt)"),
      options: [{ id: "1" }, { id: "2" }, { id: "3", label: "No" }, { id: "tell", text: "prompt" }],
    })
    expect(pressed(dialog.keys(choice("1")))).toEqual(["1"])
  })

  it("refuses it for another file, extra arguments, or a changed header", () => {
    const facts = factsOf("k-read-outside")
    const rows = screen("k-read-outside", "120x40")
    const path = (facts.input as { file_path: string }).file_path
    expect(dialogs.read(rows, other(facts, { file_path: `${path}x` }))).toBeUndefined()
    expect(dialogs.read(rows, other(facts, { file_path: "/other/notes.txt" }))).toBeUndefined()
    expect(dialogs.read(rows, other(facts, { file_path: path, offset: 1 }))).toBeUndefined()
    expect(dialogs.read(swap(rows, "Read file", "Open file"), facts)).toBeUndefined()
    expect(dialogs.read(swap(rows, "Read(", "Get("), facts)).toBeUndefined()
    expect(dialogs.read(rows, { ...facts, tool: "Glob" })).toBeUndefined()
    expect(dialogs.read(rows, { ...facts, tool: "Grep" })).toBeUndefined()
  })
})
