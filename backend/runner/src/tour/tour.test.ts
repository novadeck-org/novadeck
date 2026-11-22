import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Install, Model } from "@novadeck/harness-core/harness"
import type { AgentName, Project } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { harnesses } from "../harnesses/registry.js"
import {
  maxDeliveryBytes,
  novadeckSender,
  tourBriefMark,
  tourFixerMark,
  type Message,
} from "../messaging/messages.js"
import { deliveredBytes } from "../messaging/sending.js"
import { describe, expect, it } from "../test.js"
import { firstFixerTask, nudgeLine, secondFixerBrief, tourBrief } from "./brief.js"
import { tourFolder, tourMarker } from "./folder.js"
import { Tour, withinFolder, type TourHost } from "./tour.js"

// Where a harness lives, for the model lists the tour picks from: Novadeck's own lists ignore it.
const install: Install = { env: {}, home: "/home/x", platform: "linux", plugin: "/plugins" }

const conflict = (error: unknown): boolean =>
  error instanceof DomainError && error.code === "CONFLICT"

const tourIn = (
  home: string,
  options: {
    projects?: Project[]
    connected?: readonly AgentName[]
    notices?: [string, string][]
    shown?: readonly string[]
    models?: readonly Model[]
    // Models by harness, over the harnesses' own lists.
    lists?: Partial<Record<AgentName, readonly Model[]>>
    // How each removal goes; at once by default.
    removal?: () => Promise<void>
    // Each terminal's folder; the tour's own by default.
    cwds?: Readonly<Record<string, string>>
    // The terminal leading each led terminal.
    leads?: Readonly<Record<string, string>>
    // The terminals that are plain shells at their prompt.
    shells?: readonly string[]
    // The terminals typing into which fails, as a closed terminal's.
    failing?: readonly string[]
    // The terminals an agent has run in.
    ran?: readonly string[]
    // What an adoption waits for, as a shell's first prompt, before it goes on.
    gate?: Promise<void>
  } = {},
) => {
  const projects = options.projects ?? []
  const rung = options.notices ?? []
  const removed: string[] = []
  // What the tour did to the terminals: the lines typed, the leads set, the agents expected.
  const typed: [string, string, string][] = []
  const adopted: [string, string][] = []
  const expected: [string, AgentName][] = []
  let folders = 0
  const host: TourHost = {
    home,
    connected: (agent) => Promise.resolve((options.connected ?? ["claude"]).includes(agent)),
    models: (agent) =>
      options.lists?.[agent]
        ? Promise.resolve(options.lists[agent])
        : options.models
          ? Promise.resolve(options.models)
          : harnesses[agent].launch.models(install),
    projects: {
      list: () => projects.filter(({ id }) => !removed.includes(id)),
      remove: (id) => {
        if (removed.includes(id)) return Promise.reject(new DomainError("NOT_FOUND"))
        removed.push(id)
        return options.removal?.() ?? Promise.resolve()
      },
    },
    notice: (terminalId, text) => {
      if (!(options.shown ?? ["lead"]).includes(terminalId)) return false
      rung.push([terminalId, text])
      return true
    },
    cwdOf: (terminalId) => options.cwds?.[terminalId] ?? tourFolder(home),
    leadOf: (terminalId) => options.leads?.[terminalId],
    handleOf: (terminalId) => `h-${terminalId}`,
    ranAgent: (terminalId) => (options.ran ?? []).includes(terminalId),
    isFreshShell: (terminalId) => (options.shells ?? []).includes(terminalId),
    adopt: async (terminalId, leadId, before) => {
      await options.gate
      before()
      adopted.push([terminalId, leadId])
    },
    expect: (terminalId, agent) => void expected.push([terminalId, agent]),
    type: (terminalId, line, ownerId) => {
      if (options.failing?.includes(terminalId)) throw new DomainError("TERMINAL_EXITED", "closed")
      typed.push([terminalId, line, ownerId])
    },
    worktreesFolder: () => void folders++,
  }
  const tour = new Tour(host)
  // The lead's brief as the tour rings it now, composed of the run last readied.
  const brief = (): string => {
    tour.brief("lead")
    return rung.at(-1)![1]
  }
  return {
    tour,
    removed,
    brief,
    typed,
    adopted,
    expected,
    folders: () => folders,
  }
}

