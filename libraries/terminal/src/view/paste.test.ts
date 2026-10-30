import { afterEach, describe as context, describe, expect, it, vi } from "vitest"

import {
  ownPath,
  pastedFiles,
  pastedText,
  pastesImages,
  plainCtrlV,
  clipboardAccess,
  shellPath,
  takeClipboardKeys,
  takeFilePastes,
  uploadName,
  type PasteFailure,
  windowsClipboardKey,
  type PasteTarget,
  type Platform,
} from "./paste.js"

// The words of a failed paste's notice, as the app gives them.
const notice = (failure: PasteFailure): string =>
  failure.kind === "clipboard"
    ? "Novadeck can't read the clipboard"
    : `Couldn't paste the ${failure.type.startsWith("image/") ? "image" : "file"}${failure.tooLarge ? ": it's over 32 MB" : ""}`
const maxBytes = 32 * 1024 * 1024

// What a paste event carries, as the browser fills `clipboardData`.
const transfer = (carried: { files?: File[]; items?: File[]; text?: string }) => ({
  files: carried.files ?? [],
  items: (carried.items ?? []).map((file) => ({ kind: "file", getAsFile: () => file })),
  getData: (type: string) => (type === "text/plain" ? (carried.text ?? "") : ""),
})

const pasteEvent = (carried: Parameters<typeof transfer>[0]) => {
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", { value: transfer(carried) })
  return event
}

const shot = () => new File([new Uint8Array([137, 80, 78, 71])], "", { type: "image/png" })

// Files on this machine as the desktop app names them: only those copied in a file
// manager have a path; bytes from the clipboard have none.
const disk = new Map<File, string>()
const onDisk = (path: string, file = new File(["x"], path.split(/[/\\]/).pop()!)) => {
  disk.set(file, path)
  return file
}
const pathOf = (file: File) => disk.get(file) ?? ""

// A terminal's container with the emulator's field inside, recording uploads and pastes; the desktop
// app's (a trusted page with file paths) when `trusted`.
const terminal = (
  saved = (name: string) => Promise.resolve(`/data/uploads/t/${name}`),
  trusted = false,
) => {
  const container = document.createElement("div")
  const field = document.createElement("textarea")
  container.append(field)
  document.body.append(container)
  const uploads: { name: string; data: Uint8Array }[] = []
  const pasted: string[] = []
  const notices: string[] = []
  const target: PasteTarget = {
    upload: (file) => {
      uploads.push(file)
      return saved(file.name)
    },
    paste: (text) => pasted.push(text),
    failed: (text) => notices.push(text),
    notice,
    maxBytes,
    pathOf: trusted ? pathOf : undefined,
  }
  const reached: Event[] = []
  field.addEventListener("paste", (event) => reached.push(event))
  const undo = takeFilePastes(container, target)
  return { container, field, uploads, pasted, notices, reached, undo }
}

afterEach(() => {
  disk.clear()
  document.body.replaceChildren()
  Reflect.deleteProperty(navigator, "clipboard")
})

describe("a paste's files", () => {
  it("are the copied files when there are any", () => {
    const copied = new File(["a"], "a.txt")
    expect(pastedFiles(transfer({ files: [copied], items: [shot()] }))).toEqual([copied])
  })

  it("are the bytes it carries otherwise, as of a copied image", () => {
    const image = shot()
    expect(pastedFiles(transfer({ items: [image] }))).toEqual([image])
  })

  it("are none for a paste of text", () => {
    expect(pastedFiles(transfer({ text: "ls" }))).toEqual([])
    expect(pastedText(transfer({ text: "ls" }))).toBe(true)
    expect(pastedText(transfer({}))).toBe(false)
  })
})

describe("an uploaded file's name", () => {
  const now = new Date("2026-10-04T12:34:56.789Z")

  it("is the file's own", () => {
    expect(uploadName({ name: "shot.png", type: "image/png" }, now)).toBe("shot.png")
  })

  it("is made from the time and type for bytes without one", () => {
    expect(uploadName({ name: "", type: "image/png" }, now)).toBe("pasted-20261004-123456.png")
    expect(uploadName({ name: "", type: "image/jpeg" }, now)).toBe("pasted-20261004-123456.jpg")
    expect(uploadName({ name: "", type: "image/avif" }, now)).toBe("pasted-20261004-123456.avif")
    expect(uploadName({ name: "", type: "" }, now)).toBe("pasted-20261004-123456.bin")
  })
})

