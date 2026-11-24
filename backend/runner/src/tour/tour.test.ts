import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentName, Project } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import {
  maxDeliveryBytes,
  novadeckSender,
  tourBriefMark,
  type Message,
} from "../messaging/messages.js"
import { deliveredBytes } from "../messaging/sending.js"
import { describe, expect, it } from "../test.js"
import {
  branches,
  builderTask,
  keptLine,
  modellerTask,
  nudgeLine,
  projectNote,
  sandboxNote,
  shellRule,
  tourBrief,
  type Serving,
} from "./brief.js"
import { tourFolder, tourMarker } from "./folder.js"
import { TourRecords } from "./records.js"
import { repositoryAssets, type TourAssets } from "./seed.js"
import type { Ticket } from "./ticket.js"
import { Tour, type TourHost } from "./tour.js"

const conflict = (error: unknown): boolean =>
  error instanceof DomainError && error.code === "CONFLICT"

// How the dev server runs, unless a test says otherwise: not what this computer has.
const served: Serving = { command: "node dev.mjs 5173", url: "http://127.0.0.1:5173/" }

const tourIn = (
  home: string,
  options: {
    projects?: Project[]
    connected?: readonly AgentName[]
    // The ticket the tour's service gives, or the refusal it makes; one by default.
    ticket?: () => Promise<Ticket>
    // What the runs were given, as a runner started again finds it.
    records?: TourRecords
    notices?: [string, string][]
    shown?: readonly string[]
    // How each removal goes; at once by default.
    removal?: () => Promise<void>
    // Each terminal's folder; the tour's own by default.
    cwds?: Readonly<Record<string, string>>
    // The terminal leading each led terminal.
    leads?: Readonly<Record<string, string>>
    // How the dev server runs here; `served` by default.
    serving?: Serving | null
    // Where the seed's files are, if not in the repository.
    assets?: TourAssets
    // Terminals that refuse a notice with an error, as one that is gone.
    gone?: readonly string[]
  } = {},
) => {
  const projects = options.projects ?? []
  const rung = options.notices ?? []
  const removed: string[] = []
  let folders = 0
  const host: TourHost = {
    home,
    ...(options.assets !== undefined && { assets: options.assets }),
    serving: () => Promise.resolve(options.serving === undefined ? served : options.serving),
    connected: (agent) => Promise.resolve((options.connected ?? ["opencode"]).includes(agent)),
    ticket: options.ticket ?? (() => Promise.resolve({ ticket: "TICKET_1" })),
    ...(options.records !== undefined && { records: options.records }),
    projects: {
      list: () => projects.filter(({ id }) => !removed.includes(id)),
      remove: (id) => {
        if (removed.includes(id)) return Promise.reject(new DomainError("NOT_FOUND"))
        removed.push(id)
        return options.removal?.() ?? Promise.resolve()
      },
    },
    notice: (terminalId, text) => {
      if (options.gone?.includes(terminalId)) throw new DomainError("TERMINAL_NOT_FOUND")
      if (!(options.shown ?? ["lead"]).includes(terminalId)) return false
      rung.push([terminalId, text])
      return true
    },
    cwdOf: (terminalId) => options.cwds?.[terminalId] ?? tourFolder(home),
    leadOf: (terminalId) => options.leads?.[terminalId],
    handleOf: (terminalId) => `h-${terminalId}`,
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
    folders: () => folders,
  }
}

const project = (id: string, cwd: string): Project => ({ id, name: id, cwd, pinned: false })

const scratchHome = async (resources: { defer: (cleanup: () => Promise<void>) => void }) => {
  const home = await mkdtemp(join(tmpdir(), "novadeck-tour-home-"))
  resources.defer(() => rm(home, { recursive: true, force: true }))
  return home
}

type Resources = { defer: (cleanup: () => Promise<void>) => void }

// A run readied in a scratch home, its notices kept, with the terminals `lead`, `mine` and `next`
// showing in the tour's folder unless the options say otherwise.
const readied = async (resources: Resources, options: Parameters<typeof tourIn>[1] = {}) => {
  const home = await scratchHome(resources)
  const notices: [string, string][] = []
  const made = tourIn(home, { notices, shown: ["lead", "mine", "next"], ...options })
  await made.tour.prepare()
  return { ...made, notices, home }
}

// What is in a folder, every file by its name with `/`.
const filesOf = async (folder: string, prefix = ""): Promise<string[]> => {
  const entries = await readdir(join(folder, prefix), { withFileTypes: true })
  const names = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? filesOf(folder, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    ),
  )
  return names.flat()
}

