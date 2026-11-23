import type { ChatBlock } from "@novadeck/core/conversation/turns"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import type { SentBubble } from "./bubbles"
import { context, describe, expect, it } from "./test"
import { Transcript, type PeerLooks } from "./Transcript"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const show = (
  blocks: readonly ChatBlock[],
  sent?: readonly SentBubble[],
  looks?: PeerLooks,
  gone?: boolean,
) => {
  const { container, unmount } = render(
    createElement(Transcript, {
      blocks,
      agent: "Claude",
      working: false,
      ...(sent && { sent }),
      ...(looks && { looks }),
      ...(gone && { gone }),
    }),
  )
  unmounts.push(unmount)
  return container
}

const words = (id: string, kind: "user" | "assistant", text: string): ChatBlock => ({
  kind,
  id,
  text,
  truncated: false,
  at: null,
})

describe("the scrollback", () => {
  it("marks the person's prompts, and only those", () => {
    const container = show([
      words("1", "user", "Why?"),
      words("2", "assistant", "Because."),
      { kind: "note", id: "3", text: "Interrupted" },
    ])
    const marks = [...container.querySelectorAll(".chat-mark")]
    expect(marks.map((mark) => mark.closest("article")?.getAttribute("aria-label"))).toEqual([
      "You",
    ])
    expect(marks[0]?.getAttribute("aria-hidden")).toBe("true")
  })

  it("names who says what to a screen reader", () => {
    const labels = [
      ...show([words("1", "user", "Why?"), words("2", "assistant", "Because.")]).querySelectorAll(
        "article",
      ),
    ].map((article) => article.getAttribute("aria-label"))
    expect(labels).toEqual(["You", "Claude"])
  })

  it("tags the agent's thinking as a summary, as its terminal does, and not its reply", () => {
    const container = show([
      words("1", "user", "Why?"),
      { ...words("2", "assistant", "Looking first."), thinking: true } as ChatBlock,
      words("3", "assistant", "Because."),
    ])
    const [, update, reply] = [...container.querySelectorAll("article")]
    expect(update?.getAttribute("aria-label")).toBe("Claude, summary")
    expect(update?.getAttribute("data-thinking")).toBe("true")
    // The tag is in the text's flow, after the words, and no fact of the row's edge.
    const tag = update?.querySelector(".chat-summary-tag")
    expect(tag?.textContent?.trim()).toBe("· summary")
    expect(tag?.closest(".chat-fact")).toBeNull()
    expect(tag?.previousElementSibling?.classList.contains("markdown")).toBe(true)
    expect(update?.querySelector(".chat-fact")).toBeNull()
    expect(reply?.getAttribute("aria-label")).toBe("Claude")
    expect(reply?.hasAttribute("data-thinking")).toBe(false)
    expect(reply?.querySelector(".chat-fact")).toBeNull()
  })

  it("says a prompt was cut short", () => {
    const container = show([{ ...words("1", "user", "Long"), truncated: true } as ChatBlock])
    expect(container.querySelector(".chat-shortened")).not.toBeNull()
  })

  it("marks a prompt the record doesn't have yet, with its state", () => {
    const container = show(
      [],
      [{ ref: "a", text: "and a test", images: [], state: "queued", at: null }],
    )
    const prompt = container.querySelector("article")
    expect(prompt?.getAttribute("data-sent")).toBe("queued")
    expect(prompt?.querySelector(".chat-mark")).not.toBeNull()
    expect(prompt?.querySelector(".chat-sent-tag")?.textContent).toBe("queued")
  })

  it("sets another agent's handle beside its words, with no mark", () => {
    const container = show([
      { kind: "agent", id: "1", author: "moth", text: "Keep it.", truncated: false, at: null },
    ])
    const message = container.querySelector("article")
    expect(message?.getAttribute("aria-label")).toBe("Message from moth")
    expect(message?.querySelector(".chat-author")?.textContent).toBe("moth")
    expect(message?.querySelector(".markdown")?.textContent).toBe("Keep it.")
    expect(message?.querySelector(".chat-mark")).toBeNull()
  })

  it("offers what can be done about a prompt the record never got", () => {
    const lost: SentBubble = { ref: "a", text: "words", images: [], state: "unrecorded", at: null }
    const resent: SentBubble[] = []
    const edited: SentBubble[] = []
    const { container, unmount } = render(
      createElement(Transcript, {
        blocks: [],
        agent: "Claude",
        working: false,
        sent: [lost],
        onResend: (bubble) => resent.push(bubble),
        onEdit: (bubble) => edited.push(bubble),
      }),
    )
    unmounts.push(unmount)
    const key = (name: string) =>
      [...container.querySelectorAll<HTMLElement>(".chat-sent button")].find(
        (each) => each.textContent === name,
      )!
    key("send again").click()
    key("edit").click()
    expect(resent).toEqual([lost])
    expect(edited).toEqual([lost])
  })

  it("has no way to send again while the box holds words it would take along", () => {
    const { container, unmount } = render(
      createElement(Transcript, {
        blocks: [],
        agent: "Claude",
        working: false,
        sent: [{ ref: "a", text: "words", images: [], state: "unrecorded", at: null }],
        onEdit: () => {},
      }),
    )
    unmounts.push(unmount)
    expect(container.querySelector(".chat-sent")?.textContent).not.toContain("send again")
  })

  it("points at the terminal's box for words that went back there", () => {
    const { container, unmount } = render(
      createElement(Transcript, {
        blocks: [],
        agent: "Claude",
        working: false,
        sent: [{ ref: "a", text: "words", images: [], state: "in-box", at: null }],
        onShowTerminal: () => {},
      }),
    )
    unmounts.push(unmount)
    expect(container.querySelector('[aria-label="Show terminal"]')?.textContent).toBe("terminal")
  })

  context("another Novadeck agent's message", () => {
    const moth = (text: string): ChatBlock => ({
      kind: "doorbell",
      id: "d",
      at: null,
      replies: false,
      notices: [],
      messages: [
        {
          id: "m",
          text,
          from: { kind: "agent", terminalId: "id-moth", handle: "moth", agent: "codex" },
        } as never,
      ],
    })
    const looks: PeerLooks = (handle) =>
      handle === "moth"
        ? { face: createElement("i", { className: "face" }), where: "codex · Review", hue: 4 }
        : null

    it("has the app's face, hue and terminal where the app knows the sender", () => {
      const message = show([moth("Keep it.")], undefined, looks).querySelector(
        '.chat-ring > [data-role="agent"]',
      )
      expect(message?.getAttribute("data-hue")).toBe("4")
      expect(message?.querySelector(".chat-agent-face .face")).not.toBeNull()
      expect(message?.querySelector(".chat-author")?.textContent).toBe("@moth")
      expect(message?.querySelector(".chat-agent-where")?.textContent).toBe("codex · Review")
    })

    it("has no face and no terminal without the app's look, or for a sender it doesn't know", () => {
      for (const container of [
        show([moth("Keep it.")]),
        show([moth("Keep it.")], undefined, () => null),
      ]) {
        const message = container.querySelector('[data-role="agent"]')
        expect(message?.querySelector(".chat-author")?.textContent).toBe("@moth")
        expect(message?.querySelector(".chat-agent-face")).toBeNull()
        expect(message?.querySelector(".chat-agent-where")).toBeNull()
        expect(message?.hasAttribute("data-hue")).toBe(false)
      }
    })

    context("a long one", () => {
      // jsdom lays nothing out: the words take `lines` lines of 20px.
      const lay = (lines: number) => {
        vi.spyOn(window, "getComputedStyle").mockReturnValue({ lineHeight: "20px" } as never)
        vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(lines * 20)
      }
      afterEach(() => vi.restoreAllMocks())
      const key = (container: Element) => container.querySelector<HTMLElement>(".chat-more")

      it("folds past five lines, to a key that counts the rest and opens them", async () => {
        lay(9)
        const container = show([moth("a long one")], undefined, looks)
        const said = container.querySelector(".chat-words")!
        expect(said.hasAttribute("data-folded")).toBe(true)
        expect(key(container)?.textContent).toBe("… 5 more lines")
        expect(key(container)?.getAttribute("aria-expanded")).toBe("false")
        expect(key(container)?.getAttribute("aria-controls")).toBe(said.id)
        await act(async () => key(container)!.click())
        expect(said.hasAttribute("data-folded")).toBe(false)
        expect(key(container)?.textContent).toBe("show less")
        expect(key(container)?.getAttribute("aria-expanded")).toBe("true")
        await act(async () => key(container)!.click())
        expect(said.hasAttribute("data-folded")).toBe(true)
      })

      it("opens when focus goes into its cut-off lines", async () => {
        lay(9)
        const container = show([moth("See [the diff](https://example.com/d).")], undefined, looks)
        const said = container.querySelector(".chat-words")!
        expect(said.hasAttribute("data-folded")).toBe(true)
        const link = said.querySelector<HTMLElement>("a")!
        // The keys' focus shows its ring: :focus-visible matches.
        const matches = link.matches.bind(link)
        link.matches = ((selector: string) =>
          selector === ":focus-visible" || matches(selector)) as typeof link.matches
        await act(async () => link.focus())
        expect(said.hasAttribute("data-folded")).toBe(false)
        expect(key(container)?.getAttribute("aria-expanded")).toBe("true")
      })

      it("stays shut when a click puts focus in it, as on a link or a code block", async () => {
        lay(9)
        const container = show([moth("See [the diff](https://example.com/d).")], undefined, looks)
        const said = container.querySelector(".chat-words")!
        const link = said.querySelector<HTMLElement>("a")!
        // A click's focus shows no ring: :focus-visible doesn't match.
        const matches = link.matches.bind(link)
        link.matches = ((selector: string) =>
          selector !== ":focus-visible" && matches(selector)) as typeof link.matches
        await act(async () => link.focus())
        expect(said.hasAttribute("data-folded")).toBe(true)
      })

      it("does not fold at five lines", () => {
        lay(5)
        const container = show([moth("five lines")], undefined, looks)
        expect(key(container)).toBeNull()
        expect(container.querySelector(".chat-words")?.hasAttribute("data-folded")).toBe(false)
      })
    })
  })

  context("a subagent's report", () => {
    const report = (over: Partial<Extract<ChatBlock, { kind: "subagent" }>> = {}): ChatBlock => ({
      kind: "subagent",
      id: "s",
      name: "explorer 1",
      text: "Found it:\n\nthe cart leaks.",
      truncated: false,
      running: false,
      failed: false,
      at: null,
      doneAt: null,
      call: null,
      ...over,
    })
    const line = (container: Element) =>
      container.querySelector<HTMLElement>(".chat-subagent-summary")!

    it("is a line of its own: the name, the tag, the report cut to one line", () => {
      const container = show([report()])
      expect(container.querySelector(".chat-tools")).toBeNull()
      expect(container.querySelector(".chat-subagent-name")?.textContent).toBe("explorer 1")
      expect(container.querySelector(".chat-subagent-tag")?.textContent).toBe("· subagent")
      expect(container.querySelector(".chat-subagent-said")?.textContent).toBe(
        "Found it: the cart leaks.",
      )
      expect(line(container).getAttribute("aria-expanded")).toBe("false")
    })

    it("opens to the whole report, and shuts again", async () => {
      const container = show([report()])
      await act(async () => line(container).click())
      expect(line(container).getAttribute("aria-expanded")).toBe("true")
      expect(container.querySelector(".chat-tool-body .markdown")?.textContent).toContain(
        "the cart leaks.",
      )
      await act(async () => line(container).click())
      expect(container.querySelector(".chat-tool-body")).toBeNull()
    })

    it("says it runs until it has a report, and what failed", () => {
      const running = show([report({ text: null, running: true })])
      expect(running.querySelector(".chat-subagent-said")?.textContent).toBe("running…")
      expect(running.querySelector(".chat-subagent")?.hasAttribute("data-running")).toBe(true)
      const failed = show([report({ failed: true })])
      expect(failed.querySelector(".chat-subagent")?.hasAttribute("data-failed")).toBe(true)
    })

    it("says it stopped with its session where the agent has gone before it reported", async () => {
      const container = show([report({ text: null, running: true })], undefined, undefined, true)
      expect(container.querySelector(".chat-subagent-said")?.textContent).toBe(
        "stopped with its session",
      )
      expect(container.querySelector(".chat-subagent")?.hasAttribute("data-running")).toBe(false)
      expect(container.querySelector(".chat-subagent")?.hasAttribute("data-stopped")).toBe(true)
      expect(line(container).getAttribute("aria-label")).toBe("explorer 1, subagent, stopped")
      await act(async () => line(container).click())
      expect(container.querySelector(".chat-tool-note")?.textContent).toContain("stopped")
      // A report that came still reads as it was.
      const done = show([report()], undefined, undefined, true)
      expect(done.querySelector(".chat-subagent")?.hasAttribute("data-stopped")).toBe(false)
    })

    it("says in words that it failed, open as well as shut", async () => {
      const container = show([report({ failed: true })])
      expect(container.querySelector(".chat-subagent-failed")?.textContent).toBe("· failed")
      await act(async () => line(container).click())
      expect(container.querySelector(".chat-subagent-failed")?.textContent).toBe("· failed")
      expect(show([report()]).querySelector(".chat-subagent-failed")).toBeNull()
    })

    it("names its line by who and how it stands, not by the whole report", () => {
      const label = (over: Partial<Extract<ChatBlock, { kind: "subagent" }>>) =>
        line(show([report(over)])).getAttribute("aria-label")
      expect(label({})).toBe("explorer 1, subagent")
      expect(label({ text: null, running: true })).toBe("explorer 1, subagent, running")
      expect(label({ failed: true })).toBe("explorer 1, subagent, failed")
      expect(label({ name: "parent agent" })).toBe("parent agent")
      expect(
        show([report()]).querySelector(".chat-subagent-said")?.getAttribute("aria-hidden"),
      ).toBe("true")
    })

    it("tags its parent's words, in a subagent's own record, as no subagent's", () => {
      const container = show([report({ name: "parent agent", text: "Look at the cart." })])
      expect(container.querySelector(".chat-subagent-name")?.textContent).toBe("parent agent")
      expect(container.querySelector(".chat-subagent-tag")).toBeNull()
    })

    it("says when its report was cut short", async () => {
      const container = show([report({ truncated: true })])
      await act(async () => line(container).click())
      expect(container.querySelector(".chat-tool-body .chat-shortened")).not.toBeNull()
    })

    it("stands apart from the tool runs around it, each report its own line", () => {
      const container = show([report({ id: "a" }), report({ id: "b", name: "explorer 2" })])
      expect(container.querySelectorAll(".chat-subagent")).toHaveLength(2)
    })
  })
})