describe("a pasted path", () => {
  context("on a POSIX machine", () => {
    it("escapes what the shell would split or expand", () => {
      expect(shellPath("/home/me/.local/share/novadeck/uploads/a b/it's (1).png")).toBe(
        "/home/me/.local/share/novadeck/uploads/a\\ b/it\\'s\\ \\(1\\).png",
      )
      expect(shellPath("/tmp/plain.png")).toBe("/tmp/plain.png")
    })

    it("escapes ^, which zsh's extended globs negate with", () => {
      expect(shellPath("/tmp/^x.png")).toBe("/tmp/\\^x.png")
      expect(shellPath("/tmp/a^b.png")).toBe("/tmp/a\\^b.png")
    })
  })

  context("on a Windows machine", () => {
    it("keeps its backslashes, quoting it when it has a space", () => {
      expect(shellPath("C:\\Users\\me\\uploads\\shot.png")).toBe("C:\\Users\\me\\uploads\\shot.png")
      expect(shellPath("C:\\Users\\Jo Doe\\uploads\\shot.png")).toBe(
        '"C:\\Users\\Jo Doe\\uploads\\shot.png"',
      )
    })

    it("quotes it when its folders hold a character cmd or PowerShell acts on", () => {
      expect(shellPath("C:\\R&D\\novadeck\\uploads\\0b6e\\shot.png")).toBe(
        '"C:\\R&D\\novadeck\\uploads\\0b6e\\shot.png"',
      )
      expect(shellPath("C:\\Users\\a(b);c\\uploads\\shot.png")).toBe(
        '"C:\\Users\\a(b);c\\uploads\\shot.png"',
      )
    })

    // Quotes don't keep cmd from expanding `%VAR%`, cmd with delayed expansion `!`, or
    // PowerShell `$`, but these folders are the person's own, not chosen by an attacker,
    // and the upload's own name keeps to safe characters.
    it("quotes it when its folders hold %, ! or $", () => {
      expect(shellPath("C:\\Users\\100%\\uploads\\shot.png")).toBe(
        '"C:\\Users\\100%\\uploads\\shot.png"',
      )
      expect(shellPath("C:\\Users\\hey!\\uploads\\shot.png")).toBe(
        '"C:\\Users\\hey!\\uploads\\shot.png"',
      )
      expect(shellPath("C:\\Users\\$me\\uploads\\shot.png")).toBe(
        '"C:\\Users\\$me\\uploads\\shot.png"',
      )
    })
  })
})

describe("a file's own path", () => {
  context("on a POSIX machine", () => {
    it("goes in escaped as any path, whatever its name", () => {
      expect(ownPath("/home/me/my shot.png")).toBe("/home/me/my\\ shot.png")
      expect(ownPath("/tmp/$(rm -rf ~);`id`&x.png")).toBe(
        "/tmp/\\$\\(rm\\ -rf\\ \\~\\)\\;\\`id\\`\\&x.png",
      )
      expect(ownPath("/home/me/^x.png")).toBe("/home/me/\\^x.png")
    })

    it("doesn't go in with a control character, which no escape keeps inert", () => {
      expect(ownPath("/tmp/two\nlines.png")).toBeUndefined()
      expect(ownPath("/tmp/bell\u0007.png")).toBeUndefined()
      expect(ownPath("/tmp/del\u007f.png")).toBeUndefined()
      expect(ownPath("/tmp/c1\u009b.png")).toBeUndefined()
    })
  })

  context("on a Windows machine", () => {
    it("goes in when cmd and PowerShell take nothing in it, quoted when it has a space", () => {
      expect(ownPath("D:\\a\\_temp\\shots\\my shot.png")).toBe('"D:\\a\\_temp\\shots\\my shot.png"')
      expect(ownPath("C:\\Users\\Zoë\\画面-1.png")).toBe("C:\\Users\\Zoë\\画面-1.png")
      expect(ownPath("\\\\server\\share\\notes.txt")).toBe("\\\\server\\share\\notes.txt")
      // Japanese's long-vowel mark and 々 are modifier letters, but no code page quotes them.
      expect(ownPath("C:\\shots\\スクリーン.png")).toBe("C:\\shots\\スクリーン.png")
      expect(ownPath("C:\\shots\\人々.png")).toBe("C:\\shots\\人々.png")
    })

    it("doesn't go in with anything cmd or PowerShell may act on, quoted or not", () => {
      // PowerShell runs a `.cmd` with an unspaced word's quotes gone, as `code a&calc&b.txt`,
      // and a paste into a quote already open leaves `&`, `;` or `(…)` bare.
      for (const name of [
        "a&calc&b.txt",
        "Screenshot (calc).png",
        "Screenshot (1).png",
        "a;b.png",
        "it's.png",
        "a,b.png",
        "@home#1.png",
        "a+b=c.png",
        "~a^b.png",
        "{x}.png",
        "100%.png",
        "wow!.png",
        "$x.png",
        "a`b.png",
        'a"b.png',
        "[1].png",
        "a/b.png",
      ])
        expect(ownPath(`C:\\shots\\${name}`)).toBeUndefined()
    })

    it("doesn't go in with a character a code page may turn into a quote", () => {
      // U+02BC MODIFIER LETTER APOSTROPHE, U+02EE MODIFIER LETTER DOUBLE APOSTROPHE and
      // U+030E COMBINING DOUBLE VERTICAL LINE ABOVE.
      expect(ownPath("C:\\shots\\it\u02bcs.png")).toBeUndefined()
      expect(ownPath("C:\\shots\\say\u02eehi.png")).toBeUndefined()
      expect(ownPath("C:\\shots\\a\u030eb.png")).toBeUndefined()
    })

    it("doesn't go in with a space before a `-`, an option were its quotes lost", () => {
      expect(ownPath("C:\\x\\a -Recurse b.png")).toBeUndefined()
      expect(ownPath("C:\\x\\my-shot 1.png")).toBe('"C:\\x\\my-shot 1.png"')
    })
  })

  it("is none for a file that has no path", () => {
    expect(ownPath("")).toBeUndefined()
  })
})

