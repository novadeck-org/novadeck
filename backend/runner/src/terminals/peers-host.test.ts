import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { ActivityEvent } from "@novadeck/harness-core/events"
import type { AgentName, TerminalSummary } from "@novadeck/protocol"

import { apply, started, summary as activitySummary, type Request } from "../harnesses/activity.js"
import type { Messaging } from "../messaging/messaging.js"
import { peerOf as listed, renderPeer, type Whereabouts } from "../messaging/peers.js"
import { describe, expect, it } from "../test.js"
import { folder } from "../testing/engines.js"
import { GitStates } from "./git-state.js"
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
    ).toEqual({ kind: "permission", tool: "Edit", subject: null, more: 2, since: 0 })
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
    happenings: () => [],
    stopping: () => false,
  })
  const terminal = (fields: Partial<PeerTerminal>): PeerTerminal => ({
    summary,
    naming: { person: null, opener: null, murmur: null, own: null, summary: null },
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

  it("names no login the person's environment says a tool keeps in the project", async () => {
    const env = { GH_CONFIG_DIR: "/w/repo/accounts/work" }
    const work = {
      ...freshWork("claude:s1"),
      files: ["/w/repo/accounts/work/hosts.yml", "/w/repo/inventory/hosts.yml"],
    }
    expect(await peers.hint(terminal({ work }), [], env)).toMatchObject({ files: ["hosts.yml"] })
    const only = { ...work, files: ["/w/repo/accounts/work/hosts.yml"] }
    expect(await peers.hint(terminal({ work: only }), [], env)).toMatchObject({ files: [] })
    // Named as any file where no variable says the tool keeps its login there.
    expect(await peers.hint(terminal({ work: only }), [], {})).toMatchObject({
      files: ["hosts.yml"],
    })
  })

  it("names what is inside the terminal's folder for a session without a project folder", async () => {
    const loose = new TerminalPeers({
      messaging: {} as Messaging,
      caller: () => undefined,
      terminal: () => undefined,
      running: () => [],
      projectFolder: () => undefined,
      happenings: () => [],
      stopping: () => false,
    })
    const work = {
      ...freshWork("claude:s1"),
      folders: { "/w/repo/application/runner/src": 2, "/w/repo/docs": 1 },
    }
    expect(await loose.hint(terminal({ work }), [])).toMatchObject({ folders: ["src"] })
  })
})

