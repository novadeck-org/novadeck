import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { rolloutEvents } from "@novadeck/harness-codex/rollout"
import type { HarnessEvent } from "@novadeck/harness-core/events"
import type { Report } from "@novadeck/harness-core/report"
import { companionLimits, type AgentName } from "@novadeck/protocol"
import { vi } from "vitest"

import { wroteFolders } from "../companions/path-field.js"
import { folderSecrets } from "../companions/secrets.js"
import { harnesses } from "../harnesses/registry.js"
import type { Root } from "../harnesses/roots.js"
import { it as base, describe, expect } from "../test.js"
import { Reports } from "./binding/reports.js"
import { Companion } from "./companion.js"
import type { Record } from "./record.js"
import { workAfter, type Work } from "./work.js"

// What each harness tells of a file its tool wrote, in the shape its own hook or records give,
// decoded as the runner decodes it, then carried through the terminal's work and the place the
// companions read, to the folders `companions.wroteTo` lists.

const it = base.extend<{ directory: string }>({
  directory: async ({ resources }, use) => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-wrote-to-")))
    resources.defer(() => rmSync(directory, { recursive: true, force: true }))
    await use(directory)
  },
})

const hook = (agent: AgentName, event: string, payload: Report["payload"]) =>
  harnesses[agent].decode({
    terminalId: "t",
    token: "0".repeat(48),
    agent,
    event,
    seq: 1,
    instance: "7",
    env: { cursor: false },
    payload,
  })

const rootOf = (agent: AgentName, sessionId: string): Root => ({
  agent,
  sessionId,
  instance: "7",
  source: "binding",
})

// The list a terminal whose agent just wrote `events` has, the project being `project`.
const listed = async (
  agent: AgentName,
  sessionId: string,
  events: readonly HarnessEvent[],
  {
    project,
    cwd,
    at,
    bookkeeping = [],
    transcript,
  }: {
    project: string
    cwd: string
    at: number
    bookkeeping?: readonly string[]
    transcript?: string
  },
) => {
  // The facts as timed `at`, as a hook that started then would tell them.
  const timed = events.map((event) => ({ ...event, startedAt: at }))
  const work = workAfter(null, rootOf(agent, sessionId), timed, at, [], [cwd]) as Work
  const record = { summary: { sessionId: "workspace", handle: "moth", cwd }, work } as Record
  const companion = new Companion(undefined, {
    records: () => new Map([["t", record]]),
    saved: () => undefined,
    projectFolder: () => project,
    peers: () => undefined as never,
    stopping: () => false,
  })
  const place = companion.place("t")!
  return wroteFolders(
    (place.wrote ?? []).map((each) => ({
      ...each,
      handle: place.handle,
      agent: place.agent!,
      cwd: place.cwd,
      // As the companions tell it: what the session's own home keeps, by its transcript.
      own: transcript ? (harnesses[agent].bookkeepingOf?.(transcript) ?? []) : [],
    })),
    place.project,
    folderSecrets({}),
    bookkeeping,
  )
}