describe("pasting into the desktop app's terminal", () => {
  context("a file copied in a file manager", () => {
    it("pastes the file's own path, saving no copy", async () => {
      const page = terminal(undefined, true)
      page.field.dispatchEvent(pasteEvent({ files: [onDisk("/home/me/my shot.png")] }))
      await vi.waitFor(() => expect(page.pasted).toEqual(["/home/me/my\\ shot.png "]))
      expect(page.uploads).toEqual([])
    })

    it("pastes a folder's own path too", async () => {
      const folder = onDisk("/home/me/project", new File([], "project"))
      const page = terminal(undefined, true)
      page.field.dispatchEvent(pasteEvent({ files: [folder] }))
      await vi.waitFor(() => expect(page.pasted).toEqual(["/home/me/project "]))
      expect(page.uploads).toEqual([])
    })

    it("pastes its own path however large it is", async () => {
      const big = onDisk("/home/me/big.iso")
      Object.defineProperty(big, "size", { value: 33 * 1024 * 1024 })
      const page = terminal(undefined, true)
      page.field.dispatchEvent(pasteEvent({ files: [big] }))
      await vi.waitFor(() => expect(page.pasted).toEqual(["/home/me/big.iso "]))
      expect(page.notices).toEqual([])
    })
  })

  context("a file whose own path can't go in safely", () => {
    it("pastes a copy's path instead, for a Windows name a shell would act on", async () => {
      const page = terminal(undefined, true)
      page.field.dispatchEvent(pasteEvent({ files: [onDisk("C:\\shots\\100%.png")] }))
      await vi.waitFor(() => expect(page.pasted).toEqual(["/data/uploads/t/100%.png "]))
      expect(page.uploads.map((file) => file.name)).toEqual(["100%.png"])
    })

    it("pastes a copy's path instead, for a name with a control character", async () => {
      const page = terminal(undefined, true)
      page.field.dispatchEvent(pasteEvent({ files: [onDisk("/tmp/two\nlines.png")] }))
      await vi.waitFor(() => expect(page.uploads).toHaveLength(1))
    })
  })

  context("bytes with no file behind them, as a copied image", () => {
    it("pastes a copy's path", async () => {
      const page = terminal(undefined, true)
      page.field.dispatchEvent(pasteEvent({ items: [shot()] }))
      await vi.waitFor(() => expect(page.uploads).toHaveLength(1))
    })
  })
})