describe("the facts at a row's right edge", () => {
  const facts = (container: Element) =>
    [...container.querySelectorAll(".chat-fact")].map((fact) => [
      fact.textContent,
      fact.hasAttribute("data-hover"),
      fact.hasAttribute("data-live"),
    ])
  const shown = (blocks: readonly ChatBlock[]) => facts(show(blocks))
  const stamp = (time: number) =>
    new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const timed = (
    id: string,
    kind: "user" | "assistant",
    text: string,
    time: number,
  ): ChatBlock => ({
    kind,
    id,
    text,
    truncated: false,
    at: time,
  })
  const t0 = new Date(2026, 10, 9, 14, 2).getTime()

  it("gives a prompt its time, and the rest of the turn its time on hover only", () => {
    const rows = shown([timed("1", "user", "Go", t0), timed("2", "assistant", "Sure", t0 + 1000)])
    expect(rows).toEqual([
      [stamp(t0), false, false],
      [stamp(t0 + 1000), true, false],
    ])
  })

  it("gives no fact to a row the harness didn't date", () => {
    expect(shown([words("1", "user", "Go"), words("2", "assistant", "Sure")])).toEqual([])
  })

  it("ends a finished turn's last words with how long it worked, when that was long", () => {
    const blocks: ChatBlock[] = [
      timed("1", "user", "Go", t0),
      timed("2", "assistant", "Done", t0 + 400_000),
      timed("3", "user", "Again", t0 + 500_000),
      timed("4", "assistant", "Quick", t0 + 501_000),
    ]
    const rows = shown(blocks).map(([text]) => text)
    expect(rows).toContain("worked 6m 40s")
    // The second turn took a second: its time stays on hover.
    expect(rows).toContain(stamp(t0 + 501_000))
    expect(rows.filter((text) => String(text).startsWith("worked"))).toHaveLength(1)
  })

  it("gives a doorbell ring its time once, ending its rule", () => {
    const ring = shown([
      {
        kind: "doorbell",
        id: "d",
        at: t0,
        messages: null,
        replies: false,
        notices: [],
      },
    ])
    expect(ring).toEqual([[stamp(t0), false, false]])
  })

  it("gives a running subagent a live clock, and a finished one its length when long", () => {
    const running = show([
      {
        kind: "subagent",
        id: "a",
        name: "explorer",
        text: null,
        truncated: false,
        running: true,
        failed: false,
        at: Date.now() - 72_000,
        doneAt: null,
        call: null,
      },
    ])
    const [live] = facts(running)
    expect(live?.[0]).toMatch(/^1m 1\ds$/)
    expect(live?.[2]).toBe(true)
    const done = shown([
      {
        kind: "subagent",
        id: "b",
        name: "explorer",
        text: "Found it",
        truncated: false,
        running: false,
        failed: false,
        at: t0,
        doneAt: t0 + 108_000,
        call: null,
      },
    ])
    expect(done).toEqual([["1m 48s", false, false]])
  })
})