describe("the folders agents wrote in outside the project, per harness", () => {
  it("lists a folder Claude Code's Write wrote in", async ({ directory }) => {
    const project = join(directory, "project")
    const outside = join(directory, "outside")
    mkdirSync(project)
    mkdirSync(outside)
    const events = hook("claude", "PostToolUse", {
      session_id: "s",
      tool_name: "Write",
      tool_input: { file_path: join(outside, "notes.md") },
    })
    expect(await listed("claude", "s", events, { project, cwd: project, at: 50 })).toEqual([
      { path: outside, handle: "moth", agent: "claude", at: 50 },
    ])
  })

  it("lists a folder Codex's apply_patch hook wrote in", async ({ directory }) => {
    const project = join(directory, "project")
    const outside = join(directory, "outside")
    mkdirSync(project)
    mkdirSync(outside)
    const events = hook("codex", "PostToolUse", {
      session_id: "s",
      cwd: project,
      tool_name: "apply_patch",
      tool_input: {
        command: `*** Begin Patch\n*** Add File: ${join(outside, "a.ts")}\n+x\n*** End Patch`,
      },
    })
    expect(await listed("codex", "s", events, { project, cwd: project, at: 51 })).toEqual([
      { path: outside, handle: "moth", agent: "codex", at: 51 },
    ])
  })

  it("lists a folder Codex's rollout FileChange wrote in", async ({ directory }) => {
    const project = join(directory, "project")
    const outside = join(directory, "outside")
    mkdirSync(project)
    mkdirSync(outside)
    const events = rolloutEvents(
      JSON.stringify({
        timestamp: new Date(12).toISOString(),
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "t1",
          item: {
            type: "FileChange",
            status: "completed",
            changes: { [join(outside, "b.ts")]: { type: "add" } },
          },
        },
      }),
      { sessionId: "s", instance: "7" },
    )
    expect(await listed("codex", "s", events, { project, cwd: project, at: 52 })).toEqual([
      { path: outside, handle: "moth", agent: "codex", at: 52 },
    ])
  })

  it("lists a folder Antigravity's write_to_file wrote in", async ({ directory }) => {
    const project = join(directory, "project")
    const outside = join(directory, "outside")
    mkdirSync(project)
    mkdirSync(outside)
    const events = hook("agy", "PostToolUse", {
      conversationId: "c",
      toolCall: { name: "write_to_file", args: { TargetFile: join(outside, "c.md") } },
    })
    expect(await listed("agy", "c", events, { project, cwd: project, at: 53 })).toEqual([
      { path: outside, handle: "moth", agent: "agy", at: 53 },
    ])
  })

  it("leaves out a write in the project's folder for each harness", async ({ directory }) => {
    const project = join(directory, "project")
    mkdirSync(join(project, "src"), { recursive: true })
    const inside = join(project, "src", "a.ts")
    const writes: [AgentName, string, readonly HarnessEvent[]][] = [
      [
        "claude",
        "s",
        hook("claude", "PostToolUse", {
          session_id: "s",
          tool_name: "Edit",
          tool_input: { file_path: inside },
        }),
      ],
      [
        "codex",
        "s",
        hook("codex", "PostToolUse", {
          session_id: "s",
          cwd: project,
          tool_name: "apply_patch",
          tool_input: { command: `*** Begin Patch\n*** Update File: ${inside}\n*** End Patch` },
        }),
      ],
      [
        "agy",
        "c",
        hook("agy", "PostToolUse", {
          conversationId: "c",
          toolCall: { name: "write_to_file", args: { TargetFile: inside } },
        }),
      ],
    ]
    for (const [agent, session, events] of writes) {
      // Whether the work keeps it (the terminal works elsewhere) or not, the list leaves it out.
      expect(
        // eslint-disable-next-line no-await-in-loop -- One harness after another.
        await listed(agent, session, events, { project, cwd: directory, at: 1 }),
        agent,
      ).toEqual([])
    }
  })
})

describe("a work kept before it listed the folders written in", () => {
  const stored = (text: string): Work => JSON.parse(text) as Work
  const place = (work: Work) => {
    const record = {
      summary: { sessionId: "workspace", handle: "moth", cwd: "/p" },
      work,
    } as Record
    return new Companion(undefined, {
      records: () => new Map([["t", record]]),
      saved: () => undefined,
      projectFolder: () => "/p",
      peers: () => undefined as never,
      stopping: () => false,
    }).place("t")!
  }
  // What main stores today: a work with none of `wrote`.
  const old = stored(
    JSON.stringify({ session: "claude:s", first: "go", latest: "go", folders: {}, activeAt: 1 }),
  )

  it("lists none, and the next write outside the terminal's folder starts the list", () => {
    expect(place(old)).not.toHaveProperty("wrote")
    const events = hook("claude", "PostToolUse", {
      session_id: "s",
      tool_name: "Write",
      tool_input: { file_path: "/elsewhere/a.md" },
    })
    const next = workAfter(old, rootOf("claude", "s"), events, 9, [], ["/p"])!
    // Timed as the hook that told it was.
    const at = events[0]!.startedAt
    expect(next.wrote).toEqual([{ folder: "/elsewhere", at }])
    expect(place(next)).toMatchObject({ agent: "claude", wrote: [{ folder: "/elsewhere", at }] })
  })

  it("lists only the entries that are shaped so, and keeps no path past what the protocol carries", () => {
    const damaged = stored(
      JSON.stringify({
        ...old,
        wrote: [
          { folder: "/ok", at: 2 },
          { folder: 7, at: 1 },
          { at: 1 },
          { folder: "/x", at: "no" },
          null,
        ],
      }),
    )
    expect(place(damaged).wrote).toEqual([{ folder: "/ok", at: 2 }])
    expect(place({ ...old, wrote: "nope" } as unknown as Work)).not.toHaveProperty("wrote")
    const long = `/${"a".repeat(companionLimits.path)}/f.md`
    const events = hook("claude", "PostToolUse", {
      session_id: "s",
      tool_name: "Write",
      tool_input: { file_path: long },
    })
    expect(workAfter(old, rootOf("claude", "s"), events, 9, [], ["/p"])).not.toHaveProperty("wrote")
  })
})