describe("pasting into a terminal in a browser page", () => {
  context("with an image in the paste", () => {
    it("uploads it and pastes its path instead of letting the emulator paste", async () => {
      const page = terminal()
      const event = pasteEvent({ items: [shot()] })
      page.field.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(page.reached).toEqual([])
      await vi.waitFor(() => expect(page.pasted).toHaveLength(1))
      expect(page.uploads).toEqual([
        {
          name: expect.stringMatching(/^pasted-\d{8}-\d{6}\.png$/),
          data: new Uint8Array([137, 80, 78, 71]),
        },
      ])
      expect(page.pasted[0]).toBe(`/data/uploads/t/${page.uploads[0]!.name} `)
    })
  })

  context("with several files", () => {
    it("pastes the path of each one saved, escaped, in a paste of its own", async () => {
      const page = terminal((name) =>
        name === "lost.txt"
          ? Promise.reject(new Error("disk full"))
          : Promise.resolve(`/data/uploads/t/${name}`),
      )
      const error = vi.spyOn(console, "error").mockImplementation(() => {})
      page.field.dispatchEvent(
        pasteEvent({
          files: [new File(["a"], "my notes.txt"), new File(["b"], "lost.txt"), shot()],
        }),
      )
      await vi.waitFor(() => expect(page.notices).toHaveLength(1))
      expect(page.pasted).toEqual([
        "/data/uploads/t/my\\ notes.txt ",
        expect.stringMatching(/^\/data\/uploads\/t\/pasted-.*\.png $/),
      ])
      expect(error).toHaveBeenCalledOnce()
      expect(page.notices).toEqual(["Couldn't paste the file"])
    })

    it("saves them one after another, pasting each path once it is saved", async () => {
      const pending: (() => void)[] = []
      const page = terminal(
        (name) => new Promise((resolve) => pending.push(() => resolve(`/u/${name}`))),
      )
      page.field.dispatchEvent(
        pasteEvent({ files: [new File(["a"], "one.txt"), new File(["b"], "two.txt")] }),
      )
      await vi.waitFor(() => expect(page.uploads).toHaveLength(1))
      pending[0]!()
      await vi.waitFor(() => expect(page.uploads).toHaveLength(2))
      expect(page.pasted).toEqual(["/u/one.txt "])
      pending[1]!()
      await vi.waitFor(() => expect(page.pasted).toEqual(["/u/one.txt ", "/u/two.txt "]))
    })
  })

  context("with text beside an image, as a spreadsheet's cells come", () => {
    it("leaves the paste to the emulator", () => {
      const page = terminal()
      const event = pasteEvent({ text: "A1\tB1", items: [shot()] })
      page.field.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      expect(page.reached).toEqual([event])
      expect(page.uploads).toEqual([])
    })
  })

  context("with text", () => {
    it("leaves the paste to the emulator", async () => {
      const read = vi.fn<() => Promise<unknown[]>>(async () => [])
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read } })
      const page = terminal()
      const event = pasteEvent({ text: "echo hi" })
      page.field.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      expect(page.reached).toEqual([event])
      expect(read).not.toHaveBeenCalled()
      expect(page.uploads).toEqual([])
    })
  })

  context("with nothing, as a paste of an image alone arrives", () => {
    it("pastes the clipboard's image", async () => {
      const image = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
      const read = vi.fn<() => Promise<unknown[]>>(async () => [
        { types: ["text/html"], getType: async () => new Blob(["<p>"]) },
        { types: ["image/png"], getType: async () => image },
      ])
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read } })
      const page = terminal()
      page.field.dispatchEvent(pasteEvent({}))
      await vi.waitFor(() => expect(page.pasted).toHaveLength(1))
      expect(page.reached).toEqual([])
      expect(page.pasted).toEqual([expect.stringMatching(/^\/data\/uploads\/t\/pasted-.*\.png $/)])
      expect(page.uploads).toEqual([
        { name: expect.stringMatching(/^pasted-.*\.png$/), data: new Uint8Array([1, 2, 3]) },
      ])
      expect(page.notices).toEqual([])
    })

    it("hands the program its empty paste, and says nothing, when the clipboard has no image", async () => {
      const read = vi.fn<() => Promise<unknown[]>>(async () => [
        { types: ["text/html"], getType: async () => new Blob(["<p>"]) },
      ])
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read } })
      const page = terminal()
      page.field.dispatchEvent(pasteEvent({}))
      await vi.waitFor(() => expect(page.pasted).toEqual([""]))
      expect(page.reached).toEqual([])
      expect(page.uploads).toEqual([])
      expect(page.notices).toEqual([])
    })

    it("hands the program its empty paste when the image could not be saved", async () => {
      const image = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
      const read = vi.fn<() => Promise<unknown[]>>(async () => [
        { types: ["image/png"], getType: async () => image },
      ])
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read } })
      const page = terminal(() => Promise.reject(new Error("connection lost")))
      // Silent, and told before the test ends: a log still on its way to the test runner as
      // its worker closes fails the run.
      const error = vi.spyOn(console, "error").mockImplementation(() => {})
      page.field.dispatchEvent(pasteEvent({}))
      await vi.waitFor(() => expect(page.pasted).toEqual([""]))
      expect(page.notices).toEqual(["Couldn't paste the image"])
      expect(error).toHaveBeenCalledOnce()
    })

    it("says so when the page may not read the clipboard", async () => {
      const read = vi.fn<() => Promise<unknown[]>>(async () => {
        throw new DOMException("Read permission denied.", "NotAllowedError")
      })
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read } })
      const page = terminal()
      page.field.dispatchEvent(pasteEvent({}))
      await vi.waitFor(() => expect(page.notices).toEqual(["Novadeck can't read the clipboard"]))
      expect(page.uploads).toEqual([])
      expect(page.pasted).toEqual([""])
    })

    it("says so where there is no clipboard API", async () => {
      const page = terminal()
      page.field.dispatchEvent(pasteEvent({}))
      await vi.waitFor(() => expect(page.notices).toEqual(["Novadeck can't read the clipboard"]))
    })
  })

  context("with a file over the limit", () => {
    it("says so without reading or sending it", async () => {
      const page = terminal()
      const huge = shot()
      Object.defineProperty(huge, "size", { value: 32 * 1024 * 1024 + 1 })
      const error = vi.spyOn(console, "error").mockImplementation(() => {})
      page.field.dispatchEvent(pasteEvent({ items: [huge] }))
      await vi.waitFor(() => expect(page.notices).toHaveLength(1))
      expect(page.notices).toEqual(["Couldn't paste the image: it's over 32 MB"])
      expect(error).toHaveBeenCalledOnce()
      expect(page.uploads).toEqual([])
      expect(page.pasted).toEqual([])
    })
  })

  it("stops taking pastes once undone", () => {
    const page = terminal()
    page.undo()
    const event = pasteEvent({ items: [shot()] })
    page.field.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(page.reached).toEqual([event])
  })
})