const project = (id: string, cwd: string): Project => ({ id, name: id, cwd, pinned: false })

const scratchHome = async (resources: { defer: (cleanup: () => Promise<void>) => void }) => {
  const home = await mkdtemp(join(tmpdir(), "novadeck-tour-home-"))
  resources.defer(() => rm(home, { recursive: true, force: true }))
  return home
}

describe("readying the tour", () => {
  it("writes the brief in the folder and answers the launch line", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home)
    const prepared = await tour.prepare("claude")
    const directory = tourFolder(home)
    expect(prepared).toMatchObject({ directory, brief: "doorbell", model: "haiku", removed: [] })
    expect(prepared.command).toMatch(/^claude --model haiku /)
    expect((await readdir(directory)).toSorted()).toEqual(
      [".claude", ".git", "AGENTS.md", "CLAUDE.md", "README.md", "split.js", tourMarker].toSorted(),
    )
    expect(await readFile(join(directory, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n")
    // Both bugs are in one file, so the merged preview shows both fixes.
    const source = await readFile(join(directory, "split.js"), "utf8")
    expect(source).toContain("(total + total * tip) / people")
    expect(source).toContain("amount.toFixed(1)")
    expect(JSON.parse(await readFile(join(directory, ".claude", "settings.json"), "utf8"))).toEqual(
      {
        permissions: { defaultMode: "acceptEdits" },
      },
    )
  })

  it("removes the projects open at its folder, and no other", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour, removed } = tourIn(home, {
      projects: [project("old-tour", tourFolder(home)), project("mine", join(home, "code"))],
    })
    const prepared = await tour.prepare("claude")
    expect(prepared.removed).toEqual(["old-tour"])
    expect(removed).toEqual(["old-tour"])
  })

  it("refuses an agent Novadeck isn't connected to, changing nothing", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour, removed } = tourIn(home, {
      connected: ["claude"],
      projects: [project("old-tour", tourFolder(home))],
    })
    await expect(tour.prepare("codex")).rejects.toSatisfy(conflict)
    expect(removed).toEqual([])
    await expect(readdir(tourFolder(home))).rejects.toThrow()
  })

  it("removes a project inside its folder too", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home, {
      projects: [project("inside", join(tourFolder(home), "site"))],
    })
    await expect(tour.prepare("claude")).resolves.toMatchObject({ removed: ["inside"] })
  })

  it("empties its folder only once a removal under way has closed its terminals", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const directory = tourFolder(home)
    const { tour: first } = tourIn(home)
    await first.prepare("claude")
    let closed: () => void = () => {}
    const { tour } = tourIn(home, {
      projects: [project("closing", directory)],
      removal: () => new Promise<void>((resolve) => (closed = resolve)),
    })
    const prepared = tour.prepare("claude")
    // Still closing: what the earlier run left is untouched.
    await writeFile(join(directory, "index.html"), "<p>made</p>")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await readdir(directory)).toContain("index.html")
    closed()
    await prepared
    expect(await readdir(directory)).not.toContain("index.html")
  })

  it("refuses an agent whose cheapest model can't be told, changing nothing", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const { tour, removed } = tourIn(home, {
      connected: ["codex"],
      models: [],
      projects: [project("old-tour", tourFolder(home))],
    })
    await expect(tour.prepare("codex")).rejects.toSatisfy(
      (error: unknown) => error instanceof DomainError && error.code === "MODELS_UNLISTED",
    )
    expect(removed).toEqual([])
    await expect(readdir(tourFolder(home))).rejects.toThrow()
  })

  for (const agent of ["claude", "codex", "agy"] as const)
    it(`refuses a folder of the person's own before removing any project, with ${agent}`, async ({
      resources,
    }) => {
      const home = await scratchHome(resources)
      const directory = tourFolder(home)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, "notes.md"), "mine\n")
      const { tour, removed } = tourIn(home, {
        connected: [agent],
        lists: { codex: [{ id: "gpt-e2e-luna", efforts: ["low"] }] },
        projects: [project("mine", directory), project("inside", join(directory, "site"))],
      })
      await expect(tour.prepare(agent)).rejects.toSatisfy(conflict)
      expect(removed).toEqual([])
      expect(await readdir(directory)).toEqual(["notes.md"])
    })

  it("refuses a second run while the first is being readied", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home)
    const first = tour.prepare("claude")
    await expect(tour.prepare("claude")).rejects.toSatisfy(conflict)
    await first
    await expect(tour.prepare("claude")).resolves.toMatchObject({ brief: "doorbell" })
  })

  it("leaves Antigravity's start line to the doorbell", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home, { connected: ["agy"] })
    await expect(tour.prepare("agy")).resolves.toMatchObject({ brief: "doorbell" })
  })
})