describe("the folders each harness keeps for itself", () => {
  // What each writes for itself under its home, and a file there it writes for the person.
  const kept: [AgentName, readonly string[], string][] = [
    ["claude", ["plans", join("projects", "p", "memory"), join("projects", "p")], "skills"],
    ["codex", ["memories", join("sessions", "2026"), "log"], "prompts"],
    ["agy", [join("brain", "c1")], "skills"],
  ]

  const writing = (agent: AgentName, file: string): readonly HarnessEvent[] =>
    agent === "claude"
      ? hook("claude", "PostToolUse", {
          session_id: "s",
          tool_name: "Write",
          tool_input: { file_path: file },
        })
      : agent === "codex"
        ? hook("codex", "PostToolUse", {
            session_id: "s",
            cwd: "/",
            tool_name: "apply_patch",
            tool_input: { command: `*** Begin Patch\n*** Add File: ${file}\n+x\n*** End Patch` },
          })
        : hook("agy", "PostToolUse", {
            conversationId: "s",
            toolCall: { name: "write_to_file", args: { TargetFile: file } },
          })

  const installFor = (directory: string, env: NodeJS.ProcessEnv = {}) => ({
    env,
    home: join(directory, "person"),
    platform: process.platform,
    plugin: "",
  })

  for (const [agent, bookkept, other] of kept)
    it(`leaves out what ${agent} writes for itself, and lists the rest of its home`, async ({
      directory,
    }) => {
      const project = join(directory, "project")
      mkdirSync(project)
      const install = installFor(directory)
      const home = harnesses[agent].home(install)
      const bookkeeping = harnesses[agent].bookkeeping!(install)
      const at = { project, cwd: project, at: 5, bookkeeping }
      for (const folder of bookkept) {
        const where = join(home, folder)
        mkdirSync(where, { recursive: true })
        const events = writing(agent, join(where, "file.md"))
        // Without the exclusion it is listed, which is what it is for.
        expect(
          // eslint-disable-next-line no-await-in-loop -- One folder after another.
          await listed(agent, "s", events, { ...at, bookkeeping: [] }),
          folder,
        ).toHaveLength(1)
        // eslint-disable-next-line no-await-in-loop -- One folder after another.
        expect(await listed(agent, "s", events, at), folder).toEqual([])
      }
      // A skill, a prompt or a setting is work the person asked for.
      const elsewhere = join(home, other)
      mkdirSync(elsewhere, { recursive: true })
      expect(await listed(agent, "s", writing(agent, join(elsewhere, "a.md")), at)).toHaveLength(1)
      const outside = join(directory, "outside")
      mkdirSync(outside)
      expect(await listed(agent, "s", writing(agent, join(outside, "x.md")), at)).toHaveLength(1)
    })

  // Each harness's transcript as it lies in a home no variable of the runner names.
  const transcriptIn = (agent: AgentName, home: string): string =>
    agent === "claude"
      ? join(home, "projects", "p", "s.jsonl")
      : agent === "codex"
        ? join(home, "sessions", "2026", "11", "19", "rollout-s.jsonl")
        : join(home, "brain", "s", "log.txt")

  for (const [agent, bookkept] of kept)
    it(`leaves out a ${agent} session's own moved home's folders, which its transcript tells`, async ({
      directory,
    }) => {
      const project = join(directory, "project")
      mkdirSync(project)
      const moved = join(directory, "second-account")
      const global = harnesses[agent].bookkeeping!(installFor(directory))
      const at = { project, cwd: project, at: 5, bookkeeping: global }
      const transcript = transcriptIn(agent, moved)
      for (const folder of bookkept) {
        const where = join(moved, folder)
        mkdirSync(where, { recursive: true })
        const events = writing(agent, join(where, "file.md"))
        // eslint-disable-next-line no-await-in-loop -- One folder after another.
        expect(await listed(agent, "s", events, at), folder).toHaveLength(1)
        // eslint-disable-next-line no-await-in-loop -- One folder after another.
        expect(await listed(agent, "s", events, { ...at, transcript }), folder).toEqual([])
      }
      // The variable that moves the runner's own home names the same folders.
      const variable = agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"
      if (agent !== "agy")
        expect(
          harnesses[agent].bookkeeping!(installFor(directory, { [variable]: moved })).every(
            (folder) => folder.startsWith(moved),
          ),
        ).toBe(true)
    })

  it("names its folders from where each harness's transcript sits", () => {
    expect(harnesses.claude.bookkeepingOf!("/a/.claude-2/projects/p/s.jsonl")).toContain(
      join("/a/.claude-2", "plans"),
    )
    expect(
      harnesses.codex.bookkeepingOf!("/a/.codex-2/sessions/2026/11/19/rollout-1.jsonl"),
    ).toContain(join("/a/.codex-2", "memories"))
    expect(harnesses.agy.bookkeepingOf!("/a/.gemini/antigravity-cli/brain/c1/log.txt")).toEqual([
      join("/a/.gemini/antigravity-cli", "brain"),
    ])
    expect(harnesses.claude.bookkeepingOf!("/elsewhere/s.jsonl")).toEqual([])
  })

  it("takes a harness's folders from the home its variable moves", () => {
    const moved = { CLAUDE_CONFIG_DIR: "/moved/claude", CODEX_HOME: "/moved/codex" }
    const install = { env: moved, home: "/h", platform: "linux" as const, plugin: "" }
    expect(harnesses.claude.bookkeeping!(install)).toContain(join("/moved/claude", "plans"))
    expect(harnesses.codex.bookkeeping!(install)).toContain(join("/moved/codex", "sessions"))
    expect(harnesses.agy.bookkeeping!(install)).toEqual([
      join("/h", ".gemini", "antigravity-cli", "brain"),
    ])
  })

  it("compares a folder through a linked home, as a stow-linked config folder is", async ({
    directory,
  }) => {
    const project = join(directory, "project")
    mkdirSync(project)
    const real = join(directory, "dotfiles", "claude")
    mkdirSync(join(real, "plans"), { recursive: true })
    const home = join(directory, "linked")
    try {
      symlinkSync(real, home, "dir")
    } catch {
      return
    }
    // The agent wrote through the real path; the runner's home names the link.
    const events = writing("claude", join(real, "plans", "p.md"))
    expect(
      await listed("claude", "s", events, {
        project,
        cwd: project,
        at: 5,
        bookkeeping: [join(home, "plans")],
      }),
    ).toEqual([])
  })
})