describe("readying the tour", () => {
  it("writes the seed project, the libraries and the brief's files, and answers the launch line", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home)
    const prepared = await tour.prepare()
    const directory = tourFolder(home)
    expect(prepared).toMatchObject({
      directory,
      brief: "doorbell",
      model: "openrouter/openai/gpt-6-luna",
      removed: [],
      page: true,
    })
    expect(prepared.command).toBe(
      "opencode --model openrouter/openai/gpt-6-luna --variant medium --agent build",
    )
    const files = await filesOf(directory)
    expect(files).toEqual(
      expect.arrayContaining([
        tourMarker,
        "AGENTS.md",
        "CLAUDE.md",
        ".claude/settings.json",
        ".gitignore",
        "README.md",
        "dev.mjs",
        "dev.py",
        "index.html",
        "models/README.md",
        "models/placeholder.gltf",
        "models/shapes.bin",
        "src/main.js",
        "src/models.js",
        "vendor/phaser/phaser.min.js",
        "vendor/phaser/LICENSE.md",
        "vendor/three/build/three.module.js",
        "vendor/three/build/three.core.js",
        "vendor/three/examples/jsm/loaders/GLTFLoader.js",
        "vendor/three/examples/jsm/utils/BufferGeometryUtils.js",
        "vendor/three/examples/jsm/utils/SkeletonUtils.js",
        "vendor/three/LICENSE",
      ]),
    )
    // The tour's own maker of the model's shapes isn't part of the project.
    expect(files).not.toContain("make-shapes.mjs")
    expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(sandboxNote("opencode"))
    expect(await readFile(join(directory, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n")
    expect(JSON.parse(await readFile(join(directory, ".claude", "settings.json"), "utf8"))).toEqual(
      { permissions: { defaultMode: "acceptEdits" } },
    )
    // The model's binary is written as it is.
    const assets = await repositoryAssets()
    expect(await readFile(join(directory, "models", "shapes.bin"))).toEqual(
      await readFile(join(assets.seed, "models", "shapes.bin")),
    )
    expect((await stat(join(directory, "vendor", "phaser", "phaser.min.js"))).size).toBeGreaterThan(
      100_000,
    )
  })

  it("says there is no page where the dev server can't run here", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home, { serving: null })
    await expect(tour.prepare()).resolves.toMatchObject({ page: false })
  })

  it("removes the projects open at its folder, and no other", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour, removed } = tourIn(home, {
      projects: [project("old-tour", tourFolder(home)), project("mine", join(home, "code"))],
    })
    const prepared = await tour.prepare()
    expect(prepared.removed).toEqual(["old-tour"])
    expect(removed).toEqual(["old-tour"])
  })

  it("refuses where opencode isn't connected, changing nothing and asking for no ticket", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const asked: string[] = []
    const { tour, removed } = tourIn(home, {
      connected: ["claude", "codex"],
      projects: [project("old-tour", tourFolder(home))],
      ticket: () => (asked.push("ticket"), Promise.resolve({ ticket: "T" })),
    })
    await expect(tour.prepare()).rejects.toSatisfy(conflict)
    expect(removed).toEqual([])
    expect(asked).toEqual([])
    await expect(readdir(tourFolder(home))).rejects.toThrow()
  })

  it("shows the service's refusal as it words it, changing nothing", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour, removed } = tourIn(home, {
      projects: [project("old-tour", tourFolder(home))],
      ticket: () => Promise.reject(new DomainError("CONFLICT", "You've used today's free tours.")),
    })
    await expect(tour.prepare()).rejects.toThrow("You've used today's free tours.")
    expect(removed).toEqual([])
    await expect(readdir(tourFolder(home))).rejects.toThrow()
    // A refused run starts none, so a next one isn't "already starting".
    await expect(tour.prepare()).rejects.toThrow("free tours")
  })

  it("gives the opencode of its terminals the ticket, and the service's address, in their environment", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const projects: Project[] = []
    const { tour } = tourIn(home, {
      projects,
      ticket: () => Promise.resolve({ ticket: "TICKET_9", expiresAt: "2099-01-01T00:00:00Z" }),
    })
    expect(tour.launchEnv(tourFolder(home))).toBeUndefined()
    await tour.prepare()
    // The client opens the folder as a project, and then starts its terminals.
    projects.push(project("tour", tourFolder(home)))
    const config = JSON.parse(tour.launchEnv(tourFolder(home))!.NOVADECK_OPENCODE_CONFIG!)
    expect(config).toMatchObject({
      provider: { openrouter: { options: { apiKey: "TICKET_9" } } },
      model: "openrouter/openai/gpt-6-luna",
      small_model: "openrouter/openai/gpt-6-luna",
      agent: {
        build: { model: "openrouter/openai/gpt-6-luna", variant: "medium" },
        plan: { model: "openrouter/openai/gpt-6-luna", variant: "medium" },
      },
    })
    expect(config.provider.openrouter.options.baseURL).toMatch(/\/tour\/v1$|^http/)
    // Only the tour's folders.
    expect(tour.launchEnv(join(home, "elsewhere"))).toBeUndefined()
    // Another run's terminal in the folder, started afresh by a command, gets it too while it is live.
    expect(tour.launchEnv(join(tourFolder(home), "src"))).toBeDefined()
    // The person keeping the project: what they open afresh there is theirs, with their own
    // configuration; a terminal resumed there keeps the model on its line, so the ticket too.
    await tour.keep()
    expect(tour.launchEnv(join(tourFolder(home), "src"))).toBeUndefined()
    expect(tour.launchEnv(join(tourFolder(home), "src"), true)).toBeDefined()
  })

  it("keeps the run for a runner started again, through keeping and the ticket's end, until the project goes", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const file = join(home, "tour-runs.json")
    const projects: Project[] = []
    const first = tourIn(home, {
      projects,
      records: new TourRecords(file),
      ticket: () => Promise.resolve({ ticket: "TICKET_7", expiresAt: "2000-01-01T00:00:00Z" }),
    })
    await first.tour.prepare()
    projects.push(project("tour", tourFolder(home)))
    await first.tour.keep()
    // The runner starts again: nothing of the run is in memory, the person's terminals resume.
    const again = tourIn(home, { projects, records: new TourRecords(file) })
    // A fresh agent the person opens is theirs; a resumed terminal keeps the tour's.
    expect(again.tour.launchEnv(tourFolder(home))).toBeUndefined()
    const env = again.tour.launchEnv(tourFolder(home), true)
    expect(JSON.parse(env!.NOVADECK_OPENCODE_CONFIG!).provider.openrouter.options.apiKey).toBe(
      "TICKET_7",
    )
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
    // The tour's folder only, the person's own never.
    expect(again.tour.launchEnv(join(home, "code"), true)).toBeUndefined()
    // Its project removed, the record goes with it, for good.
    projects.length = 0
    expect(again.tour.launchEnv(tourFolder(home), true)).toBeUndefined()
    expect(
      tourIn(home, {
        projects: [project("tour", tourFolder(home))],
        records: new TourRecords(file),
      }).tour.launchEnv(tourFolder(home), true),
    ).toBeUndefined()
  })

  it("replaces a folder's record when a new run takes the folder", async ({ resources }) => {
    const home = await scratchHome(resources)
    const projects: Project[] = []
    let nth = 0
    const { tour } = tourIn(home, {
      projects,
      ticket: () => Promise.resolve({ ticket: `T${(nth += 1)}` }),
    })
    await tour.prepare()
    projects.push(project("a", tourFolder(home)))
    await tour.prepare()
    projects.push(project("b", tourFolder(home)))
    const config = JSON.parse(tour.launchEnv(tourFolder(home))!.NOVADECK_OPENCODE_CONFIG!)
    expect(config.provider.openrouter.options.apiKey).toBe("T2")
  })

  it("removes a project inside its folder too", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home, {
      projects: [project("inside", join(tourFolder(home), "site"))],
    })
    await expect(tour.prepare()).resolves.toMatchObject({ removed: ["inside"] })
  })

  it("empties its folder only once a removal under way has closed its terminals", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const directory = tourFolder(home)
    const { tour: first } = tourIn(home)
    await first.prepare()
    let closed: () => void = () => {}
    let begun: () => void = () => {}
    const closing = new Promise<void>((resolve) => (begun = resolve))
    const { tour } = tourIn(home, {
      projects: [project("closing", directory)],
      removal: () => {
        begun()
        return new Promise<void>((resolve) => (closed = resolve))
      },
    })
    const prepared = tour.prepare()
    // Waited for, not timed: readying gets to the removal only after its git and its probes,
    // which take a while on a slow machine.
    await closing
    // Still closing: what the earlier run left is untouched.
    await writeFile(join(directory, "scratch.html"), "<p>made</p>")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await readdir(directory)).toContain("scratch.html")
    closed()
    await prepared
    expect(await readdir(directory)).not.toContain("scratch.html")
  })

  it("says so in words where the seed's files can't be read, changing nothing", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const real = await repositoryAssets()
    const { tour, removed } = tourIn(home, {
      assets: { ...real, seed: join(home, "missing") },
      projects: [project("old-tour", tourFolder(home))],
    })
    const refused = await tour.prepare().catch((error: unknown) => error)
    expect(refused).toSatisfy(conflict)
    expect((refused as Error).message).toMatch(/project files couldn't be read/)
    expect(removed).toEqual([])
    await expect(readdir(tourFolder(home))).rejects.toThrow()
  })

  it("takes the next folder where the person kept the first, whose project stays open", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const kept = tourFolder(home)
    await mkdir(kept, { recursive: true })
    await writeFile(join(kept, "game.js"), "mine\n")
    const { tour, removed } = tourIn(home, { projects: [project("kept", kept)] })
    const prepared = await tour.prepare()
    expect(prepared.directory).toBe(tourFolder(home, 2))
    expect(prepared.removed).toEqual([])
    expect(removed).toEqual([])
    expect(await readdir(kept)).toEqual(["game.js"])
  })

  it("reuses the folder it made, wiping it, as long as the marker is in it", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home)
    const first = await tour.prepare()
    await writeFile(join(first.directory, "extra.txt"), "x")
    const second = await tour.prepare()
    expect(second.directory).toBe(first.directory)
    expect(await readdir(second.directory)).not.toContain("extra.txt")
  })

  it("refuses where its first folder is no folder at all", async ({ resources }) => {
    const home = await scratchHome(resources)
    await mkdir(join(home, ".novadeck"), { recursive: true })
    await writeFile(tourFolder(home), "not a folder")
    await expect(tourIn(home).tour.prepare()).rejects.toSatisfy(conflict)
  })

  it("refuses a second run while the first is being readied", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home)
    const first = tour.prepare()
    await expect(tour.prepare()).rejects.toSatisfy(conflict)
    await first
    await expect(tour.prepare()).resolves.toMatchObject({ brief: "doorbell" })
  })
})

