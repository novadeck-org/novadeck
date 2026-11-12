import type {
  ChangedFile,
  ChangeFileDiff,
  ChangeLayer,
  ChangesContent,
  Companions,
} from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, beforeEach } from "vitest"

import { createItemStore } from "../../store/item-store"
import { context, describe, expect, it } from "../../test"
import { changes as registration } from "./index"
import { filesOf } from "./tree"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))
// Whether the person asks for reduced motion: a file then opens and closes at once.
const motion = { reduced: true }
beforeEach(() => {
  motion.reduced = true
  Object.assign(window, {
    matchMedia: (query: string) => ({
      matches: motion.reduced && query.includes("reduce"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
})

const target = { projectId: "project", workspaceSessionId: "initial" }
const item = itemFixture("change", "01", { kind: "changes", name: "Changes", path: "/repo" })

const file = (path: string, rest: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  oldPath: null,
  status: "modified",
  added: 2,
  removed: 1,
  reindented: 0,
  binary: false,
  secret: false,
  ...rest,
})
const layer = (id: string, subject: string, files: ChangedFile[]): ChangeLayer => ({
  id,
  kind: id === "uncommitted" ? "uncommitted" : "commit",
  subject,
  time: id === "uncommitted" ? null : 1_700_000_000_000,
  added: files.reduce((sum, each) => sum + each.added, 0),
  removed: files.reduce((sum, each) => sum + each.removed, 0),
  files,
  truncated: false,
})

// Three layers, newest first: the uncommitted edit of a cookie, a commit adding a session and
// its test, and an older one changing the header.
const layersOf = (): ChangeLayer[] => [
  layer("uncommitted", "", [file("src/auth/cookies.ts", { added: 1, removed: 1 })]),
  layer("c2c2c2c2c2", "Check session expiry in one place", [
    file("src/auth/session.ts", { status: "added", added: 17, removed: 0 }),
    file("src/auth/session.test.ts", { status: "added", added: 14, removed: 0 }),
  ]),
  layer("c1c1c1c1c1", "Use the session in the header", [
    file("src/components/Header.tsx", { added: 4, removed: 6, reindented: 4 }),
  ]),
]
const change = (rest: Partial<ChangesContent> = {}): ChangesContent => {
  const layers = rest.layers ?? layersOf()
  return {
    kind: "changes",
    root: "/repo",
    base: "main",
    truncated: false,
    read: [],
    layers,
    // The whole change's files: here the layers' own, each file once.
    files: filesOf(layers, new Set(layers.map((each) => each.id))),
    ...rest,
  }
}

const cookieDiff: ChangeFileDiff = {
  run: {
    layers: ["uncommitted"],
    file: file("src/auth/cookies.ts", { added: 1, removed: 1 }),
    big: false,
    badName: false,
    before: "const day = 1\nexport const cookieMaxAge = 7 * day\n",
    after: "const day = 1\nexport const cookieMaxAge = 30 * day\n",
    hunks: [
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 2,
        lines: [
          { kind: "context", text: "const day = 1" },
          { kind: "remove", text: "export const cookieMaxAge = 7 * day" },
          { kind: "add", text: "export const cookieMaxAge = 30 * day" },
        ],
      },
    ],
  },
}

// The pane's body for the change, loading what `content` holds through a fake backend, which
// answers a file's diff with `diffs` by path and notes what it was asked.
const show = (
  content: ChangesContent,
  diffs: Record<string, ChangeFileDiff> = { "src/auth/cookies.ts": cookieDiff },
  withDiffs = true,
  // The files of a range: the layers' own added up unless given; null: the backend has no range.
  range?: readonly ChangedFile[] | null,
) => {
  const asked: { path: string; layers: readonly string[] }[] = []
  const ranges: (readonly string[])[] = []
  // The files the pane told the backend were read.
  const marked: string[] = []
  // What a read waits for, where a test holds it.
  const gate: { wait: Promise<void> | undefined } = { wait: undefined }
  let emit: (content: ChangesContent, stamp: string) => void = () => {}
  const companions: Companions = {
    follow: (_target, _id, _options, on) => {
      emit = (next, stamp) => on({ state: "ready", stamp, content: next })
      on({ state: "ready", stamp: "1", content })
      return () => {}
    },
    save: () => new Promise(() => {}),
    trouble: () => {},
    changeRead: async (_target, _id, path) => {
      marked.push(path)
    },
    ...(range !== null && {
      changeRange: async (_target, _id, picked) => {
        ranges.push(picked)
        return {
          files: range ?? filesOf(content.layers, new Set(picked)),
          truncated: false,
        }
      },
    }),
    ...(withDiffs && {
      changeFile: async (_target, _id, path, layers) => {
        await gate.wait
        asked.push({ path, layers })
        return diffs[path] ?? { run: null }
      },
    }),
  }
  const workspace = createWorkspaceStore(
    workspaceReducer(workspaceFixture(), { type: "item/upsert", target, item }),
  )
  const itemStore = createItemStore({ companions, workspace })
  unmounts.push(itemStore.connect())
  const pane = () =>
    createElement(registration.View, { item, itemStore, target, actions: undefined })
  const rendered = render(pane())
  unmounts.push(rendered.unmount)
  const { container } = rendered
  const layers = () => [...container.querySelectorAll<HTMLElement>(".changes-layer")]
  const rail = () =>
    layers().map((each) =>
      [
        each.dataset.on ? "on" : "off",
        each.dataset.start ? "start" : "",
        each.dataset.end ? "end" : "",
      ]
        .filter(Boolean)
        .join(" "),
    )
  const files = () =>
    [...container.querySelectorAll<HTMLElement>(".diff-file")].map((each) => each.dataset.path)
  const click = async (element: Element | null | undefined) => {
    await act(async () => {
      ;(element as HTMLElement).click()
    })
  }
  const press = async (key: string) => {
    await act(async () => {
      container
        .querySelector(".changes-host")!
        .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
    })
  }
  const row = (path: string) =>
    [...container.querySelectorAll<HTMLElement>(".diff-file")].find(
      (each) => each.dataset.path === path,
    )!
  // Lets what is read and parsed asynchronously land.
  const settle = async () => {
    for (let round = 0; round < 8; round += 1)
      // eslint-disable-next-line no-await-in-loop -- Each round follows the one before.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15))
      })
  }
  const open = async (path: string) => {
    await act(async () => {
      row(path)
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    })
    await settle()
  }
  return {
    ...rendered,
    pane,
    asked,
    layers,
    rail,
    files,
    click,
    press,
    row,
    open,
    settle,
    ranges,
    marked,
    gate,
    emit: (next: ChangesContent, stamp: string) =>
      act(async () => {
        emit(next, stamp)
      }),
  }
}

describe("a change beside a terminal", () => {
  it("is registered as Changes", () => {
    expect(registration.kind).toBe("changes")
    expect(registration.names).toEqual({ one: "change", many: "Changes" })
  })

  context("with layers", () => {
    it("says how much changed in all, against main", () => {
      const { container } = show(change())
      expect(container.querySelector(".artifact-meta")?.textContent).toContain(
        "4 files · +36 −7 4 re-indented · against main · read-only",
      )
    })

    it("lists the uncommitted work and each commit, newest first, with their hash, subject and lines", () => {
      const { layers } = show(change())
      expect(layers().map((each) => each.textContent)).toEqual([
        expect.stringMatching(/^·······Uncommitted.*\+1 −1$/),
        expect.stringMatching(/^c2c2c2cCheck session expiry in one place.*\+31 −0$/),
        expect.stringMatching(/^c1c1c1cUse the session in the header.*\+4 −6$/),
      ])
    })

    it("starts with every layer selected, one rail across them from the first row to the last", () => {
      const { rail } = show(change())
      expect(rail()).toEqual(["on start", "on", "on end"])
    })

    it("lists the files they changed as a tree, in folders, and says of what", () => {
      const { container, files } = show(change())
      expect(files()).toEqual([
        "src/auth/cookies.ts",
        "src/auth/session.test.ts",
        "src/auth/session.ts",
        "src/components/Header.tsx",
      ])
      expect(container.querySelector(".changes-files-head")?.textContent).toBe(
        "Files4 files · everything",
      )
      expect(
        [...container.querySelectorAll(".changes-tree > [role='none'] .source-name")].map(
          (each) => each.textContent,
        ),
      ).toEqual(["src", "auth", "components"])
    })

    it("counts lines that only changed whitespace apart", () => {
      const { row } = show(change())
      expect(row("src/components/Header.tsx").textContent).toContain("+4 −6 4 re-indented")
    })

    it("colours a file's name by how it changed: modified, or added", () => {
      const { row } = show(change())
      expect(row("src/auth/cookies.ts").dataset.kind).toBe("modified")
      expect(row("src/auth/session.ts").dataset.kind).toBe("added")
    })
  })

  context("when a merge is shown against its first parent", () => {
    it("says so on that layer only", () => {
      const base = change()
      const { layers } = show(
        change({
          layers: base.layers.map((each, at) => (at === 1 ? { ...each, firstParent: true } : each)),
        }),
      )

      expect(
        layers().map((row) => row.textContent?.includes("merge, against its first parent")),
      ).toEqual([false, true, false])
    })
  })

  context("when a layer is clicked", () => {
    it("keeps only that row at first, its rail alone, and the files of that layer", async () => {
      const { rail, click, layers, files, container } = show(change())

      await click(layers()[1])

      expect(rail()).toEqual(["off", "on start end", "off"])
      expect(files()).toEqual(["src/auth/session.test.ts", "src/auth/session.ts"])
      expect(container.querySelector(".changes-files-of")?.textContent).toBe("2 files · c2c2c2c")
      expect(layers()[1]?.getAttribute("aria-selected")).toBe("true")
    })

    it("keeps only the other row when another is clicked while one is kept", async () => {
      const { rail, click, layers, files, container } = show(change())

      await click(layers()[0])
      await click(layers()[2])

      expect(rail()).toEqual(["off", "off", "on start end"])
      expect(files()).toEqual(["src/components/Header.tsx"])
      expect(container.querySelector(".changes-files-of")?.textContent).toBe("1 file · c1c1c1c")
    })

    it("returns to all when the only row selected is clicked", async () => {
      const { rail, click, layers } = show(change())

      await click(layers()[1])
      await click(layers()[1])

      expect(rail()).toEqual(["on start", "on", "on end"])
    })

    it("says what a click does in a hint at the bottom", async () => {
      const { container, click, layers } = show(change())
      const hint = () => container.querySelector(".changes-hint")?.textContent
      const rest = " · click a file to unfold it · double-click opens it"
      expect(hint()).toBe(`Click a commit to see only it${rest}`)

      await click(layers()[1])
      expect(hint()).toBe(`Click it again to see everything${rest}`)

      await click(layers()[2])
      expect(hint()).toBe(`Click it again to see everything${rest}`)

      await click(layers()[2])
      expect(hint()).toBe(`Click a commit to see only it${rest}`)
    })

    it("is kept when the change is shown again", async () => {
      const shown = show(change())
      await shown.click(shown.layers()[1])

      // The pane goes (another item is shown in its place) and comes back.
      await act(async () => shown.rerender(createElement("div")))
      await act(async () => shown.rerender(shown.pane()))

      expect(shown.rail()).toEqual(["off", "on start end", "off"])
    })
  })

  context("when a file is clicked", () => {
    it("unfolds what it changed under its row, as a terminal tab unfolds its subagents", async () => {
      const { click, row, container, asked, settle } = show(change())
      expect(container.querySelector(".changes-item[data-open]")).toBeNull()

      await click(row("src/auth/cookies.ts").querySelector("button"))
      await settle()

      const unfolded = container.querySelector(".changes-item[data-open]")
      expect(unfolded?.querySelector(".terminal-tab-branches")).not.toBeNull()
      expect(
        [...unfolded!.querySelectorAll("[data-branch]")].map((each) => each.textContent),
      ).toEqual(["└in cookieMaxAge 7 → 30+1 −1"])
      expect(asked).toEqual([
        { path: "src/auth/cookies.ts", layers: ["uncommitted", "c2c2c2c2c2", "c1c1c1c1c1"] },
      ])
    })

    it("folds it again when clicked again, and unfolds one file at a time", async () => {
      const { click, row, container } = show(change())
      const button = (path: string) => row(path).querySelector("button")

      await click(button("src/auth/cookies.ts"))
      await click(button("src/auth/session.ts"))
      expect(
        [...container.querySelectorAll(".changes-item[data-open] .diff-file")].map(
          (each) => (each as HTMLElement).dataset.path,
        ),
      ).toEqual(["src/auth/session.ts"])

      await click(button("src/auth/session.ts"))
      expect(container.querySelector(".changes-item[data-open]")).toBeNull()
    })

    it("says so when the file can not be read", async () => {
      const { click, row, container, settle } = show(change(), {}, false)

      await click(row("src/auth/cookies.ts").querySelector("button"))
      await settle()

      expect(container.querySelector("[data-branch]")?.textContent).toContain(
        "Can't read this file's changes",
      )
    })
  })

  context("when a file is opened", () => {
    it("grows into a heading with its folder, name, lines and place among the files", async () => {
      const { container, open } = show(change())

      await open("src/auth/cookies.ts")

      expect(container.querySelector(".changes-list-view")).toBeNull()
      const head = container.querySelector(".changes-head")!
      expect(head.querySelector(".changes-dir")?.textContent).toBe("src/auth/")
      expect(head.querySelector(".changes-name")?.textContent).toBe("cookies.ts")
      expect(head.querySelector(".changes-of")?.textContent).toBe("1 of 4")
      expect(head.querySelector(".changes-pm")?.textContent).toBe("+1 −1")
    })

    it("says what the file came to in one line, from facts", async () => {
      const { container, open } = show(change())

      await open("src/auth/cookies.ts")

      expect(container.querySelector(".changes-summary")?.textContent).toBe(
        "in cookieMaxAge 7 → 30",
      )
    })

    it("shows each change with its lines, the changed tokens marked, and where it sits", async () => {
      const { container, open } = show(change())

      await open("src/auth/cookies.ts")

      const block = container.querySelector(".changes-block")!
      expect(block.querySelector(".changes-scope")?.textContent).toBe("in cookieMaxAge 7 → 30")
      expect(block.querySelector(".changes-where")?.textContent).toBe("line 2")
      expect(
        [...block.querySelectorAll(".diff-row")].map((each) => [
          (each as HTMLElement).dataset.kind,
          each.querySelector(".changes-num")?.textContent,
          each.querySelector(".changes-text")?.textContent,
        ]),
      ).toEqual([
        ["context", "1", "const day = 1"],
        ["remove", "2", "export const cookieMaxAge = 7 * day"],
        ["add", "2", "export const cookieMaxAge = 30 * day"],
      ])
      expect([...block.querySelectorAll(".changes-tok")].map((each) => each.textContent)).toEqual([
        "7",
        "30",
      ])
    })

    it("reads the file: the backend keeps it, and it is gray in the files after going back", async () => {
      const { container, open, press, row, settle, marked } = show(change())

      await settle()
      await open("src/auth/cookies.ts")
      await press("Escape")

      expect(marked).toEqual(["src/auth/cookies.ts"])
      expect(container.querySelector(".changes-file-view")).toBeNull()
      expect(row("src/auth/cookies.ts").dataset.read).toBe("true")
      expect(row("src/auth/session.ts").dataset.read).toBeUndefined()
    })

    it("does not read the open file's diff again when only the files read changed", async () => {
      const shown = show(change())
      await shown.settle()
      await shown.open("src/auth/cookies.ts")
      await shown.settle()
      const asked = shown.asked.length

      await shown.emit({ ...change(), read: ["src/auth/cookies.ts"] }, "2")
      await shown.settle()

      expect(shown.asked).toHaveLength(asked)
    })

    it("steps to the next and previous file within the selection with J and K", async () => {
      const { container, open, press } = show(change())
      const name = () => container.querySelector(".changes-name")?.textContent

      await open("src/auth/cookies.ts")
      await press("j")
      expect(name()).toBe("session.test.ts")
      expect(container.querySelector(".changes-of")?.textContent).toBe("2 of 4")
      await press("J")
      await press("K")
      expect(name()).toBe("session.test.ts")
      await press("k")
      expect(name()).toBe("cookies.ts")
      await press("k")
      expect(name()).toBe("cookies.ts")
    })

    it("steps only among the files of the selection", async () => {
      const { container, open, press, click, layers } = show(change())
      await click(layers()[1])

      await open("src/auth/session.test.ts")
      await press("j")

      expect(container.querySelector(".changes-name")?.textContent).toBe("session.ts")
      expect(container.querySelector(".changes-of")?.textContent).toBe("2 of 2")
      expect(container.querySelector(".changes-in")?.textContent).toBe("in c2c2c2c")
    })

    it("goes back to the files with Esc or the back button", async () => {
      const { container, open, press, click } = show(change())

      await open("src/auth/cookies.ts")
      await click(container.querySelector(".changes-back"))
      expect(container.querySelector(".changes-list-view")).not.toBeNull()
      expect(container.querySelector(".changes-file-view")).toBeNull()

      await open("src/auth/session.ts")
      await press("Escape")
      expect(container.querySelector(".changes-file-view")).toBeNull()
    })

    it("keeps the files under the heading while the row grows into it, then lets them go", async () => {
      motion.reduced = false
      const { container, row } = show(change())
      const cookies = row("src/auth/cookies.ts")
      cookies.getBoundingClientRect = () => new DOMRect(10, 100, 300, 26)

      await act(async () => {
        cookies
          .querySelector("button")!
          .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
      })

      expect(container.querySelector(".changes-list-view")?.getAttribute("data-leaving")).toBe(
        "true",
      )
      expect(container.querySelector(".changes-file-view")).not.toBeNull()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 350))
      })
      expect(container.querySelector(".changes-list-view")).toBeNull()
    })

    it("opens a file on Enter in its row", async () => {
      const { container, row } = show(change())
      await act(async () => {
        row("src/auth/session.ts")
          .querySelector("button")!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
          )
      })
      expect(container.querySelector(".changes-name")?.textContent).toBe("session.ts")
    })
  })

  context("with a file that is not shown", () => {
    it("says a file that may hold secrets is not shown, and shows no lines", async () => {
      const content = change({
        layers: [layer("uncommitted", "", [file(".env", { secret: true })])],
      })
      const { container, open } = show(content)

      await open(".env")

      expect(container.querySelector(".changes-summary")?.textContent).toContain("may hold secrets")
      expect(container.querySelector(".diff-row")).toBeNull()
    })

    it("says a change past the backend's bounds is too large", async () => {
      const big: ChangeFileDiff = {
        run: { ...cookieDiff.run!, big: true, hunks: [], before: null, after: null },
      }
      const { container, open } = show(change(), { "src/auth/cookies.ts": big })

      await open("src/auth/cookies.ts")

      expect(container.querySelector(".changes-summary")?.textContent).toContain("too large")
    })
  })

  context("when the change carries its own files", () => {
    it("shows those, with their counts, for every layer selected, asking for no range", async () => {
      const net = [file("src/auth/session.ts", { status: "added", added: 20, removed: 0 })]
      const { files, container, settle, ranges } = show(change({ files: net }))

      await settle()

      expect(files()).toEqual(["src/auth/session.ts"])
      expect(container.querySelector(".artifact-meta")?.textContent).toContain(
        "1 file · +20 −0 · against main",
      )
      expect(ranges).toEqual([])
    })

    it("says so when the change is over the files it lists", async () => {
      const { container, settle } = show(change({ truncated: true }))
      await settle()
      expect(container.querySelector(".artifact-meta")?.textContent).toContain(", more than shown")
    })

    it("counts the lines that only changed whitespace", async () => {
      const { container, settle } = show(change())
      await settle()
      expect(container.querySelector(".artifact-meta")?.textContent).toContain("4 re-indented")
    })
  })

  context("when the backend lists a range's own files", () => {
    it("shows a single layer's own files, which no range is asked for", async () => {
      const net = [file("elsewhere.ts")]
      const { files, click, layers, settle, ranges } = show(change(), undefined, true, net)
      await settle()

      await click(layers()[1])
      await settle()

      expect(files()).toEqual(["src/auth/session.test.ts", "src/auth/session.ts"])
      expect(ranges).toEqual([])
    })
  })

  context("when the change is read again", () => {
    const longer = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"]
    const foldDiff: ChangeFileDiff = {
      run: {
        layers: ["uncommitted"],
        file: file("src/auth/cookies.ts", { added: 1, removed: 1 }),
        big: false,
        badName: false,
        before: longer.join("\n") + "\n",
        after: longer.map((line) => (line === "l6" ? "L6" : line)).join("\n") + "\n",
        hunks: [
          {
            oldStart: 5,
            oldCount: 3,
            newStart: 5,
            newCount: 3,
            lines: [
              { kind: "context", text: "l5" },
              { kind: "remove", text: "l6" },
              { kind: "add", text: "L6" },
              { kind: "context", text: "l7" },
            ],
          },
        ],
      },
    }

    it("keeps the open file, with its unfolded stretch, while the new answer is read", async () => {
      const shown = show(change(), { "src/auth/cookies.ts": foldDiff })
      await shown.settle()
      await shown.open("src/auth/cookies.ts")
      const body = () => shown.container.querySelector(".changes-body")!
      const stretch = body().querySelector<HTMLElement>("button.changes-fold")!
      await shown.click(stretch)
      const lines = body().querySelectorAll(".diff-row").length
      const run = body().querySelector(".changes-run")

      // The agent saves: a new stamp, whose answer is not in yet.
      shown.gate.wait = new Promise(() => {})
      await shown.emit(change(), "2")
      await shown.settle()

      expect(shown.container.querySelector(".changes-summary")?.textContent).not.toContain(
        "Reading the changes",
      )
      expect(body().querySelector(".changes-run")).toBe(run)
      expect(body().querySelectorAll(".diff-row")).toHaveLength(lines)
    })
  })

  context("when a new commit comes in", () => {
    it("shows as read what the backend says is, a file the commit did not touch", async () => {
      const shown = show(change())
      await shown.settle()
      await shown.open("src/auth/session.ts")
      await shown.press("Escape")
      await shown.settle()
      expect(shown.row("src/auth/session.ts").dataset.read).toBe("true")

      const next = change()
      await shown.emit(
        {
          ...next,
          layers: [
            next.layers[0]!,
            layer("c3c3c3c3c3", "Touch the cookie again", [file("src/auth/cookies.ts")]),
            ...next.layers.slice(1),
          ],
          read: ["src/auth/session.ts"],
        },
        "2",
      )
      await shown.settle()

      expect(shown.row("src/auth/session.ts").dataset.read).toBe("true")
      expect(shown.row("src/auth/cookies.ts").dataset.read).toBeUndefined()
    })

    it("grays a file opened only until the content comes again without it", async () => {
      const shown = show(change())
      await shown.settle()
      await shown.open("src/auth/session.ts")
      await shown.press("Escape")
      await shown.settle()

      // The backend kept no word of it (or the file changed since).
      await shown.emit(change(), "2")
      await shown.settle()

      expect(shown.row("src/auth/session.ts").dataset.read).toBeUndefined()
    })

    it("does not take the keys from where the person put them", async () => {
      const shown = show(change())
      await shown.settle()
      await shown.open("src/auth/cookies.ts")
      const elsewhere = document.createElement("input")
      document.body.append(elsewhere)
      elsewhere.focus()

      await shown.emit(change(), "2")
      await shown.settle()

      expect(document.activeElement).toBe(elsewhere)
      elsewhere.remove()
    })
  })

  context("when the file closes", () => {
    it("gives the files back where they were scrolled to, and the keys to its row", async () => {
      const shown = show(change())
      await shown.settle()
      const scroller = () => shown.container.querySelector<HTMLElement>(".changes-scroll")!
      scroller().scrollTop = 40
      await shown.open("src/auth/cookies.ts")
      await shown.press("Escape")
      await shown.settle()

      expect(scroller().scrollTop).toBe(40)
      expect(document.activeElement).toBe(shown.row("src/auth/cookies.ts").querySelector("button"))
    })

    it("leaves the keys to the pane when its row is not drawn", async () => {
      const shown = show(change())
      await shown.settle()
      await shown.open("src/auth/cookies.ts")
      // Stepping to a file in a folder that is folded away.
      await shown.press("j")
      await act(async () => {
        const pane = shown.container.querySelector<HTMLElement>(".changes-host")!
        pane.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      })
      await shown.settle()

      expect(document.activeElement).not.toBe(document.body)
    })
  })

  context("with nothing changed", () => {
    it("says so", () => {
      const { container } = show(change({ layers: [layer("uncommitted", "", [])] }))
      expect(container.querySelector(".diff-empty")?.textContent).toBe("No changes against main.")
      expect(container.querySelector(".artifact-meta")?.textContent).toContain(
        "no changes against main · read-only",
      )
    })

    it("says a repository with no commit yet has nothing to compare", () => {
      const { container } = show(change({ layers: [], base: "HEAD (no commits yet)" }))
      expect(container.querySelector(".diff-empty")?.textContent).toContain("No commits yet")
    })
  })

  context("when it is larger than the backend shows", () => {
    it("says so", () => {
      const { container } = show(change({ truncated: true }))
      expect(container.querySelector(".artifact-meta")?.textContent).toContain(
        "4 files, more than shown · +36 −7",
      )
    })
  })
})