describe("what is stored of a write in a moved home", () => {
  it("never holds a moved home's plans, though the runner's own home is another", ({
    directory,
  }) => {
    const project = join(directory, "project")
    const moved = join(directory, "second-account")
    const cwd = join(directory, "cwd")
    const plans = join(moved, "plans")
    const skills = join(moved, "skills")
    for (const folder of [project, plans, skills, cwd]) mkdirSync(folder, { recursive: true })
    const record = {
      summary: { sessionId: "workspace", handle: "moth", cwd },
      root: rootOf("claude", "s"),
      transcript: join(moved, "projects", "p", "s.jsonl"),
    } as Record
    const companion = new Companion(undefined, {
      records: () => new Map(),
      saved: () => undefined,
      projectFolder: () => project,
      peers: () => undefined as never,
      stopping: () => false,
    })
    const write = (file: string) =>
      hook("claude", "PostToolUse", {
        session_id: "s",
        tool_name: "Write",
        tool_input: { file_path: file },
      })
    const reports = new Reports({ companion: () => companion, records: () => new Map() } as never)
    reports.tallyWork(
      record,
      [...write(join(plans, "plan.md")), ...write(join(skills, "a.md"))],
      [],
    )
    expect(record.work?.wrote?.map(({ folder }) => folder)).toEqual([skills])
    expect(JSON.stringify(record.work?.wrote)).not.toContain(plans)
  })
})