// The arguments the brief gives `open_agent` for each teammate.
const opened = (text: string): string[] =>
  [...text.matchAll(/Call `open_agent`(?: again)? with (agent "[^\n]*?), and as/g)].map(
    ([, each]) => each!,
  )

describe("the sandbox repo", () => {
  it("is a git repo on main with one commit by the tour, the marker and the libraries kept out of it", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home)
    await tour.prepare()
    const directory = tourFolder(home)
    const gitIn = (...args: string[]) =>
      execFileSync("git", ["-C", directory, ...args], {
        encoding: "utf8",
      }).trim()
    expect(gitIn("branch", "--show-current")).toBe("main")
    expect(gitIn("rev-list", "--count", "HEAD")).toBe("1")
    expect(gitIn("log", "--format=%an <%ae>")).toBe("Novadeck tour <tour@novadeck.invalid>")
    expect(gitIn("status", "--porcelain")).toBe("")
    const tracked = gitIn("ls-files").split("\n")
    expect(tracked).toEqual(
      expect.arrayContaining([
        ".gitignore",
        "AGENTS.md",
        "CLAUDE.md",
        "README.md",
        "dev.mjs",
        "models/shapes.bin",
        "src/main.js",
      ]),
    )
    expect(tracked).not.toContain(tourMarker)
    expect(tracked.some((name) => name.startsWith(".claude/"))).toBe(false)
    expect(tracked.filter((name) => name.startsWith("vendor/"))).toEqual([])
  })

  it("commits the project's own note while the folder holds the sandbox's, the status clean", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home)
    await tour.prepare()
    const directory = tourFolder(home)
    const gitIn = (...args: string[]) =>
      execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim()
    expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(sandboxNote("opencode"))
    expect(gitIn("show", "HEAD:AGENTS.md")).toBe(projectNote.trim())
    expect(gitIn("status", "--porcelain")).toBe("")
    // A worktree made during the tour carries the project, not the tour's rules or settings.
    const worktree = join(home, "mine")
    gitIn("worktree", "add", "-b", "hero", worktree)
    expect(await readFile(join(worktree, "AGENTS.md"), "utf8")).toBe(projectNote)
    expect(await readdir(worktree)).not.toContain(".claude")
  })

  it("gives a worktree of it no vendor folder, while the folder itself has it", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home)
    await tour.prepare()
    const directory = tourFolder(home)
    const worktree = join(home, "worktree")
    execFileSync("git", ["-C", directory, "worktree", "add", "-b", "hero", worktree], {
      encoding: "utf8",
    })
    expect(await readdir(worktree)).not.toContain("vendor")
    expect(await readdir(worktree)).toContain("src")
    expect(await readdir(directory)).toContain("vendor")
  })

  it("is made afresh for each run, one commit again", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home)
    await tour.prepare()
    const directory = tourFolder(home)
    await writeFile(join(directory, "src", "main.js"), "changed\n")
    await tour.prepare()
    expect(await readFile(join(directory, "src", "main.js"), "utf8")).toContain("placeholder")
    expect(
      execFileSync("git", ["-C", directory, "rev-list", "--count", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("1")
  })

  it("makes the folder agents' worktrees live in", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour, folders } = tourIn(home)
    await tour.prepare()
    expect(folders()).toBe(1)
  })
})