describe("what peers read of a terminal", () => {
  const read = async (summary: object, bound: object | null = null) => {
    const record = {
      summary: {
        id: "t1",
        cwd: "/nowhere",
        sessionId: "s",
        title: "t",
        activity: null,
        ...summary,
      },
      naming: { person: null, opener: null, murmur: null, own: null, summary: "Docs" },
      work: null,
      openedBy: null,
      bound,
    } as unknown as PeerRecord
    let where: Whereabouts | undefined
    const peers = new TerminalPeers(
      {
        messaging: {
          agents: (_terminalId: string, about: (id: string) => Whereabouts) => {
            where = about("t1")
            return { ok: true }
          },
        } as unknown as Messaging,
        caller: () => record,
        terminal: () => undefined,
        running: () => [record],
        projectFolder: () => undefined,
        happenings: () => [{ kind: "asked", at: 1, subject: "Which?" }],
        stopping: () => false,
      },
      new GitStates(async () => null),
    )
    await peers.agents({ type: "agents", terminalId: "t1", token: "k", request: {} })
    return where
  }

  it("is its shell's program, only while one runs, with its arguments' values left out", async () => {
    const process = { name: "curl", argv: ["curl", "-H", "Authorization: Bearer abc", "x"] }
    expect((await read({ busy: true, process }))?.shell).toEqual({
      running: true,
      command: "curl",
    })
    expect((await read({ busy: false, process }))?.shell).toEqual({
      running: false,
      command: null,
    })
  })

  it("is its agent's summary and what its session told the person, and when its turn last ended", async () => {
    const activity = { state: "idle", lastTurn: { at: 42 } }
    expect(
      await read({ activity }, { activity: { pending: [], plans: [], turnAt: 7 } }),
    ).toMatchObject({
      summary: "Docs",
      since: 42,
      happenings: [{ kind: "asked", at: 1, subject: "Which?" }],
      git: null,
    })
    // While a turn runs, it has no last turn: since when it started.
    expect(
      await read(
        { activity: { state: "working", lastTurn: null } },
        { activity: { pending: [], plans: [], turnAt: 7 } },
      ),
    ).toMatchObject({ since: 7 })
  })

  describe("the background shells of each harness's agent, as agents lists them", () => {
    const minute = 60_000
    // What each harness's decoder gives for a shell, in the shape of its own ids.
    const shells: Record<AgentName, { ids: readonly [string, string, string]; secret: string }> = {
      claude: { ids: ["bk1x2y3z4", "bq9w8e7r6", "bt5y4u3i2"], secret: "sk-live-9f8e7d6c5b4a3210" },
      codex: { ids: ["53902", "26916", "99018"], secret: "sk-live-9f8e7d6c5b4a3210" },
      agy: {
        ids: ["b0000000-0000-4000-8000-000000000001/task-2", "x/task-4", "x/task-6"],
        secret: "sk-live-9f8e7d6c5b4a3210",
      },
    }

    for (const agent of ["claude", "codex", "agy"] as const) {
      it(`reach agents() from ${agent}'s events, named without a command`, async () => {
        const now = Date.now()
        const { ids, secret } = shells[agent]
        const base = { agent, sessionId: "s", instance: null }
        const binding = { agent, sessionId: "s", instance: null }
        const event = (fields: object, ago: number): ActivityEvent =>
          ({ ...base, startedAt: now - ago * minute, ...fields }) as ActivityEvent
        const events = [
          event(
            { type: "shell-started", id: ids[0], command: `API_KEY=${secret} pnpm dev:web` },
            40,
          ),
          event(
            { type: "shell-started", id: ids[1], command: "cd /x && ./fulltest.sh pnpm test" },
            12,
          ),
          event({ type: "shell-started", id: ids[2], command: `vitest run --token ${secret}` }, 8),
          event({ type: "shell-ended", id: ids[2], code: 1 }, 3),
        ]
        const activity = activitySummary(
          events.reduce((each, one) => apply(each, binding, one) ?? each, started(0)),
        )
        const where = await read({ activity }, { activity: { pending: [], plans: [], turnAt: 7 } })
        const peer = (asleep = false) =>
          listed({
            terminalId: "t1",
            handle: "fox",
            agent,
            expecting: null,
            busy: false,
            asleep,
            where,
            lead: null,
          })
        const lines = renderPeer(peer(), now, { handle: "moth", lead: null })
        expect(lines).toContain("  running: fulltest (12 min) · pnpm dev:web (40 min)")
        expect(lines).toContain("  ended: vitest run exited 1, 3 min ago")
        expect(lines.join("\n")).not.toContain(secret)
        // A sleeper runs no process.
        expect(
          renderPeer(peer(true), now, { handle: "moth", lead: null }).join("\n"),
        ).not.toContain("running:")
      })
    }
  })
})