describe("when a write was told", () => {
  it("is the rollout line's own time for Codex, and the hook's start for Antigravity", async ({
    directory,
  }) => {
    const project = join(directory, "project")
    const outside = join(directory, "outside")
    mkdirSync(project)
    mkdirSync(outside)
    const line = rolloutEvents(
      JSON.stringify({
        timestamp: new Date(12_345).toISOString(),
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "t1",
          item: {
            type: "FileChange",
            status: "completed",
            changes: { [join(outside, "b.ts")]: { type: "add" } },
          },
        },
      }),
      { sessionId: "s", instance: "7" },
    )
    // Told long after, as a backlog is after a restart: the stamp is the line's.
    const codex = workAfter(null, rootOf("codex", "s"), line, 9_999_999, [], [project])
    expect(codex?.wrote).toEqual([{ folder: outside, at: 12_345 }])
    const events = hook("agy", "PostToolUse", {
      conversationId: "c",
      toolCall: { name: "write_to_file", args: { TargetFile: join(outside, "c.md") } },
    }).map((event) => ({ ...event, startedAt: 777 }))
    const agy = workAfter(null, rootOf("agy", "c"), events, 9_999_999, [], [project])
    expect(agy?.wrote).toEqual([{ folder: outside, at: 777 }])
  })
})

describe("the folders a terminal and its project work in", () => {
  const companionFor = (project: string) =>
    new Companion(undefined, {
      records: () => new Map(),
      saved: () => undefined,
      projectFolder: () => project,
      peers: () => undefined as never,
      stopping: () => false,
    })

  it("are told as written, and as they resolve through a link once that is known", async ({
    directory,
  }) => {
    const real = join(directory, "real")
    const project = join(directory, "project")
    mkdirSync(real)
    mkdirSync(project)
    const link = join(directory, "link")
    symlinkSync(real, link, "dir")
    const record = { summary: { sessionId: "workspace", handle: "moth", cwd: link } } as Record
    const companion = companionFor(project)
    // The first ask never waits on the file system: the folders as written.
    expect(companion.ownFolders(record)).toEqual([link, project])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(companion.ownFolders(record)).toEqual([link, real, project])
  })

  it("ask again for a folder that could not be resolved, after a moment, and keep one that could", async ({
    directory,
  }) => {
    const later = join(directory, "later")
    const real = join(directory, "real")
    mkdirSync(real)
    const record = { summary: { sessionId: "workspace", handle: "moth", cwd: later } } as Record
    const companion = companionFor(join(directory, "project"))
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      companion.ownFolders(record)
      await settle()
      expect(companion.ownFolders(record)).toEqual([later, join(directory, "project")])
      symlinkSync(real, later, "dir")
      // Not asked again at once.
      await settle()
      expect(companion.ownFolders(record)).not.toContain(real)
      // After a few seconds it is, once.
      vi.setSystemTime(Date.now() + 4_000)
      companion.ownFolders(record)
      await settle()
      expect(companion.ownFolders(record)).toContain(real)
      // Kept for a while without asking again.
      vi.setSystemTime(Date.now() + 30_000)
      expect(companion.ownFolders(record)).toContain(real)
    } finally {
      vi.useRealTimers()
    }
  })

  it("drop a write in the project when recorded, through the report's own call", async ({
    directory,
  }) => {
    const project = join(directory, "project")
    const outside = join(directory, "outside")
    const cwd = join(directory, "cwd")
    mkdirSync(join(project, "src"), { recursive: true })
    mkdirSync(outside)
    mkdirSync(cwd)
    const record = { summary: { sessionId: "workspace", handle: "moth", cwd } } as Record
    const companion = companionFor(project)
    const events = [
      ...hook("claude", "PostToolUse", {
        session_id: "s",
        tool_name: "Write",
        tool_input: { file_path: join(project, "src", "a.ts") },
      }),
      ...hook("claude", "PostToolUse", {
        session_id: "s",
        tool_name: "Write",
        tool_input: { file_path: join(outside, "b.ts") },
      }),
    ]
    // As `Reports.tallyWork` asks, with the terminal's cwd outside the project.
    const reports = new Reports({ companion: () => companion, records: () => new Map() } as never)
    const root = rootOf("claude", "s")
    record.root = root
    expect(reports.tallyWork(record, events, [])).toBe(true)
    expect(record.work?.wrote).toEqual([{ folder: outside, at: events[1]!.startedAt }])
  })
})