describe("the brief's facts", () => {
  it("has the lead open both teammates on the tour's model, their tasks quoted", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const { tour, brief } = tourIn(home)
    await tour.prepare()
    const text = brief()
    expect(opened(text)).toHaveLength(2)
    expect(text).toContain("> You are Modeller, a teammate in Novadeck's tour.")
    expect(text).toContain("> You are Builder, a teammate in Novadeck's tour.")
    expect(text).toContain(`branch "${branches.modeller}"`)
    expect(text).toContain(`branch "${branches.builder}"`)
  })

  it("names the serving command and the page's address where the game can be served", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const { tour, brief } = tourIn(home, {
      serving: { command: "python3 dev.py 6123", url: "http://127.0.0.1:6123/" },
    })
    await tour.prepare()
    const text = brief()
    expect(text).toContain('`command` "python3 dev.py 6123"')
    expect(text).toContain("http://127.0.0.1:6123/")
    // It asks to run the server first, its turn ending there, and opens its team only once the
    // person has answered that, so the approval isn't on screen with the team coming up.
    const serve = text.indexOf("Call `open_terminal`")
    expect(serve).toBeGreaterThan(-1)
    expect(serve).toBeLessThan(text.indexOf("Call `open_agent`"))
    expect(text.slice(serve, text.indexOf("Call `open_agent`"))).toMatch(
      /end your turn\.\n4\. When Novadeck says the command started/,
    )
  })

  it("names neither where it can't", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour, brief } = tourIn(home, { serving: null })
    await tour.prepare()
    const text = brief()
    expect(text).not.toContain("dev.mjs")
    expect(text).not.toContain("dev.py")
    expect(text).not.toContain("127.0.0.1")
    expect(text).not.toContain("Game server")
  })

  it("has the lead open both teammates on opencode, GPT-6 Luna at medium, whatever else is connected", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const { tour, brief } = tourIn(home, { connected: ["claude", "codex", "agy", "opencode"] })
    await tour.prepare()
    expect(opened(brief())).toEqual([
      'agent "opencode", model "openrouter/openai/gpt-6-luna", effort "medium"',
      'agent "opencode", model "openrouter/openai/gpt-6-luna", effort "medium"',
    ])
  })

  it("never names the person, and tells its agents not to", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour, brief } = tourIn(home)
    await tour.prepare()
    const text = brief()
    expect(text).toContain(`Never use the person's name: say "you"`)
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
    await tour.prepare()
    tour.brief("t1")
    expect(notices).toHaveLength(1)
    const [id, text] = notices[0]!
    expect(id).toBe("t1")
    expect(text.startsWith(tourBriefMark)).toBe(true)
    expect(text).toContain("## Steps")
    // Delivered whole: wrapped as Novadeck's notice, in every harness, it fits one delivery,
    // which a harness takes no more than (a brief past it is rung but never handed over).
    expect(deliveredBytes(noticeOf(text))).toBeLessThanOrEqual(maxDeliveryBytes)
    // And so it does on the longest harness and model names, as `agy`'s, with the serving steps.
    const longest = tourBrief({
      lead: "@a-twenty-char-name-x",
      mate: { agent: "agy", model: "gemini-3-flash-lite-preview", effort: "medium" },
      serving: { command: "python3 dev.py 65535", url: "http://127.0.0.1:65535/" },
    })
    expect(deliveredBytes(noticeOf(longest))).toBeLessThanOrEqual(maxDeliveryBytes)
    // And with Codex's longer rule for the shell, which each of its three texts carries.
    const codex = tourBrief({
      lead: "@a-twenty-char-name-x",
      mate: { agent: "codex", model: "gpt-9.9-codex-max-luna", effort: "medium" },
      serving: { command: "python3 dev.py 65535", url: "http://127.0.0.1:65535/" },
    })
    expect(deliveredBytes(noticeOf(codex))).toBeLessThanOrEqual(maxDeliveryBytes)
  })

  it("is refused before a run is readied", () => {
    const { tour } = tourIn("/nowhere")
    expect(() => tour.brief("lead")).toThrow(/hasn't been readied/)
  })

  it("refuses a terminal whose agent hasn't shown yet", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home, { shown: [] })
    await tour.prepare()
    expect(() => tour.brief("t1")).toThrow(DomainError)
  })

  it("rings only the tour's own terminals", async ({ resources }) => {
    const home = await scratchHome(resources)
    const notices: [string, string][] = []
    const { tour } = tourIn(home, { notices, shown: ["mine"], cwds: { mine: "/h/code" } })
    await tour.prepare()
    expect(() => tour.brief("mine")).toThrow(/isn't one of the tour's/)
    expect(notices).toEqual([])
  })
})