// The arguments the brief gives `open_agent` for its fixer.
const opened = (text: string): string[] =>
  [...text.matchAll(/Call `open_agent` with (agent "[^\n]*?)(?:, and as|\n)/g)].map(
    ([, each]) => each!,
  )

const luna: Model = { id: "gpt-e2e-luna", efforts: ["low", "medium"] }

describe("the sandbox repo", () => {
  it("is a git repo on main with one commit by the tour, the marker kept out of it", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home)
    await tour.prepare("claude")
    const directory = tourFolder(home)
    const gitIn = (...args: string[]) =>
      execFileSync("git", ["-C", directory, ...args], {
        encoding: "utf8",
      }).trim()
    expect(gitIn("branch", "--show-current")).toBe("main")
    expect(gitIn("rev-list", "--count", "HEAD")).toBe("1")
    expect(gitIn("log", "--format=%an <%ae>")).toBe("Novadeck tour <tour@novadeck.invalid>")
    expect(gitIn("status", "--porcelain")).toBe("")
    expect(gitIn("ls-files").split("\n").toSorted()).toEqual(
      [".claude/settings.json", "AGENTS.md", "CLAUDE.md", "README.md", "split.js"].toSorted(),
    )
  })

  it("is made afresh for each run, one commit again", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home)
    await tour.prepare("claude")
    const directory = tourFolder(home)
    await writeFile(join(directory, "split.js"), "changed\n")
    await tour.prepare("claude")
    expect(await readFile(join(directory, "split.js"), "utf8")).toContain("share")
    expect(
      execFileSync("git", ["-C", directory, "rev-list", "--count", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("1")
  })

  it("makes the folder agents' worktrees live in", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour, folders } = tourIn(home)
    await tour.prepare("claude")
    expect(folders()).toBe(1)
  })
})

describe("the brief's facts", () => {
  it("has a lead's own harness open its fixer on its cheapest model", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour, brief } = tourIn(home)
    await tour.prepare("claude")
    const text = brief()
    expect(text).toContain("bill splitter with two bugs")
    expect(text).toContain('branch "fix-tip"')
    expect(opened(text)).toEqual(['agent "claude", model "haiku", effort "low"'])
  })

  it("keeps the fixer on the lead's harness and its cheapest model, whatever else is connected", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const { tour, brief } = tourIn(home, {
      connected: ["claude", "codex", "agy"],
      lists: { codex: [luna] },
    })
    await tour.prepare("agy")
    expect(opened(brief())).toEqual([expect.stringMatching(/^agent "agy", model "/)])
    await tour.prepare("claude")
    expect(opened(brief())).toEqual(['agent "claude", model "haiku", effort "low"'])
    await tour.prepare("codex")
    expect(opened(brief())).toEqual(['agent "codex", model "gpt-e2e-luna", effort "low"'])
  })

  it("leaves out an effort a model takes none of", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour, brief } = tourIn(home, {
      connected: ["codex"],
      lists: { codex: [{ id: "gpt-e2e-luna", efforts: [] }] },
    })
    await tour.prepare("codex")
    expect(opened(brief())).toEqual(['agent "codex", model "gpt-e2e-luna"'])
  })

  it("never names the person, and tells its agents not to", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour, brief } = tourIn(home)
    await tour.prepare("claude")
    const text = brief()
    expect(text).toContain("Never use the person's name, even if you know it")
    expect(text).not.toMatch(/\bNAME\b/)
  })
})

