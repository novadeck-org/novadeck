import { join } from "node:path"

import type { TerminalSummary } from "@novadeck/protocol"

import type { Request } from "../harnesses/activity.js"
import type { Messaging } from "../messaging/messaging.js"
import { describe, expect, it } from "../test.js"
import { TerminalPeers, waitingOf, type PeerTerminal } from "./peers.js"
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

const file = (path: string, held = false) => ({ kind: "file" as const, path, held })

describe("what a terminal's dictation hint is made of", () => {
  const summary = { cwd: "/w/repo/application/runner", sessionId: "s" } as TerminalSummary
  const peers = new TerminalPeers({
    messaging: {} as Messaging,
    caller: () => undefined,
    terminal: () => undefined,
    running: () => [],
    projectFolder: () => "/w/repo",
    stopping: () => false,
  })
  const terminal = (fields: Partial<PeerTerminal>): PeerTerminal => ({
    summary,
    naming: { person: null, agent: null, summary: null },
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
      { kind: "image" as const, path: "/w/repo/shot.png", held: false },
      { kind: "page" as const, path: null, held: false },
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
      stopping: () => false,
    })
    const work = {
      ...freshWork("claude:s1"),
      folders: { "/w/repo/application/runner/src": 2, "/w/repo/docs": 1 },
    }
    expect(await loose.hint(terminal({ work }), [])).toMatchObject({ folders: ["src"] })
  })
})