describe("what the briefs say of the shell", () => {
  // Codex reads files only through its shell, so "run no shell command" leaves it unable to
  // read the file it is to change; the others have tools of their own for files.
  it("lets Codex read files with it and nothing else, and tells the others to run none", () => {
    expect(shellRule("codex")).toMatch(/only to read files/)
    expect(shellRule("claude")).toBe("Run no shell command.")
    expect(shellRule("agy")).toBe("Run no shell command.")
  })

  it("says so in the lead's brief, both teammates' tasks and the folder's note", () => {
    for (const agent of ["claude", "codex", "agy"] as const) {
      const rule = shellRule(agent)
      const lead = tourBrief({ lead: "@fox", mate: { agent, model: "m" }, serving: null })
      // Once for the lead, once in each quoted task.
      expect(lead.split(rule)).toHaveLength(4)
      expect(sandboxNote(agent)).toContain(rule)
    }
  })
})

describe("the teammates' tasks", () => {
  it("leave the picks and the models' names for the lead to write in, and run no git", () => {
    for (const task of [modellerTask("@fox", "codex"), builderTask("@fox", "codex")]) {
      for (const name of ["[[world]]", "[[kind]]", "[[one]]", "[[two]]", "[[three]]"])
        expect(task).toContain(name)
      expect(task).toContain("Call `ask` once")
      expect(task).toContain('`to` "@fox"')
      expect(task).toContain("run git")
    }
    expect(modellerTask("@fox", "codex")).toContain("Make models/[[one]].gltf")
    expect(builderTask("@fox", "codex")).toContain('loadModel("[[one]]")')
  })
})