// A notice as the doorbell delivers it, to count its bytes against one delivery.
const noticeOf = (text: string): Message => ({
  id: "m1",
  projectId: "p1",
  thread: "t-notice-m1",
  hop: 1,
  from: novadeckSender,
  to: { terminalId: "t1", handle: "moth", agent: "claude", sessionId: null },
  text,
  sentAt: 0,
  state: "queued",
  deliveredAt: null,
  notified: true,
  stopped: false,
  fromLead: false,
  toLead: false,
})

describe("ringing the tour's brief", () => {
  it("rings the lead's whole script to the terminal's agent", async ({ resources }) => {
    const home = await scratchHome(resources)
    const notices: [string, string][] = []
    const { tour } = tourIn(home, { notices, shown: ["t1"] })
    await tour.prepare("claude")
    tour.brief("t1")
    expect(notices).toHaveLength(1)
    const [id, text] = notices[0]!
    expect(id).toBe("t1")
    expect(text.startsWith(tourBriefMark)).toBe(true)
    expect(text).toContain("## Steps")
    // The fixer's task goes in whole, with what the doorbell frames.
    expect(text).toContain('Call `open_worktree` with branch "fix-tip"')
    // Delivered whole: wrapped as Novadeck's notice, in every harness, it fits one delivery,
    // which a harness takes no more than (a brief past it is rung but never handed over).
    expect(deliveredBytes(noticeOf(text))).toBeLessThanOrEqual(maxDeliveryBytes)
    // And so it does on the longest harness and model names, as `agy`'s.
    const longest = tourBrief({
      lead: "@a-twenty-char-name-x",
      fixer: {
        agent: "agy",
        model: "gemini-3-flash-lite-preview",
        effort: "medium",
      },
    })
    expect(deliveredBytes(noticeOf(longest))).toBeLessThanOrEqual(maxDeliveryBytes)
  })

  it("is refused before a run is readied", () => {
    const { tour } = tourIn("/nowhere")
    expect(() => tour.brief("lead")).toThrow(/hasn't been readied/)
  })

  it("refuses a terminal whose agent hasn't shown yet", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home, { shown: [] })
    await tour.prepare("claude")
    expect(() => tour.brief("t1")).toThrow(DomainError)
  })

  it("rings only the tour's own terminals", async ({ resources }) => {
    const home = await scratchHome(resources)
    const notices: [string, string][] = []
    const { tour } = tourIn(home, { notices, shown: ["mine"], cwds: { mine: "/h/code" } })
    await tour.prepare("claude")
    expect(() => tour.brief("mine")).toThrow(/isn't one of the tour's/)
    expect(notices).toEqual([])
  })
})

describe("the second fixer's brief", () => {
  it("fits one delivery, with a long handle for its lead", () => {
    const text = secondFixerBrief("@a-twenty-char-name-x")
    expect(text.startsWith(tourFixerMark)).toBe(true)
    expect(deliveredBytes(noticeOf(text))).toBeLessThanOrEqual(maxDeliveryBytes)
  })

  it("is the one the lead's brief quotes for the first, which is no notice", () => {
    expect(tourBrief({ lead: "@fox", fixer: { agent: "claude", model: "haiku" } })).toContain(
      "> You are Tip fixer, a teammate in Novadeck's tour.",
    )
  })

  it("asks the person which whole amounts show, then fixes money in its own worktree", () => {
    const text = secondFixerBrief("@moth")
    expect(text).toContain('branch "fix-money"')
    expect(text).toContain("Whole amounts: $12.00 or $12?")
    expect(text).toContain('"recommend":0')
    expect(text).toContain('dismissed the question, use "$12.00"')
    expect(text).toContain('`to` "@moth"')
    expect(text).toMatch(/Run no\s+shell command and never call `open_agent`/)
  })

  it("has the first fixer fix the tip in its own worktree by absolute path", () => {
    const task = firstFixerTask("@fox")
    expect(task).toContain('branch "fix-tip"')
    expect(task).toContain("(total + total * tip / 100) / people")
    expect(task).toContain("by its absolute path")
    expect(task).toContain("Fixed bug 1.")
    // It answers to the lead's handle, never a terminal id.
    expect(task).toContain('`to` "@fox"')
  })
})

