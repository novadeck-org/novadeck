import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import type { TerminalSummary } from "@novadeck/protocol"

import type { Request } from "../harnesses/activity.js"
import type { Messaging } from "../messaging/messaging.js"
import type { Whereabouts } from "../messaging/peers.js"
import { describe, expect, it } from "../test.js"
import { folder } from "../testing/engines.js"
import { TerminalPeers, waitingOf, type PeerRecord, type PeerTerminal } from "./peers-host.js"
import { freshWork } from "./work.js"

const request = (fields: Partial<Request>): Request => ({
  requestId: "r-1",
  actor: null,
  toolName: "Bash",
  kind: "permission",
  subject: null,
  choices: [],
  askedAt: 0,
  ...fields,
})

const subject = (fields: Partial<Request>) => waitingOf({ pending: [request(fields)] })?.subject

describe("what peers learn of a request waiting on the person", () => {
  it("is the oldest, with how many wait after it", () => {
    expect(waitingOf({ pending: [] })).toBeNull()
    expect(waitingOf(null)).toBeNull()
    expect(
      waitingOf({
        pending: [request({ subject: "src/a.ts", toolName: "Edit" }), request({}), request({})],
      }),
    ).toEqual({ kind: "permission", tool: "Edit", subject: null, more: 2 })
  })

  it("never shows a permission's subject, whatever it looks like", () => {
    for (const text of [
      "curl -H 'Authorization: Bearer abc' x",
      "https://example.com/?token=abc",
      "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      "token.txt",
      "/etc/shadow",
      "src/a.ts",
    ])
      expect(subject({ subject: text, toolName: "Write" })).toBeNull()
  })

  it("shows a question's or a plan's subject as it is", () => {
    expect(subject({ kind: "question", subject: "Which database?" })).toBe("Which database?")
    expect(subject({ kind: "plan", subject: "plan.md" })).toBe("plan.md")
  })
})

const file = (path: string, secret = false) => ({ kind: "file" as const, path, secret })

describe("what a terminal's dictation hint is made of", () => {
  const summary = { cwd: "/w/repo/application/runner", sessionId: "s" } as TerminalSummary
  const peers = new TerminalPeers({
    messaging: {} as Messaging,
    caller: () => undefined,
    terminal: () => undefined,
    running: () => [],
    projectFolder: () => "/w/repo",
    reports: () => ({ tell: null, done: null }),
    stopping: () => false,
  })
  const terminal = (fields: Partial<PeerTerminal>): PeerTerminal => ({
    summary,
    naming: { person: null, opener: null, murmur: null, summary: null },
    work: null,
    activity: null,
    openedBy: null,
    ...fields,
  })

  it("is its folder and branch, where its work wrote, and the files shown, then its work's", async () => {
    const work = {
      ...freshWork("claude:s1"),
      folders: { "/w/repo/application/runner/src/voice": 3, "/w/repo/application/ui": 2 },
      files: ["/w/repo/application/ui/orders.ts"],
    }
    expect(await peers.hint(terminal({ work }), [file("/w/repo/db/schema.sql")])).toEqual({
      cwd: "/w/repo/application/runner",
      branch: null,
      // As the platform writes paths, which the hint splits either way.
      folders: [join("application", "runner", "src", "voice"), join("application", "ui")],
      files: ["schema.sql", "orders.ts"],
    })
    expect(await peers.hint(terminal({}), [])).toMatchObject({ folders: [], files: [] })
  })

  it("names nothing outside the project, nor a file that may hold secrets", async () => {
    const work = {
      ...freshWork("claude:s1"),
      folders: { "/w/repo/api": 2, "/home/me/.config/tool": 1 },
      files: ["/w/repo/.env", "/w/repo/keys/server.pem", "/tmp/scratch/probe.ts", "/w/repo/api.ts"],
    }
    const shown = [
      file("/w/repo/held.ts", true),
      file("/w/repo/id_rsa"),
      { kind: "image" as const, path: "/w/repo/shot.png", secret: false },
      { kind: "page" as const, path: null, secret: false },
    ]
    expect(await peers.hint(terminal({ work }), shown)).toMatchObject({
      folders: ["api"],
      files: ["api.ts"],
    })
  })

  it("names what is inside the terminal's folder for a session without a project folder", async () => {
    const loose = new TerminalPeers({
      messaging: {} as Messaging,
      caller: () => undefined,
      terminal: () => undefined,
      running: () => [],
      projectFolder: () => undefined,
      reports: () => ({ tell: null, done: null }),
      stopping: () => false,
    })
    const work = {
      ...freshWork("claude:s1"),
      folders: { "/w/repo/application/runner/src": 2, "/w/repo/docs": 1 },
    }
    expect(await loose.hint(terminal({ work }), [])).toMatchObject({ folders: ["src"] })
  })
})