// A keydown as the browser reports it, Ctrl+V unless told otherwise.
const key = (init: KeyboardEventInit & { type?: string } = {}) =>
  new KeyboardEvent(init.type ?? "keydown", {
    key: "v",
    code: "KeyV",
    ctrlKey: true,
    cancelable: true,
    ...init,
  })

describe("a plain Ctrl+V", () => {
  it("is Ctrl with V, pressed, on Linux and Windows", () => {
    expect(plainCtrlV(key(), "other")).toBe(true)
    expect(plainCtrlV(key({ key: "V" }), "other")).toBe(true)
    expect(plainCtrlV(key(), "windows")).toBe(true)
  })

  it("is not on Apple platforms, where ⌘V pastes", () => {
    expect(plainCtrlV(key(), "mac")).toBe(false)
  })

  it("is not while an input method composes text", () => {
    expect(plainCtrlV(key({ isComposing: true }), "other")).toBe(false)
    expect(plainCtrlV(key({ keyCode: 229 } as KeyboardEventInit), "other")).toBe(false)
  })

  it("is not with Shift, Alt, AltGr or Meta, nor its release", () => {
    for (const init of [
      { shiftKey: true },
      { altKey: true },
      { metaKey: true },
      { ctrlKey: false },
      { type: "keyup" },
      { type: "keypress" },
    ])
      expect(plainCtrlV(key(init), "other")).toBe(false)
  })

  context("on a layout whose letters move", () => {
    it("follows the layout's V, not the key's place", () => {
      // Dvorak: V is where QWERTY has a period, and the key at V's place types K.
      expect(plainCtrlV(key({ key: "v", code: "Period" }), "other")).toBe(true)
      expect(plainCtrlV(key({ key: "k", code: "KeyV" }), "other")).toBe(false)
    })

    it("takes the key's place on a layout without Latin letters", () => {
      expect(plainCtrlV(key({ key: "м", code: "KeyV" }), "other")).toBe(true)
      expect(plainCtrlV(key({ key: "ч", code: "KeyX" }), "other")).toBe(false)
    })
  })
})