describe("taking the person's terminal as the second fixer", () => {
  const ready = async (
    resources: { defer: (cleanup: () => Promise<void>) => void },
    options: Parameters<typeof tourIn>[1] = {},
  ) => {
    const home = await scratchHome(resources)
    const notices: [string, string][] = []
    const made = tourIn(home, {
      notices,
      shown: ["lead", "mine", "next"],
      shells: ["mine"],
      ...options,
      cwds: {
        lead: tourFolder(home),
        mine: tourFolder(home),
        next: tourFolder(home),
        ...options.cwds,
      },
    })
    await made.tour.prepare("claude")
    return { ...made, notices, home }
  }

  it("types the launch line, makes the lead its lead, and rings it the brief", async ({
    resources,
  }) => {
    const { tour, brief, typed, adopted, expected, notices } = await ready(resources)
    brief()
    await tour.fixer("mine", "window")
    expect(typed).toHaveLength(1)
    expect(typed[0]).toEqual([
      "mine",
      expect.stringMatching(/^claude --model haiku .*--permission-mode acceptEdits/),
      "window",
    ])
    expect(adopted).toEqual([["mine", "lead"]])
    expect(expected).toEqual([["mine", "claude"]])
    const [id, text] = notices.at(-1)!
    expect(id).toBe("mine")
    expect(text).toBe(secondFixerBrief("@h-lead"))
  })

  it("is for a run once", async ({ resources }) => {
    const { tour, brief, typed } = await ready(resources, {
      shells: ["mine", "again"],
    })
    brief()
    await tour.fixer("mine", "window")
    await expect(tour.fixer("again", "window")).rejects.toThrow(/started already/)
    expect(typed).toHaveLength(1)
  })

  it("waits for the lead to have started, and for a run", async ({ resources }) => {
    const { tour } = await ready(resources)
    await expect(tour.fixer("mine", "window")).rejects.toThrow(/lead hasn't started/)
    const none = tourIn("/nowhere").tour
    await expect(none.fixer("mine", "window")).rejects.toThrow(/hasn't been readied/)
  })

  it("refuses a terminal elsewhere, one with an agent or a lead, and the lead itself, changing nothing", async ({
    resources,
  }) => {
    const { tour, brief, typed, adopted } = await ready(resources, {
      shells: ["mine", "away"],
      cwds: { away: "/h/code" },
      leads: { led: "lead" },
    })
    brief()
    await expect(tour.fixer("away", "window")).rejects.toThrow(/isn't one of the tour's/)
    await expect(tour.fixer("led", "window")).rejects.toThrow(/lead or a teammate/)
    await expect(tour.fixer("lead", "window")).rejects.toThrow(/lead or a teammate/)
    await expect(tour.fixer("busy", "window")).rejects.toThrow(DomainError)
    expect(typed).toEqual([])
    expect(adopted).toEqual([])
  })

  it("refuses a terminal that isn't a plain shell at its prompt", async ({ resources }) => {
    const { tour, brief, typed } = await ready(resources, { shells: [] })
    brief()
    await expect(tour.fixer("mine", "window")).rejects.toThrow(/plain shell/)
    expect(typed).toEqual([])
  })

  it("asks a shell still loading its profile nothing of its prompt until it has shown one", async ({
    resources,
  }) => {
    let open = (): void => {}
    const gate = new Promise<void>((resolve) => (open = resolve))
    const shells: string[] = []
    const { tour, brief, typed } = await ready(resources, { shells, gate })
    brief()
    const done = tour.fixer("mine", "window")
    // Not refused for being busy meanwhile: it settles once its prompt is there.
    shells.push("mine")
    open()
    await done
    expect(typed.map(([id]) => id)).toEqual(["mine"])
  })

  it("answers a second call, while the first waits, as one to ask again, and a conflict once adopted", async ({
    resources,
  }) => {
    let open = (): void => {}
    const gate = new Promise<void>((resolve) => (open = resolve))
    const { tour, brief } = await ready(resources, { shells: ["mine", "other"], gate })
    brief()
    const first = tour.fixer("mine", "window")
    await expect(tour.fixer("other", "window")).rejects.toMatchObject({ code: "CONTROL_IN_USE" })
    open()
    await first
    await expect(tour.fixer("other", "window")).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("gives the claim back where the shell isn't plain once its prompt is there", async ({
    resources,
  }) => {
    let open = (): void => {}
    const gate = new Promise<void>((resolve) => (open = resolve))
    const shells = ["mine", "next"]
    const { tour, brief, typed } = await ready(resources, { shells, gate })
    brief()
    const first = tour.fixer("mine", "window")
    // The person ran something in it meanwhile.
    shells.splice(0, 1)
    open()
    await expect(first).rejects.toThrow(/plain shell/)
    await tour.fixer("next", "window")
    expect(typed.map(([id]) => id)).toEqual(["next"])
  })

  it("refuses a shell an agent has run in, before it waits for anything", async ({ resources }) => {
    const { tour, brief, typed } = await ready(resources, { shells: ["mine"], ran: ["mine"] })
    brief()
    await expect(tour.fixer("mine", "window")).rejects.toThrow(/plain shell/)
    expect(typed).toEqual([])
  })

  it("gives the run back where typing fails, so the person's next terminal can be taken", async ({
    resources,
  }) => {
    const { tour, brief, typed, adopted } = await ready(resources, {
      shells: ["mine", "next"],
      failing: ["mine"],
    })
    brief()
    await expect(tour.fixer("mine", "window")).rejects.toThrow(/closed/)
    expect(adopted).toEqual([])
    await tour.fixer("next", "window")
    expect(typed.map(([id]) => id)).toEqual(["next"])
  })
})

describe("nudging the tour's agent", () => {
  it("rings it a fixed line to carry on from its step, in the tour's folder only", () => {
    const notices: [string, string][] = []
    const { tour } = tourIn("/h", {
      notices,
      shown: ["lead", "elsewhere"],
      cwds: { elsewhere: "/h/code" },
    })
    tour.nudge("lead")
    expect(notices).toEqual([["lead", nudgeLine]])
    expect(() => tour.nudge("elsewhere")).toThrow(DomainError)
  })
})

describe("a project's folder within the tour's", () => {
  it("is the folder itself or one inside it, never one beside it", () => {
    expect(withinFolder("/h/.novadeck/tour", "/h/.novadeck/tour", "linux")).toBe(true)
    expect(withinFolder("/h/.novadeck/tour/site/", "/h/.novadeck/tour", "linux")).toBe(true)
    expect(withinFolder("/h/.novadeck/tour-old", "/h/.novadeck/tour", "linux")).toBe(false)
    expect(withinFolder("/h/.novadeck", "/h/.novadeck/tour", "linux")).toBe(false)
  })

  it("tells cases apart only where the file system does", () => {
    expect(withinFolder("/h/.Novadeck/Tour", "/h/.novadeck/tour", "linux")).toBe(false)
    expect(withinFolder("/h/.Novadeck/Tour", "/h/.novadeck/tour", "darwin")).toBe(true)
    expect(
      withinFolder("C:\\Users\\x\\.Novadeck\\TOUR", "c:/users/x/.novadeck/tour", "win32"),
    ).toBe(true)
  })
})

describe("the brief's wording", () => {
  it("keeps the nudge from making an agent redo a step", () => {
    expect(nudgeLine).toContain("Don't redo a step.")
  })

  it("leaves the choice to the person, and says the second fixer joins", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour, brief } = tourIn(home)
    await tour.prepare("claude")
    const text = brief()
    expect(text).toContain("Never answer a fixer's question to the person yourself")
    expect(text).toMatch(/Never open a second\s+fixer yourself/)
    expect(text).toContain("both bugs are fixed, each in its own worktree")
  })
})

describe("what the folder's own instructions say", () => {
  it("holds no role and no step in the files a harness loads by itself", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home)
    await tour.prepare("claude")
    const folder = tourFolder(home)
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      // eslint-disable-next-line no-await-in-loop -- Two small files.
      const text = await readFile(join(folder, name), "utf8")
      expect(text).not.toMatch(/open_agent|lead agent|Steps|describe/)
    }
    const note = await readFile(join(folder, "AGENTS.md"), "utf8")
    expect(note.replaceAll(/\s+/g, " ")).toContain("If you were given a task, do only that task.")
    expect(note).toContain("run no shell command")
    expect(nudgeLine).toContain("tour brief Novadeck sent you")
  })

  it("has the brief tell the lead to run no shell and never edit, and each fixer never to open agents", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const { tour, brief } = tourIn(home)
    await tour.prepare("claude")
    const text = brief()
    expect(text).toContain("Run no shell command at all")
    expect(text).toContain("Never edit a file yourself")
    expect(text).toContain("never call `open_agent`")
    expect(text.match(/if\s+they're\s+deferred, load them first/g)?.length).toBe(2)
    expect(text).toContain("don't explain,")
    expect(secondFixerBrief("@moth")).toContain("if they're deferred, load them first")
  })
})