describe("where peers are, as an agent reads it", () => {
  it("shows the end of a long path, never starting on half an emoji", async () => {
    const record = {
      summary: { id: "t1", cwd: "/w", sessionId: "s", title: "t", activity: null },
      naming: { person: null, opener: null, murmur: null, summary: null },
      work: null,
      openedBy: null,
      bound: null,
    } as unknown as PeerRecord
    let place: ((path: string) => string) | undefined
    const peers = new TerminalPeers({
      messaging: {
        agents: (_terminalId: string, about: (id: string) => { place: typeof place }) => {
          place = about("t1").place
          return { ok: true }
        },
      } as unknown as Messaging,
      caller: () => record,
      terminal: () => undefined,
      running: () => [record],
      projectFolder: () => undefined,
      reports: () => ({ tell: null, done: null }),
      stopping: () => false,
    })
    await peers.agents({ type: "agents", terminalId: "t1", token: "k", request: {} })

    // Outside the terminal's folder, so shown whole until cut: 111 units, its cut at a low half.
    expect(place?.(`/elsewhere/${"😀".repeat(50)}`)).toBe(`…${"😀".repeat(39)}`)
  })
})

describe("where a peer's agent works now", () => {
  // A project with two worktrees of one repository, each on its own branch, as uberepo
  // tasks are, and a scratchpad outside both.
  const project = async (root: string) => {
    const tasks = [
      ["a", "task/a"],
      ["b", "task/b"],
    ] as const
    await Promise.all(
      tasks.map(async ([task, branch]) => {
        const tree = join(root, "tasks", task, "repo")
        const git = join(root, "source", "repo", ".git", "worktrees", task)
        await Promise.all([
          mkdir(join(tree, "src"), { recursive: true }),
          mkdir(git, { recursive: true }),
        ])
        await Promise.all([
          writeFile(join(tree, ".git"), `gitdir: ${git}\n`),
          writeFile(join(git, "HEAD"), `ref: refs/heads/${branch}\n`),
        ])
      }),
    )
    await mkdir(join(root, "scratchpad"))
  }

  const whereabouts = async (root: string, places: readonly string[], bound = true) => {
    const record = {
      summary: {
        id: "t1",
        cwd: join(root, "tasks", "a", "repo"),
        sessionId: "s",
        title: "t",
        activity: null,
      },
      naming: { person: null, opener: null, murmur: null, summary: null },
      work: { ...freshWork("claude:s1"), places },
      openedBy: null,
      bound: bound ? { activity: { pending: [], plans: [] } } : null,
    } as unknown as PeerRecord
    let where: Whereabouts | undefined
    const peers = new TerminalPeers({
      messaging: {
        agents: (_terminalId: string, about: (id: string) => Whereabouts) => {
          where = about("t1")
          return { ok: true }
        },
      } as unknown as Messaging,
      caller: () => record,
      terminal: () => undefined,
      running: () => [record],
      projectFolder: () => root,
      reports: () => ({ tell: null, done: null }),
      stopping: () => false,
    })
    await peers.agents({ type: "agents", terminalId: "t1", token: "k", request: {} })
    return where
  }

  it("is the worktree most of its latest calls are in, with its branch and where its terminal started", async ({
    resources,
  }) => {
    const root = await folder(resources)
    await project(root)
    const b = join(root, "tasks", "b", "repo")
    const moved = await whereabouts(root, [
      join(root, "scratchpad"),
      join(b, "src"),
      b,
      join(root, "tasks", "a", "repo"),
      b,
    ])
    expect(moved).toMatchObject({
      folder: join("tasks", "b", "repo"),
      branch: "task/b",
      startedIn: join("tasks", "a", "repo"),
    })
  })

  it("is its terminal's folder while its calls stay in its worktree, or tell nothing, or no agent runs", async ({
    resources,
  }) => {
    const root = await folder(resources)
    await project(root)
    const a = join(root, "tasks", "a", "repo")
    const stayed = { folder: join("tasks", "a", "repo"), branch: "task/a", startedIn: null }
    expect(await whereabouts(root, [join(a, "src"), join(root, "scratchpad")])).toMatchObject(
      stayed,
    )
    expect(await whereabouts(root, [join(root, "scratchpad")])).toMatchObject(stayed)
    expect(await whereabouts(root, [])).toMatchObject(stayed)
    expect(await whereabouts(root, [join(root, "tasks", "b", "repo")], false)).toMatchObject(stayed)
  })

  it("names a folder in the person's home but outside the project from ~", async ({
    resources,
  }) => {
    const root = await folder(resources)
    await project(root)
    const where = await whereabouts(root, [])
    expect(where?.place(join(homedir(), ".claude", "x"))).toBe("~/.claude/x")
  })
})