describe("Ctrl+C and Ctrl+V on Windows", () => {
  const c = { key: "c", code: "KeyC" }

  it("copy a selection with Ctrl+C, and paste with Ctrl+V", () => {
    expect(windowsClipboardKey(key(c), "windows", true)).toBe("copy")
    expect(windowsClipboardKey(key(), "windows", true)).toBe("paste")
    expect(windowsClipboardKey(key(), "windows", false)).toBe("paste")
  })

  it("leave Ctrl+C to the program without a selection", () => {
    expect(windowsClipboardKey(key(c), "windows", false)).toBeUndefined()
  })

  it("follow the layout's letters, as Ctrl+V does", () => {
    expect(windowsClipboardKey(key({ key: "с", code: "KeyC" }), "windows", true)).toBe("copy")
    expect(windowsClipboardKey(key({ key: "j", code: "KeyC" }), "windows", true)).toBeUndefined()
  })

  it("are not with Shift, Alt, AltGr or Meta, nor while an input method composes", () => {
    for (const init of [
      { shiftKey: true },
      { altKey: true },
      { metaKey: true },
      { isComposing: true },
    ]) {
      expect(windowsClipboardKey(key({ ...c, ...init }), "windows", true)).toBeUndefined()
      expect(windowsClipboardKey(key(init), "windows", true)).toBeUndefined()
    }
  })

  it("are the program's on Linux and Apple platforms", () => {
    for (const platform of ["other", "mac"] as const) {
      expect(windowsClipboardKey(key(c), platform, true)).toBeUndefined()
      expect(windowsClipboardKey(key(), platform, true)).toBeUndefined()
    }
  })
})

describe("what Ctrl+V pastes", () => {
  it("is a clipboard's images when it holds an image and no text", () => {
    expect(pastesImages([{ types: ["image/png"] }])).toBe(true)
    expect(pastesImages([{ types: ["text/html", "image/png"] }])).toBe(true)
  })

  it("is nothing when it holds text, even beside an image, or no image", () => {
    expect(pastesImages([{ types: ["text/plain", "image/png"] }])).toBe(false)
    expect(pastesImages([{ types: ["image/png"] }, { types: ["text/plain"] }])).toBe(false)
    expect(pastesImages([{ types: ["text/html"] }])).toBe(false)
    expect(pastesImages([])).toBe(false)
  })
})

// A clipboard of `items`, each a type and its bytes.
const clipboard = (read: () => Promise<unknown[]>) =>
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read } })
const item = (...types: string[]) => ({
  types,
  getType: async (type: string) => new Blob([new Uint8Array([7])], { type }),
})

// A terminal whose Ctrl+V reads the clipboard, recording in order what it holds,
// releases, pastes, copies and tells; with `selection` selected, until it is cleared.
const keyboard = (
  options: {
    platform?: Platform
    readable?: boolean
    waitMs?: number
    holdMs?: number
    active?: boolean
    saved?: () => Promise<string>
    unreadable?: "program" | "browser"
    selection?: string
  } = {},
) => {
  let handler: ((event: KeyboardEvent) => boolean) | undefined
  const log: string[] = []
  let selection = options.selection ?? ""
  takeClipboardKeys(
    {
      attachCustomKeyEventHandler: (attached) => void (handler = attached),
      hasSelection: () => selection !== "",
      getSelection: () => selection,
      clearSelection: () => void (selection = ""),
    },
    {
      upload: (file) => {
        log.push(`upload ${file.name.replace(/\d/g, "0")}`)
        return options.saved?.() ?? Promise.resolve("/u/shot.png")
      },
      paste: (text) => void log.push(`paste ${text}`),
      copy: (text) => void log.push(`copy ${text}`),
      failed: (text) => void log.push(`notice ${text}`),
      notice,
      maxBytes,
      active: () => options.active ?? true,
      pathOf,
      hold: () => {
        log.push("hold")
        return (controlV) => void log.push(controlV ? "release with ^V" : "release")
      },
    },
    {
      platform: options.platform ?? "other",
      readable: () => options.readable ?? true,
      waitMs: options.waitMs ?? 1000,
      holdMs: options.holdMs ?? 2000,
      ...(options.unreadable && { unreadable: options.unreadable }),
    },
  )
  const press = (init?: Parameters<typeof key>[0]) => {
    const event = key(init)
    return { passed: handler?.(event) ?? true, prevented: event.defaultPrevented }
  }
  return { log, press, selected: () => selection }
}