describe("the artist", () => {
  it("is gone: asking for it is refused, ringing nothing", async ({ resources }) => {
    const { tour, brief, notices } = await readied(resources)
    brief()
    const before = notices.length
    expect(() => tour.artist("mine")).toThrow(/no artist/)
    expect(notices).toHaveLength(before)
  })
})

describe("the person keeping the project", () => {
  const statusOf = (directory: string) =>
    execFileSync("git", ["-C", directory, "status", "--porcelain"], { encoding: "utf8" }).trim()

  it("hands the folder over: no marker, the project's note, none of the tour's Claude settings", async ({
    resources,
  }) => {
    const { tour, brief, home } = await readied(resources)
    brief()
    await tour.keep()
    const directory = tourFolder(home)
    const files = await filesOf(directory)
    expect(files).not.toContain(tourMarker)
    expect(files).not.toContain(".claude/settings.json")
    expect(await readdir(directory)).not.toContain(".claude")
    expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(projectNote)
    // The project itself is whole.
    expect(files).toEqual(expect.arrayContaining(["src/main.js", "vendor/phaser/phaser.min.js"]))
  })

  it("leaves git as the person's own: clean, nothing of the tour's tracked or excluded", async ({
    resources,
  }) => {
    const { tour, brief, home } = await readied(resources)
    brief()
    await tour.keep()
    const directory = tourFolder(home)
    expect(statusOf(directory)).toBe("")
    const gitIn = (...args: string[]) =>
      execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim()
    expect(gitIn("ls-files")).not.toContain(".claude/")
    expect(gitIn("ls-files", "-v", "AGENTS.md")).toMatch(/^H /)
    const exclude = await readFile(join(directory, ".git", "info", "exclude"), "utf8")
    expect(exclude).not.toContain("settings.json")
    expect(exclude).not.toContain(tourMarker)
  })

  it("keeps the person's own files in .claude", async ({ resources }) => {
    const { tour, brief, home } = await readied(resources)
    brief()
    await writeFile(join(tourFolder(home), ".claude", "mine.md"), "mine")
    await tour.keep()
    expect(await readdir(join(tourFolder(home), ".claude"))).toEqual(["mine.md"])
  })

  it("rings the lead that the tour is over, and forgets the run", async ({ resources }) => {
    const { tour, brief, notices } = await readied(resources)
    brief()
    await tour.keep()
    expect(notices.at(-1)).toEqual(["lead", keptLine])
    expect(() => tour.brief("lead")).toThrow(/hasn't been readied/)
  })

  it("is harmless when asked again, and rings nothing the second time", async ({ resources }) => {
    const { tour, brief, notices, home } = await readied(resources)
    brief()
    await tour.keep()
    const rung = notices.length
    await expect(tour.keep()).resolves.toBeUndefined()
    expect(notices).toHaveLength(rung)
    expect(await readFile(join(tourFolder(home), "AGENTS.md"), "utf8")).toBe(projectNote)
  })

  it("never writes over a folder the person already has: without the marker it does nothing", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const mine = tourFolder(home)
    await mkdir(mine, { recursive: true })
    await writeFile(join(mine, "AGENTS.md"), "mine\n")
    const { tour } = tourIn(home, { projects: [project("mine", mine)] })
    await expect(tour.keep()).resolves.toBeUndefined()
    expect(await readFile(join(mine, "AGENTS.md"), "utf8")).toBe("mine\n")
  })

  it("never fails for a lead that is gone, or one that never started", async ({ resources }) => {
    const first = await readied(resources)
    await expect(first.tour.keep()).resolves.toBeUndefined()
    const gone: string[] = []
    const second = await readied(resources, { gone })
    second.brief()
    gone.push("lead")
    await expect(second.tour.keep()).resolves.toBeUndefined()
  })

  it("keeps, after a restart, each marked folder open as a project, and no other", async ({
    resources,
  }) => {
    const { home } = await readied(resources)
    // A second tour folder, marked but closed, and a third that is open: only open ones are kept.
    const other = tourFolder(home, 2)
    const closed = tourFolder(home, 3)
    for (const folder of [other, closed]) {
      // eslint-disable-next-line no-await-in-loop -- Two small folders.
      await mkdir(folder, { recursive: true })
      // eslint-disable-next-line no-await-in-loop -- As above.
      await writeFile(join(folder, tourMarker), "")
    }
    const restarted = tourIn(home, {
      projects: [project("one", tourFolder(home)), project("two", join(other, "site"))],
    })
    await restarted.tour.keep()
    expect(await readdir(tourFolder(home))).not.toContain(tourMarker)
    expect(await readdir(other)).not.toContain(tourMarker)
    expect(await readdir(closed)).toContain(tourMarker)
    expect(statusOf(tourFolder(home))).toBe("")
    expect(await readFile(join(tourFolder(home), "AGENTS.md"), "utf8")).toBe(projectNote)
  })

  it("does nothing after a restart where no tour folder is open", async ({ resources }) => {
    const { home } = await readied(resources)
    const restarted = tourIn(home)
    await expect(restarted.tour.keep()).resolves.toBeUndefined()
    expect(await readdir(tourFolder(home))).toContain(tourMarker)
  })

  it("makes the folder no longer the tour's, and a later run takes the next one", async ({
    resources,
  }) => {
    const { tour, brief, home } = await readied(resources)
    brief()
    expect(tour.isTours("lead")).toBe(true)
    expect(tour.openPolicy("lead").flags).toBeDefined()
    await tour.keep()
    expect(tour.isTours("lead")).toBe(false)
    expect(tour.openPolicy("lead")).toEqual({})
    const next = await tour.prepare()
    expect(next.directory).toBe(tourFolder(home, 2))
    // The kept project is as the person left it.
    expect(await readdir(tourFolder(home))).toContain("src")
  })
})

