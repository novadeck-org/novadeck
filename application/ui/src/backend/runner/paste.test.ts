import { RunnerError } from "@novadeck/protocol/client"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import {
  pasteNotice,
  pastedFiles,
  pastedText,
  shellPath,
  takeFilePastes,
  uploadName,
  type PasteTarget,
} from "./paste"

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

// A terminal host with the emulator's field inside, recording uploads and pastes.
const terminal = (saved = (name: string) => Promise.resolve(`/data/uploads/t/${name}`)) => {
  const host = document.createElement("div")
  const field = document.createElement("textarea")
  host.append(field)
  document.body.append(host)
  const uploads: { name: string; data: Uint8Array }[] = []
  const pasted: string[] = []
  const notices: string[] = []
  const target: PasteTarget = {
    upload: (file) => {
      uploads.push(file)
      return saved(file.name)
    },
    paste: (text) => pasted.push(text),
    failed: (notice) => notices.push(notice),
  }
  const reached: Event[] = []
  field.addEventListener("paste", (event) => reached.push(event))
  const undo = takeFilePastes(host, target)
  return { host, field, uploads, pasted, notices, reached, undo }
}

afterEach(() => {
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
  context("on a POSIX runner", () => {
    it("escapes what the shell would split or expand", () => {
      expect(shellPath("/home/me/.local/share/novadeck/uploads/a b/it's (1).png")).toBe(
        "/home/me/.local/share/novadeck/uploads/a\\ b/it\\'s\\ \\(1\\).png",
      )
      expect(shellPath("/tmp/plain.png")).toBe("/tmp/plain.png")
    })
  })

  context("on a Windows runner", () => {
    it("keeps its backslashes, quoting it when it has a space", () => {
      expect(shellPath("C:\\Users\\me\\uploads\\shot.png")).toBe("C:\\Users\\me\\uploads\\shot.png")
      expect(shellPath("C:\\Users\\Jo Doe\\uploads\\shot.png")).toBe(
        '"C:\\Users\\Jo Doe\\uploads\\shot.png"',
      )
    })
  })
})

describe("a failed paste's notice", () => {
  it("says the clipboard could not be read", () => {
    expect(pasteNotice("clipboard")).toBe("NovaDeck can't read the clipboard")
  })

  it("says an image or a file was too large, as the runner or the client found", () => {
    const error = new RunnerError("UPLOAD_TOO_LARGE")
    expect(pasteNotice({ type: "image/png", error })).toBe(
      "Couldn't paste the image: it's over 32 MB",
    )
    expect(pasteNotice({ type: "application/pdf", error })).toBe(
      "Couldn't paste the file: it's over 32 MB",
    )
  })

  it("says only that it failed for any other reason, as a lost connection", () => {
    expect(pasteNotice({ type: "image/png", error: new RunnerError("DISCONNECTED") })).toBe(
      "Couldn't paste the image",
    )
    expect(pasteNotice({ type: "", error: new Error("disk full") })).toBe("Couldn't paste the file")
  })
})

describe("pasting into a runner terminal", () => {
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
      page.field.dispatchEvent(pasteEvent({}))
      await vi.waitFor(() => expect(page.pasted).toEqual([""]))
      expect(page.notices).toEqual(["Couldn't paste the image"])
    })

    it("says so when the page may not read the clipboard", async () => {
      const read = vi.fn<() => Promise<unknown[]>>(async () => {
        throw new DOMException("Read permission denied.", "NotAllowedError")
      })
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read } })
      const page = terminal()
      page.field.dispatchEvent(pasteEvent({}))
      await vi.waitFor(() => expect(page.notices).toEqual(["NovaDeck can't read the clipboard"]))
      expect(page.uploads).toEqual([])
      expect(page.pasted).toEqual([""])
    })

    it("says so where there is no clipboard API", async () => {
      const page = terminal()
      page.field.dispatchEvent(pasteEvent({}))
      await vi.waitFor(() => expect(page.notices).toEqual(["NovaDeck can't read the clipboard"]))
    })
  })

  context("with a file over the limit", () => {
    it("says so without reading or sending it", async () => {
      const page = terminal()
      const huge = shot()
      Object.defineProperty(huge, "size", { value: 32 * 1024 * 1024 + 1 })
      page.field.dispatchEvent(pasteEvent({ items: [huge] }))
      await vi.waitFor(() => expect(page.notices).toHaveLength(1))
      expect(page.notices).toEqual(["Couldn't paste the image: it's over 32 MB"])
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