describe("Ctrl+C and Ctrl+V in a terminal in a browser page on Windows", () => {
  const c = { key: "c", code: "KeyC" }

  it("copies the selection with Ctrl+C, clearing it, and sends the program nothing", () => {
    const page = keyboard({ platform: "windows", selection: "npm test\n  passed" })
    expect(page.press(c)).toEqual({ passed: false, prevented: true })
    expect(page.log).toEqual(["copy npm test\n  passed"])
    expect(page.selected()).toBe("")
  })

  it("sends Ctrl+C to the program once nothing is selected", () => {
    const page = keyboard({ platform: "windows", selection: "x" })
    page.press(c)
    expect(page.press(c)).toEqual({ passed: true, prevented: false })
    expect(page.log).toEqual(["copy x"])
  })

  it("leaves Ctrl+V to the browser to paste, reading nothing and sending no Ctrl+V", () => {
    const read = vi.fn<() => Promise<unknown[]>>(async () => [item("image/png")])
    clipboard(read)
    const page = keyboard({ platform: "windows" })
    expect(page.press()).toEqual({ passed: false, prevented: false })
    expect(page.press({ repeat: true })).toEqual({ passed: false, prevented: false })
    expect(read).not.toHaveBeenCalled()
    expect(page.log).toEqual([])
  })

  it("leaves Ctrl+Shift+C and Ctrl+Shift+V to the emulator, as before", () => {
    const page = keyboard({ platform: "windows", selection: "x" })
    expect(page.press({ ...c, shiftKey: true })).toEqual({ passed: true, prevented: false })
    expect(page.press({ shiftKey: true })).toEqual({ passed: true, prevented: false })
    expect(page.log).toEqual([])
  })
})

describe("Ctrl+V in a terminal in a browser page on Linux", () => {
  context("with only an image on the clipboard", () => {
    it("pastes the image's path instead of sending Ctrl+V", async () => {
      clipboard(async () => [item("image/png")])
      const page = keyboard()
      expect(page.press()).toEqual({ passed: false, prevented: true })
      await vi.waitFor(() => expect(page.log).toContain("release"))
      expect(page.log).toEqual([
        "hold",
        "upload pasted-00000000-000000.png",
        "paste /u/shot.png ",
        "release",
      ])
    })

    it("tells why and sends Ctrl+V when the image can't be saved", async () => {
      clipboard(async () => [item("image/png")])
      vi.spyOn(console, "error").mockImplementation(() => {})
      const page = keyboard({ saved: () => Promise.reject(new Error("The link dropped")) })
      page.press()
      await vi.waitFor(() => expect(page.log.at(-1)).toBe("release with ^V"))
      expect(page.log).toContain("notice Couldn't paste the image")
    })

    it("lets typing go after a while, pasting the path once the upload ends", async () => {
      clipboard(async () => [item("image/png")])
      let saved: ((path: string) => void) | undefined
      const page = keyboard({
        holdMs: 20,
        saved: () => new Promise((resolve) => (saved = resolve)),
      })
      page.press()
      await vi.waitFor(() => expect(page.log).toContain("release"))
      expect(page.log).toEqual(["hold", "upload pasted-00000000-000000.png", "release"])
      saved?.("/u/late.png")
      await vi.waitFor(() => expect(page.log.at(-1)).toBe("paste /u/late.png "))
    })
  })

  context("with text on the clipboard, even beside an image", () => {
    it("sends Ctrl+V", async () => {
      clipboard(async () => [item("text/plain", "image/png")])
      const page = keyboard()
      page.press()
      await vi.waitFor(() => expect(page.log).toEqual(["hold", "release with ^V"]))
    })
  })

  context("with a clipboard it can't read", () => {
    it("sends Ctrl+V without a word", async () => {
      clipboard(async () => {
        throw new DOMException("Read permission denied.", "NotAllowedError")
      })
      const page = keyboard()
      page.press()
      await vi.waitFor(() => expect(page.log).toEqual(["hold", "release with ^V"]))
    })

    it("sends Ctrl+V without a word where there is no clipboard API", async () => {
      const page = keyboard()
      page.press()
      await vi.waitFor(() => expect(page.log).toEqual(["hold", "release with ^V"]))
    })
  })

  context("with a clipboard slow to answer", () => {
    it("sends Ctrl+V once it has waited long enough, and pastes nothing later", async () => {
      let answer: ((items: unknown[]) => void) | undefined
      clipboard(() => new Promise((resolve) => (answer = resolve)))
      const page = keyboard({ waitMs: 20 })
      page.press()
      await vi.waitFor(() => expect(page.log).toEqual(["hold", "release with ^V"]))
      answer?.([item("image/png")])
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(page.log).toEqual(["hold", "release with ^V"])
    })
  })

  context("pressed again, or repeating, while it looks", () => {
    it("does nothing more, so an image goes in once", async () => {
      clipboard(async () => [item("image/png")])
      const page = keyboard()
      page.press()
      expect(page.press()).toEqual({ passed: false, prevented: true })
      expect(page.press({ repeat: true })).toEqual({ passed: false, prevented: true })
      await vi.waitFor(() => expect(page.log).toContain("release"))
      expect(page.log.filter((entry) => entry.startsWith("upload"))).toHaveLength(1)
      expect(page.log.filter((entry) => entry === "hold")).toHaveLength(1)
    })

    it("works again once typing goes, though a slow upload goes on", async () => {
      clipboard(async () => [item("image/png")])
      const page = keyboard({ holdMs: 20, saved: () => new Promise(() => {}) })
      page.press()
      await vi.waitFor(() => expect(page.log).toContain("release"))
      clipboard(async () => [item("text/plain")])
      expect(page.press()).toEqual({ passed: false, prevented: true })
      await vi.waitFor(() => expect(page.log.at(-1)).toBe("release with ^V"))
      expect(page.log.filter((entry) => entry === "hold")).toHaveLength(2)
    })
  })

  context("in a browser that hasn't let the page read the clipboard", () => {
    it("leaves Ctrl+V to the emulator without reading it", () => {
      const read = vi.fn<() => Promise<unknown[]>>(async () => [item("image/png")])
      clipboard(read)
      const page = keyboard({ readable: false })
      expect(page.press()).toEqual({ passed: true, prevented: false })
      expect(read).not.toHaveBeenCalled()
      expect(page.log).toEqual([])
    })

    it("leaves Ctrl+V to the browser to paste, where the terminal asks for that", () => {
      const read = vi.fn<() => Promise<unknown[]>>(async () => [item("image/png")])
      clipboard(read)
      const page = keyboard({ readable: false, unreadable: "browser" })
      expect(page.press()).toEqual({ passed: false, prevented: false })
      expect(read).not.toHaveBeenCalled()
      expect(page.log).toEqual([])
    })
  })

  it("leaves other keys, Ctrl+Shift+V and Apple platforms to the emulator", () => {
    const read = vi.fn<() => Promise<unknown[]>>(async () => [])
    clipboard(read)
    const page = keyboard({ selection: "x" })
    expect(page.press({ shiftKey: true })).toEqual({ passed: true, prevented: false })
    expect(page.press({ key: "c", code: "KeyC" })).toEqual({ passed: true, prevented: false })
    expect(page.press({ type: "keyup" })).toEqual({ passed: true, prevented: false })
    expect(page.press({ isComposing: true })).toEqual({ passed: true, prevented: false })
    expect(keyboard({ platform: "mac" }).press()).toEqual({ passed: true, prevented: false })
    expect(read).not.toHaveBeenCalled()
    expect(page.log).toEqual([])
  })

  it("leaves Ctrl+V to the emulator while the program takes no input", () => {
    const page = keyboard({ active: false })
    expect(page.press()).toEqual({ passed: true, prevented: false })
    expect(page.log).toEqual([])
  })
})