describe("nudging the tour's agent", () => {
  it("rings it a fixed line to carry on from its step, in the tour's folder only", async ({
    resources,
  }) => {
    const { tour, notices } = await readied(resources, {
      shown: ["lead", "elsewhere"],
      cwds: { elsewhere: "/h/code" },
    })
    tour.nudge("lead")
    expect(notices).toEqual([["lead", nudgeLine]])
    expect(() => tour.nudge("elsewhere")).toThrow(DomainError)
  })
})

describe("the brief's wording", () => {
  it("keeps the nudge from making an agent redo a step", () => {
    expect(nudgeLine).toContain("Don't redo a step.")
  })

  it("has the lead ask the person which game, and leave their questions to them", async ({
    resources,
  }) => {
    const home = await scratchHome(resources)
    const { tour, brief } = tourIn(home)
    await tour.prepare()
    const text = brief()
    expect(text).toContain("Never answer their questions to the")
    expect(text).toContain('"header":"The world"')
    expect(text).toContain('"header":"The kind"')
  })
})

describe("what the folder's own instructions say", () => {
  it("holds no role and no step in the files a harness loads by itself", async ({ resources }) => {
    const home = await scratchHome(resources)
    const { tour } = tourIn(home)
    await tour.prepare()
    const folder = tourFolder(home)
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      // eslint-disable-next-line no-await-in-loop -- Two small files.
      const text = await readFile(join(folder, name), "utf8")
      expect(text).not.toMatch(/open_agent|lead agent|Steps|describe/)
    }
    const note = await readFile(join(folder, "AGENTS.md"), "utf8")
    expect(note.replaceAll(/\s+/g, " ")).toContain("If you were given a task, do only that task.")
    expect(note).toContain("Run no shell command.")
    expect(nudgeLine).toContain("tour brief Novadeck sent you")
  })
})