describe("what peers read of a terminal's reports and rest", () => {
  const read = async (
    over: { summary?: object; work?: object | null; delivered?: number; happenings?: unknown[] },
    bodies: boolean[] = [],
    via: "agents" | "team" = "agents",
  ) => {
    const record = {
      summary: {
        id: "t1",
        cwd: "/nowhere",
        sessionId: "s",
        title: "t",
        activity: null,
        ...over.summary,
      },
      naming: { person: null, opener: null, murmur: null, own: null, summary: null },
      work: over.work ?? null,
      openedBy: null,
      bound: null,
    } as unknown as PeerRecord
    let where: Whereabouts | undefined
    const peers = new TerminalPeers(
      {
        messaging: {
          agents: (_terminalId: string, about: (id: string) => Whereabouts) => {
            where = about("t1")
            return { ok: true }
          },
          team: (_terminalId: string, about: (id: string) => Whereabouts) => {
            where = about("t1")
            return { ok: true }
          },
          deliveredAt: () => new Map(over.delivered === undefined ? [] : [["t1", over.delivered]]),
        } as unknown as Messaging,
        caller: () => record,
        terminal: () => undefined,
        running: () => [record],
        projectFolder: () => undefined,
        happenings: (_id: string, withBodies: boolean) => {
          bodies.push(withBodies)
          return (over.happenings ?? []) as never
        },
        stopping: () => false,
      },
      new GitStates(async () => null),
    )
    await peers[via]({ type: via, terminalId: "t1", token: "k", request: {} })
    return where
  }
  const done = { kind: "done", at: 100, subject: "Fixed", body: null, pr: null }

  it("is whether its latest done still stands: no prompt of the person's or delivery came after it", async () => {
    expect((await read({ happenings: [done] }))?.standing).toBe(true)
    expect((await read({ happenings: [done], work: { personAt: 150 } }))?.standing).toBe(false)
    expect((await read({ happenings: [done], delivered: 150 }))?.standing).toBe(false)
    expect(
      (await read({ happenings: [done], work: { personAt: 50 }, delivered: 99 }))?.standing,
    ).toBe(true)
    expect((await read({ happenings: [] }))?.standing).toBe(false)
  })

  it("is when a sleeper's last turn ended, which its summary keeps, as its since", async () => {
    expect((await read({ summary: { lastTurnAt: 77 } }))?.since).toBe(77)
    expect((await read({ summary: { lastTurnAt: null } }))?.since).toBeNull()
  })

  it("reads report bodies only for team, which quotes them", async () => {
    const asked: boolean[] = []
    await read({}, asked)
    await read({}, asked, "team")
    expect(asked).toEqual([false, true])
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

  const whereabouts = async (
    root: string,
    places: readonly string[],
    bound = true,
    shellCommand: { command: string; since: number } | null = null,
  ) => {
    const record = {
      summary: {
        id: "t1",
        cwd: join(root, "tasks", "a", "repo"),
        sessionId: "s",
        title: "t",
        activity: null,
        shellCommand,
      },
      naming: { person: null, opener: null, murmur: null, own: null, summary: null },
      work: { ...freshWork("claude:s1"), places },
      openedBy: null,
      bound: bound ? { activity: { pending: [], plans: [] } } : null,
    } as unknown as PeerRecord
    let where: Whereabouts | undefined
    const peers = new TerminalPeers(
      {
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
        happenings: () => [],
        stopping: () => false,
      },
      new GitStates(async () => ({ detached: false, ahead: 1, gone: false, dirty: false })),
    )
    await peers.agents({ type: "agents", terminalId: "t1", token: "k", request: {} })
    return where
  }

  it("is the worktree most of its latest calls are in, named by its folder, with its branch and state", async ({
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
      join(b, "src"),
      b,
    ])
    expect(moved?.git).toEqual({
      repo: "repo",
      branch: "task/b",
      state: { detached: false, ahead: 1, gone: false, dirty: false },
    })
  })

  it("is its terminal's folder while its calls stay in its worktree, or tell nothing, or no agent runs", async ({
    resources,
  }) => {
    const root = await folder(resources)
    await project(root)
    const a = join(root, "tasks", "a", "repo")
    const stayed = {
      git: {
        repo: "repo",
        branch: "task/a",
        state: { detached: false, ahead: 1, gone: false, dirty: false },
      },
    }
    expect(await whereabouts(root, [join(a, "src"), join(root, "scratchpad")])).toMatchObject(
      stayed,
    )
    expect(await whereabouts(root, [join(root, "scratchpad")])).toMatchObject(stayed)
    expect(await whereabouts(root, [])).toMatchObject(stayed)
    expect(await whereabouts(root, [join(root, "tasks", "b", "repo")], false)).toMatchObject(stayed)
  })

  it("counts a command run in its agent's shell mode as working, and nothing else idle", async ({
    resources,
  }) => {
    const root = await folder(resources)
    await project(root)
    expect((await whereabouts(root, []))?.working).toBe(false)
    const running = { command: "sleep 15", since: 1 }
    expect((await whereabouts(root, [], true, running))?.working).toBe(true)
  })
})