// A browser whose clipboard-read permission is `state`, or whose query fails.
const permission = (state: PermissionState | Error) => {
  const status = Object.assign(new EventTarget(), { state })
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: {
      query: async () => {
        if (state instanceof Error) throw state
        return status
      },
    },
  })
  return status
}

describe("whether Ctrl+V may read the clipboard", () => {
  afterEach(() => void Reflect.deleteProperty(navigator, "permissions"))

  it("may in the desktop app, which allows it", () => {
    expect(clipboardAccess(true)()).toBe(true)
  })

  it("may in a browser once the page is allowed to, and follows a later change", async () => {
    const status = permission("prompt")
    const readable = clipboardAccess(false)
    await Promise.resolve()
    expect(readable()).toBe(false)
    status.state = "granted"
    status.dispatchEvent(new Event("change"))
    expect(readable()).toBe(true)
  })

  it("may at once in a browser that already allows it", async () => {
    permission("granted")
    const readable = clipboardAccess(false)
    await vi.waitFor(() => expect(readable()).toBe(true))
  })

  it("may not in a browser that can't say, or without the permissions API", async () => {
    permission(new TypeError("'clipboard-read' is not a valid permission name"))
    const unknown = clipboardAccess(false)
    await new Promise((resolve) => setTimeout(resolve))
    expect(unknown()).toBe(false)
    Reflect.deleteProperty(navigator, "permissions")
    expect(clipboardAccess(false)()).toBe(false)
  })
})