describe("an @handle in the words", () => {
  const looks: PeerLooks = (handle) =>
    handle === "thorn" || handle === "fox"
      ? { face: null, where: null, hue: handle === "thorn" ? 3 : 5 }
      : null
  const hues = (container: HTMLElement): [string, string | null][] =>
    [...container.querySelectorAll(".markdown-mention")].map((each) => [
      each.textContent ?? "",
      each.getAttribute("data-hue"),
    ])

  it("takes the hue of the agent it names in the agent's prose, plain or in inline code", () => {
    const container = show(
      [words("a", "assistant", "`@thorn` says no. Ask @fox, not @nobody or me@thorn.dev.")],
      undefined,
      looks,
    )
    expect(hues(container)).toEqual([
      ["@thorn", "3"],
      ["@fox", "5"],
    ])
    expect(container.querySelector("code")?.textContent).toBe("@thorn")
    expect(container.querySelector(".markdown p")?.textContent).toBe(
      "@thorn says no. Ask @fox, not @nobody or me@thorn.dev.",
    )
  })

  describe("that went to a new terminal", () => {
    // fox was given its handle at 1000, after the earlier terminal that had it closed.
    const given = 1_000
    const later: PeerLooks = (handle, at) =>
      handle === "fox" && (at === undefined || at === null || at >= given)
        ? { face: null, where: null, hue: 5 }
        : null
    const dated = (kind: "user" | "assistant", at: number | null, text: string): ChatBlock => ({
      kind,
      id: "a",
      text,
      truncated: false,
      at,
    })

    it("is drawn in no hue in words written before the terminal had the handle", () => {
      for (const kind of ["user", "assistant"] as const)
        expect(hues(show([dated(kind, given - 1, "Ask @fox")], undefined, later))).toEqual([])
    })

    it("is drawn in its hue in words written at or after the time it was given", () => {
      for (const kind of ["user", "assistant"] as const) {
        expect(hues(show([dated(kind, given, "Ask @fox")], undefined, later))).toEqual([
          ["@fox", "5"],
        ])
        expect(hues(show([dated(kind, given + 5, "Ask `@fox`")], undefined, later))).toEqual([
          ["@fox", "5"],
        ])
      }
    })

    it("is drawn as it was in words with no time", () => {
      expect(hues(show([dated("assistant", null, "Ask @fox")], undefined, later))).toEqual([
        ["@fox", "5"],
      ])
    })

    it("gives an old message from it neither the new terminal's face nor its hue", () => {
      const message = (at: number): ChatBlock => ({
        kind: "agent",
        id: "m",
        author: "@fox",
        text: "Done, ask @fox",
        truncated: false,
        at,
      })
      const withFace: PeerLooks = (handle, at) =>
        later(handle, at) && { face: "face", where: "codex · Runtime", hue: 5 }
      const before = show([message(given - 1)], undefined, withFace)
      expect(before.querySelector(".chat-agent-face")).toBeNull()
      expect(before.querySelector(".chat-agent-where")).toBeNull()
      expect(hues(before)).toEqual([])
      const after = show([message(given)], undefined, withFace)
      expect(after.querySelector(".chat-agent-face")).not.toBeNull()
      expect(hues(after)).toEqual([["@fox", "5"]])
    })
  })

  it("keeps the title after a handle in code, outside its colour", () => {
    const container = show([words("a", "assistant", "`@fox · api-server`")], undefined, looks)
    expect(hues(container)).toEqual([["@fox", "5"]])
    expect(container.querySelector("code")?.textContent).toBe("@fox · api-server")
  })

  it("stays plain in a link and in a fenced block", () => {
    const container = show(
      [words("a", "assistant", "[@thorn](https://example.com)\n\n```\n@thorn\n```")],
      undefined,
      looks,
    )
    expect(hues(container)).toEqual([])
  })

  it("takes the hue in the person's prompt, and in a prompt not in the record yet", () => {
    const container = show(
      [words("u", "user", "Ask @thorn, https://x.dev/@fox")],
      [{ ref: "r", text: "and @fox too", images: [], state: "queued", at: null }],
      looks,
    )
    expect(hues(container)).toEqual([
      ["@thorn", "3"],
      ["@fox", "5"],
    ])
    expect(container.querySelector('[data-role="user"] .chat-text')?.textContent).toBe(
      "Ask @thorn, https://x.dev/@fox",
    )
  })

  it("stays plain where the app knows no agents", () => {
    expect(hues(show([words("u", "user", "Ask @thorn")]))).toEqual([])
  })

  it("is drawn again, in every block that shows it, as the app comes to know the agent", () => {
    const blocks: ChatBlock[] = [
      words("u", "user", "Ask @fox"),
      words("a", "assistant", "Ask @fox"),
      {
        kind: "doorbell",
        id: "d",
        at: null,
        replies: false,
        notices: [],
        messages: [{ id: "m", text: "@fox go", from: { kind: "person" } } as never],
      },
    ]
    const view = (known: PeerLooks) =>
      createElement(Transcript, { blocks, agent: "Claude", working: false, looks: known })
    const { container, unmount, rerender } = render(view(() => null))
    unmounts.push(unmount)
    expect(hues(container)).toEqual([])
    rerender(view(looks))
    expect(hues(container)).toEqual([
      ["@fox", "5"],
      ["@fox", "5"],
      ["@fox", "5"],
    ])
    rerender(view(() => null))
    expect(hues(container)).toEqual([])
  })

  it("takes the hue of a handle in any case, keeping the text as written", () => {
    const container = show([words("a", "assistant", "Ask @Fox")], undefined, looks)
    expect(hues(container)).toEqual([["@Fox", "5"]])
  })
})