describe("what an agent's open_agent is subject to in the tour", () => {
  it("refuses a teammate in the folder", () => {
    const { tour } = tourIn("/h", { leads: { mate: "lead" } })
    expect(tour.openPolicy("mate").refusal).toMatch(/only the tour's lead opens agents/)
  })

  it("starts the lead's agents with the tour's write flags, for each harness", () => {
    const { tour } = tourIn("/h")
    const policy = tour.openPolicy("lead")
    expect(policy.refusal).toBeUndefined()
    const at = "/h/.novadeck/tour"
    expect(policy.flags?.("claude", at)).toEqual(["--permission-mode", "acceptEdits"])
    expect(policy.flags?.("codex", at)).toEqual([
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
    ])
    expect(policy.flags?.("agy", at)).toEqual(["--mode", "accept-edits"])
  })

  it("gives the lead's agents no write flags where they start outside the tour's folder", () => {
    const { tour } = tourIn("/h")
    const policy = tour.openPolicy("lead")
    expect(policy.flags?.("claude", "/h/code")).toEqual([])
    expect(policy.flags?.("codex", "/h/.novadeck/tour/sub")).not.toEqual([])
  })

  it.skipIf(process.platform === "win32")(
    "gives write flags to an agent that starts in the tour's folder by its real path, where the home is a link",
    async ({ resources }) => {
      const real = await scratchHome(resources)
      await mkdir(join(real, ".novadeck", "tour"), { recursive: true })
      const linked = join(await scratchHome(resources), "home")
      await symlink(real, linked)
      const { tour } = tourIn(linked)
      const policy = tour.openPolicy("lead")
      expect(policy.flags?.("claude", join(real, ".novadeck", "tour"))).toEqual([
        "--permission-mode",
        "acceptEdits",
      ])
      expect(tour.isTours("lead")).toBe(true)
    },
  )

  it("leaves a led terminal elsewhere, and a terminal the runner doesn't have, alone", () => {
    const { tour } = tourIn("/h", {
      leads: { mate: "lead", away: "lead" },
      cwds: { away: "/h/code" },
    })
    expect(tour.openPolicy("away")).toEqual({})
  })
})

describe("which terminals are the tour's", () => {
  it("are those in its folder, and none the runner doesn't have", () => {
    const { tour } = tourIn("/h", { cwds: { away: "/h/code" } })
    expect(tour.isTours("lead")).toBe(true)
    expect(tour.isTours("away")).toBe(false)
  })
})