describe("what an agent's open_agent is subject to in the tour", () => {
  it("refuses a teammate and any other agent there, who have no business opening agents", async ({
    resources,
  }) => {
    const { tour, brief } = await readied(resources, {
      shown: ["lead", "mine"],
      leads: { mate: "lead" },
    })
    brief()
    expect(tour.openPolicy("mate").refusal).toMatch(
      /only the lead of Novadeck's tour opens agents/i,
    )
    expect(tour.openPolicy("mine").refusal).toMatch(
      /only the lead of Novadeck's tour opens agents/i,
    )
  })

  it("starts the lead's opencode agents with its build agent, which edits unasked, and no other harness's", async ({
    resources,
  }) => {
    const { tour, brief, home } = await readied(resources)
    brief()
    const policy = tour.openPolicy("lead")
    expect(policy.refusal).toBeUndefined()
    const at = tourFolder(home)
    expect(policy.flags?.("opencode", at)).toEqual(["--agent", "build"])
    expect(policy.flags?.("claude", at)).toEqual([])
  })

  it("refuses any other harness in the tour's folder, in plain words", async ({ resources }) => {
    const { tour, brief, home } = await readied(resources)
    brief()
    const policy = tour.openPolicy("lead")
    expect(policy.refuseAgent?.("claude", tourFolder(home))).toBe("The tour runs opencode only.")
    expect(policy.refuseAgent?.("opencode", tourFolder(home))).toBeUndefined()
    expect(policy.refuseAgent?.("claude", "/h/code")).toBeUndefined()
  })

  it("pins a teammate on the run's model and effort whatever the lead names, in the tour's folder only", async ({
    resources,
  }) => {
    const { tour, brief, home } = await readied(resources)
    brief()
    const policy = tour.openPolicy("lead")
    const at = tourFolder(home)
    expect(policy.pinned?.("opencode", at)).toEqual({
      model: "openrouter/openai/gpt-6-luna",
      effort: "medium",
    })
    expect(policy.pinned?.("claude", at)).toBeUndefined()
    // One it opens outside the tour's folder keeps the person's own default.
    expect(policy.pinned?.("opencode", "/h/code")).toBeUndefined()
  })

  it("gives the lead's agents no write flags where they start outside the tour's folder", async ({
    resources,
  }) => {
    const { tour, brief, home } = await readied(resources)
    brief()
    const policy = tour.openPolicy("lead")
    expect(policy.flags?.("opencode", "/h/code")).toEqual([])
    expect(policy.flags?.("opencode", join(tourFolder(home), "sub"))).not.toEqual([])
  })

  it("follows the run's folder, whichever of the tour's names it has", async ({ resources }) => {
    const home = await scratchHome(resources)
    await mkdir(tourFolder(home), { recursive: true })
    await writeFile(join(tourFolder(home), "mine.md"), "mine")
    const second = tourFolder(home, 2)
    const { tour } = tourIn(home, { cwds: { lead: second }, shown: ["lead"] })
    await tour.prepare()
    tour.brief("lead")
    expect(tour.isTours("lead")).toBe(true)
    expect(tour.openPolicy("lead").flags).toBeDefined()
  })

  it.skipIf(process.platform === "win32")(
    "gives write flags to an agent that starts in the tour's folder by its real path, where the home is a link",
    async ({ resources }) => {
      const real = await scratchHome(resources)
      const linked = join(await scratchHome(resources), "home")
      await symlink(real, linked)
      const { tour } = tourIn(linked)
      await tour.prepare()
      tour.brief("lead")
      const policy = tour.openPolicy("lead")
      expect(policy.flags?.("opencode", join(real, ".novadeck", "tour"))).toEqual([
        "--agent",
        "build",
      ])
      expect(tour.isTours("lead")).toBe(true)
    },
  )

  it("leaves a terminal elsewhere alone", async ({ resources }) => {
    const { tour, brief } = await readied(resources, {
      leads: { away: "lead" },
      cwds: { away: "/h/code" },
    })
    brief()
    expect(tour.openPolicy("away")).toEqual({})
  })
})

describe("which terminals are the tour's", () => {
  it("are those in its folder, and none elsewhere", async ({ resources }) => {
    const { tour } = await readied(resources, { cwds: { away: "/h/code" } })
    expect(tour.isTours("lead")).toBe(true)
    expect(tour.isTours("away")).toBe(false)
  })

  it("are none before a folder holds the marker", () => {
    const { tour } = tourIn("/h")
    expect(tour.isTours("lead")).toBe(false)
  })
})