context("Novadeck's own notices", () => {
  const worktrees =
    "Novadeck · Worktrees\n@thorn gave you its worktree on fix/x.\n  /home/me/work\n→ Work there with absolute paths.\n→ Don't close it."
  const host = "Novadeck · Resources\nCPU at 90%+ for 3 min."
  const ring = (
    notices: readonly string[],
    messages: ChatBlock extends never ? never : unknown = null,
  ): ChatBlock =>
    ({
      kind: "doorbell",
      id: "d",
      at: 1_000,
      replies: false,
      messages,
      notices: notices.map((text, index) => ({
        id: `n${index}`,
        text,
        sentAt: 900,
        deliveredAt: 1_000,
      })),
    }) as ChatBlock
  // Notices outside a ring, delivered together: standing ones unless `event`.
  const outside = (id: string, texts: readonly string[], event = false): ChatBlock => ({
    kind: "notice",
    id,
    at: 1_000,
    notices: texts.map((text, index) => ({ id: index === 0 ? id : `${id}-${index}`, text, event })),
  })
  const standing = (id: string, text: string): ChatBlock => outside(id, [text])
  const looks: PeerLooks = (handle) =>
    handle === "thorn" ? { face: null, where: null, hue: 3 } : null
  const key = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLButtonElement>(`[data-notice="${id}"] button`)!
  const said = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-notice="${id}"] .chat-notice-said`)?.textContent

  it("tells an event notice as its family's line with Novadeck's mark, never its facts", () => {
    const container = show([ring([worktrees])])
    const line = container.querySelector('[data-notice="n0"]')!
    expect(said(container, "n0")).toBe("You notice news about a worktree.")
    expect(container.textContent).not.toContain("gave you its worktree")
    expect(container.textContent).not.toContain("Novadeck ·")
    expect(line.getAttribute("aria-label")).toBe("Novadeck notice, Worktrees")
    expect(line.querySelector("svg.nova-mark")).not.toBeNull()
    expect(line.querySelector(".chat-notice-rule")).not.toBeNull()
    expect(key(container, "n0").getAttribute("aria-expanded")).toBe("false")
    expect(line.querySelector(".chat-notice-body")).toBeNull()
  })

  it("opens an event notice to the notice itself under its line, each action on its line, and closes it", () => {
    const container = show([ring([worktrees])])
    act(() => key(container, "n0").click())
    expect(key(container, "n0").getAttribute("aria-expanded")).toBe("true")
    expect(said(container, "n0")).toBe("You notice news about a worktree.")
    const body = container.querySelector(".chat-notice-body")!
    expect(body.textContent).toBe(
      "@thorn gave you its worktree on fix/x.\n  /home/me/work\n→ Work there with absolute paths.\n→ Don't close it.",
    )
    expect(key(container, "n0").getAttribute("aria-controls")).toBe(body.id)
    expect(container.textContent).not.toContain("Worktrees")
    act(() => key(container, "n0").click())
    expect(key(container, "n0").getAttribute("aria-expanded")).toBe("false")
    expect(container.querySelector(".chat-notice-body")).toBeNull()
  })

  it("tells a kind an earlier build wrote by its family, a brief from Novadeck as a task, and an old notice as something", () => {
    const line = (text: string) => said(show([ring([text])]), "n0")
    expect(line("Novadeck · Host load\nCPU at 90%.")).toBe("You notice shared resources are busy.")
    expect(line("This is the artist's brief for Novadeck's tour.")).toBe("You notice a new task.")
    expect(line("Novadeck: automatic notice, not from the user: the user is away.")).toBe(
      "You notice something.",
    )
  })

  it("says a ring's notices as one line, each family once, and opens them each under its kind", () => {
    const container = show([ring([worktrees, host, worktrees])])
    expect(container.querySelectorAll("[data-notice]")).toHaveLength(1)
    expect(said(container, "n0")).toBe(
      "You notice news about a worktree. · You notice shared resources are busy.",
    )
    expect(container.querySelector('[data-notice="n0"]')?.getAttribute("aria-label")).toBe(
      "Novadeck notices, Worktrees, Resources",
    )
    act(() => key(container, "n0").click())
    expect(
      [...container.querySelectorAll(".chat-notice-body .chat-notice-kind")].map(
        (each) => each.textContent,
      ),
    ).toEqual(["Worktrees", "Resources", "Worktrees"])
  })

  it("tells an event notice a hook or a Stop's continuation delivered as its line too", () => {
    const container = show([outside("h1", [worktrees], true)])
    const line = container.querySelector('[data-notice="h1"]')!
    expect(line.hasAttribute("data-event")).toBe(true)
    expect(said(container, "h1")).toBe("You notice news about a worktree.")
  })

  it("tells a standing notice by what it is about, in the same quiet style, opening under it", () => {
    const container = show([standing("s1", "Novadeck · Worktrees\nAgent worktrees are on.")])
    const line = container.querySelector('[data-notice="s1"]')!
    expect(line.hasAttribute("data-event")).toBe(false)
    expect(said(container, "s1")).toBe("You notice agent worktrees are on.")
    expect(line.querySelector("svg.nova-mark")).not.toBeNull()
    act(() => key(container, "s1").click())
    expect(said(container, "s1")).toBe("You notice agent worktrees are on.")
    expect(line.querySelector(".chat-notice-body")?.textContent).toBe("Agent worktrees are on.")
  })

  it("keeps the handles in an opened notice's words in their hue, as the chat's other words do", () => {
    const container = show([standing("s1", worktrees)], undefined, looks)
    act(() => key(container, "s1").click())
    expect(
      [...container.querySelectorAll(".chat-notice-body .markdown-mention")].map((each) => [
        each.textContent,
        each.getAttribute("data-hue"),
      ]),
    ).toEqual([["@thorn", "3"]])
  })

  it("attaches the notices of a ring after its messages, as one line", () => {
    const message = { id: "m", text: "Keep it.", from: { kind: "agent", handle: "moth" } }
    const container = show([ring([worktrees, host], [message])])
    const article = container.querySelector(".chat-ring")!
    expect(
      [...article.children].map(
        (child) => child.getAttribute("data-role") ?? child.getAttribute("data-notice"),
      ),
    ).toEqual(["agent", "n0"])
    // Its messages speak for it: no lone doorbell line.
    expect(article.hasAttribute("data-line")).toBe(false)
  })

  it("keeps the lone doorbell line only for a ring with nothing known", () => {
    expect(show([ring([])]).querySelector(".chat-ring .chat-note")?.textContent).toContain(
      "doorbell",
    )
    expect(show([ring([host])]).querySelector(".chat-ring .chat-note")).toBeNull()
  })

  it("says the standing notices a prompt carried as one line: a briefing", () => {
    const container = show([
      words("u", "user", "Tell moth the news"),
      outside("s1", [
        "Novadeck · Show\nBeside this terminal is a bar.",
        "Novadeck · Inbox\nThe Inbox gets a copy.",
        "Novadeck · Describe\nThis terminal has no summary yet.",
        "Novadeck · Worktrees\nAgent worktrees are on.",
      ]),
    ])
    expect(
      [...container.querySelectorAll("[data-role='user'], [data-notice]")].map(
        (each) => each.getAttribute("data-notice") ?? "prompt",
      ),
    ).toEqual(["prompt", "s1"])
    expect(said(container, "s1")).toBe("You notice a briefing.")
    act(() => key(container, "s1").click())
    expect(container.querySelectorAll(".chat-notice-body > .chat-notice-one")).toHaveLength(4)
  })

  it("says an event among standing notices after a briefing", () => {
    const container = show([
      {
        kind: "notice",
        id: "s1",
        at: 1_000,
        notices: [
          { id: "s1", text: "Novadeck · Show\nA bar.", event: false },
          { id: "s2", text: "Novadeck · Inbox\nA copy.", event: false },
          { id: "e1", text: "Novadeck · Restart\nNovadeck restarted.", event: true },
        ],
      },
    ])
    expect(said(container, "s1")).toBe("You notice a briefing. · You notice a restart.")
  })

  it("is drawn again, handles and all, as the app comes to know the agent", () => {
    const blocks = [standing("s1", worktrees)]
    const view = (known: PeerLooks) =>
      createElement(Transcript, { blocks, agent: "Claude", working: false, looks: known })
    const { container, unmount, rerender } = render(view(() => null))
    unmounts.push(unmount)
    act(() => key(container, "s1").click())
    expect(container.querySelectorAll(".markdown-mention")).toHaveLength(0)
    rerender(view(looks))
    expect(container.querySelectorAll(".markdown-mention")).toHaveLength(1)
  })

  it("puts a ring's notices last, after the person's replies from the Inbox too", () => {
    const reply = { id: "r", text: "Round up.", from: { kind: "person" }, sentAt: 900 }
    const agent = { id: "m", text: "Keep it.", from: { kind: "agent", handle: "moth" } }
    const container = show([ring([worktrees], [agent, reply])])
    expect(
      [...container.querySelector(".chat-ring")!.children].map(
        (child) => child.getAttribute("data-role") ?? child.getAttribute("data-notice"),
      ),
    ).toEqual(["agent", "user", "n0"])
  })

  it("gives a ring's notices the time they were delivered", () => {
    const container = show([ring([worktrees, host])])
    expect(container.querySelector('[data-notice="n0"] .chat-fact')?.textContent).toBeTruthy()
  })

  it("counts its notices where the ring tells a screen reader what it brought", () => {
    const message = { id: "m", text: "Keep it.", from: { kind: "agent", handle: "moth" } }
    const label = (blocks: ChatBlock[]) =>
      show(blocks).querySelector(".chat-ring")?.getAttribute("aria-label")
    expect(label([ring([worktrees])])).toBe("Doorbell, a notice")
    expect(label([ring([worktrees, host])])).toBe("Doorbell, 2 notices")
    expect(label([ring([host], [message])])).toBe("Doorbell, 1 message, a notice")
  })
})
