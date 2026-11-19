import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { rolloutEvents } from "@novadeck/harness-codex/rollout"
import type { HarnessEvent } from "@novadeck/harness-core/events"
import type { Report } from "@novadeck/harness-core/report"
import { companionLimits, type AgentName } from "@novadeck/protocol"

import { wroteFolders } from "../companions/path-field.js"
import { folderSecrets } from "../companions/secrets.js"
import { harnesses } from "../harnesses/registry.js"
import type { Root } from "../harnesses/roots.js"
import { it as base, describe, expect } from "../test.js"
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
    homes = [],
  }: { project: string; cwd: string; at: number; homes?: readonly string[] },
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
    })),
    place.project,
    folderSecrets({}),
    homes,
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
  // Where each harness puts what it writes for itself, under the home it keeps: Claude Code's
  // plans and auto memory, Codex's session and memory files, Antigravity's conversation artifacts.
  const insideHome: [AgentName, readonly string[]][] = [
    ["claude", ["plans", join("projects", "p", "memory")]],
    ["codex", ["memories", join("sessions", "2026")]],
    ["agy", [join("brain", "c1")]],
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

  for (const [agent, folders] of insideHome)
    it(`leaves out what ${agent} writes in its own home, and lists a folder outside it`, async ({
      directory,
    }) => {
      const project = join(directory, "project")
      const outside = join(directory, "outside")
      mkdirSync(project)
      mkdirSync(outside)
      // The home as the harness itself says where it is: moved by its variable, or under the person's.
      const home = harnesses[agent].home({
        env: {},
        home: join(directory, "person"),
        platform: process.platform,
        plugin: "",
      })
      for (const folder of folders) {
        const where = join(home, folder)
        mkdirSync(where, { recursive: true })
        const events = writing(agent, join(where, "file.md"))
        // Without the homes it is listed, which is what the exclusion is for.
        expect(
          // eslint-disable-next-line no-await-in-loop -- One folder after another.
          await listed(agent, "s", events, { project, cwd: project, at: 5 }),
          folder,
        ).toHaveLength(1)
        expect(
          // eslint-disable-next-line no-await-in-loop -- One folder after another.
          await listed(agent, "s", events, { project, cwd: project, at: 5, homes: [home] }),
          folder,
        ).toEqual([])
      }
      const events = writing(agent, join(outside, "x.md"))
      expect(
        await listed(agent, "s", events, { project, cwd: project, at: 5, homes: [home] }),
      ).toHaveLength(1)
    })

  it("takes every harness's home from the runner's own knowledge of them", () => {
    const homes = Object.values(harnesses).map((each) =>
      each.home({
        env: { CLAUDE_CONFIG_DIR: "/moved/claude", CODEX_HOME: "/moved/codex" },
        home: "/h",
        platform: "linux",
        plugin: "",
      }),
    )
    expect(homes).toContain("/moved/claude")
    expect(homes).toContain("/moved/codex")
    expect(homes.some((home) => home.startsWith(join("/h", ".gemini")))).toBe(true)
  })
})

describe("the folders a terminal and its project work in", () => {
  it("are told as written and as they resolve through a link", ({ directory }) => {
    const real = join(directory, "real")
    const project = join(directory, "project")
    mkdirSync(real)
    mkdirSync(project)
    const link = join(directory, "link")
    symlinkSync(real, link, "dir")
    const record = { summary: { sessionId: "workspace", handle: "moth", cwd: link } } as Record
    const companion = new Companion(undefined, {
      records: () => new Map(),
      saved: () => undefined,
      projectFolder: () => project,
      peers: () => undefined as never,
      stopping: () => false,
    })
    expect(companion.ownFolders(record)).toEqual([link, real, project])
  })
})
