import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { exit, mapOf, missing, ok, scripted, timeout } from "./fakes.js"
import type { Repository } from "./forge.js"
import { github } from "./github.js"
import { parseRemote } from "./remote.js"

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo: Repository = { forge: "github", host: "github.com", owner: "o", name: "r" }
const token = { value: "t0ken" }

const pr = (number: number, state: string, extra: Record<string, unknown> = {}) => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  title: `PR ${number}`,
  isDraft: false,
  state,
  mergedAt: null,
  closedAt: null,
  isCrossRepository: false,
  ...extra,
})

const answer = (byBranch: Record<string, unknown[]>) =>
  http.post("https://api.github.com/graphql", async ({ request }) => {
    const { variables } = (await request.json()) as { variables: Record<string, string> }
    const data: Record<string, unknown> = {}
    Object.keys(variables)
      .filter((key) => key.startsWith("b"))
      .forEach(
        (key, index) => (data[`p${index}`] = { nodes: byBranch[variables[key] ?? ""] ?? [] }),
      )
    return HttpResponse.json({ data: { repository: data } })
  })

describe("github", () => {
  describe("repository", () => {
    it("claims github.com, with ssh.github.com as it", () => {
      expect(github.repository(parseRemote("git@github.com:o/r.git")!)).toEqual(repo)
      expect(github.repository(parseRemote("ssh://git@ssh.github.com:443/o/r.git")!)).toEqual(repo)
    })
    it("claims an Enterprise host only where signed in", () => {
      const remote = parseRemote("https://ghe.example.com/o/r.git")!
      expect(github.repository(remote)).toBeUndefined()
      expect(github.repository(remote, ["ghe.example.com"])).toEqual({
        ...repo,
        host: "ghe.example.com",
      })
    })
  })

  describe("signedIn", () => {
    const status = "gh auth status --json hosts"
    it("lists the hosts with a working account", async () => {
      const json = JSON.stringify({
        hosts: {
          "github.com": [{ state: "success", active: true }],
          "ghe.example.com": [{ state: "error", active: true }],
        },
      })
      expect(await github.signedIn(scripted({ [status]: ok(json) }).run)).toEqual(["github.com"])
    })
    it("lists none when nothing is signed in, though gh exits 1", async () => {
      expect(await github.signedIn(scripted({ [status]: exit('{"hosts":{}}') }).run)).toEqual([])
    })
    it("is missing without gh", async () => {
      expect(await github.signedIn(scripted({ [status]: missing }).run)).toEqual({
        kind: "missing",
      })
    })
  })

  describe("token", () => {
    const line = "gh auth token --hostname github.com"
    it("reads it", async () => {
      expect(await github.token(scripted({ [line]: ok("gho_abc\n") }).run, "github.com")).toEqual({
        value: "gho_abc",
      })
    })
    it("is signed out on exit 1 or an empty answer", async () => {
      const fix = "gh auth login --hostname github.com"
      expect(
        await github.token(scripted({ [line]: exit("no oauth token found") }).run, "github.com"),
      ).toEqual({
        kind: "signed-out",
        fix,
      })
      expect(await github.token(scripted({ [line]: ok("\n") }).run, "github.com")).toEqual({
        kind: "signed-out",
        fix,
      })
    })
    it("is missing without gh and unreachable on a timeout", async () => {
      expect(await github.token(scripted({ [line]: missing }).run, "github.com")).toEqual({
        kind: "missing",
      })
      expect(await github.token(scripted({ [line]: timeout }).run, "github.com")).toEqual({
        kind: "unreachable",
      })
    })
  })

  describe("pullRequests", () => {
    const find = (branches: string[], target: Repository = repo) =>
      github.pullRequests(fetch, token, target, branches)

    it("sends the token and the branch as variables", async () => {
      let seen: { auth: string | null; variables: unknown } | undefined
      server.use(
        http.post("https://api.github.com/graphql", async ({ request }) => {
          seen = {
            auth: request.headers.get("authorization"),
            variables: ((await request.json()) as never)["variables"],
          }
          return HttpResponse.json({ data: { repository: { p0: { nodes: [] } } } })
        }),
      )
      await find(["feat/x"])
      expect(seen).toEqual({
        auth: "Bearer t0ken",
        variables: { owner: "o", name: "r", b0: "feat/x" },
      })
    })

    it("reads an open, a draft, a merged and a closed pull request", async () => {
      server.use(
        answer({
          a: [pr(1, "OPEN")],
          b: [pr(2, "OPEN", { isDraft: true })],
          c: [pr(3, "MERGED", { mergedAt: "2026-01-01T00:00:00Z" })],
          d: [pr(4, "CLOSED", { closedAt: "2026-01-01T00:00:00Z" })],
          e: [],
        }),
      )
      const found = mapOf(await find(["a", "b", "c", "d", "e"]))
      expect([...found].map(([b, p]) => [b, p.number, p.state])).toEqual([
        ["a", 1, "open"],
        ["b", 2, "draft"],
        ["c", 3, "merged"],
        ["d", 4, "closed"],
      ])
    })

    it("prefers open, then the latest merged, then the latest closed", async () => {
      server.use(
        answer({
          open: [
            pr(1, "MERGED", { mergedAt: "2026-03-01T00:00:00Z" }),
            pr(2, "OPEN"),
            pr(3, "CLOSED", { closedAt: "2026-04-01T00:00:00Z" }),
          ],
          merged: [
            pr(4, "CLOSED", { closedAt: "2026-05-01T00:00:00Z" }),
            pr(5, "MERGED", { mergedAt: "2026-01-01T00:00:00Z" }),
            pr(6, "MERGED", { mergedAt: "2026-02-01T00:00:00Z" }),
          ],
          closed: [
            pr(7, "CLOSED", { closedAt: "2026-01-01T00:00:00Z" }),
            pr(8, "CLOSED", { closedAt: "2026-02-01T00:00:00Z" }),
          ],
        }),
      )
      const found = mapOf(await find(["open", "merged", "closed"]))
      expect([
        found.get("open")?.number,
        found.get("merged")?.number,
        found.get("closed")?.number,
      ]).toEqual([2, 6, 8])
    })

    it("ignores a fork's pull request from the same-named branch", async () => {
      server.use(
        answer({
          main: [
            pr(9, "OPEN", { isCrossRepository: true }),
            pr(10, "OPEN", { isCrossRepository: null }),
          ],
        }),
      )
      expect(await find(["main"])).toEqual(new Map())
    })

    it("keeps the repository's own pull requests though its remote names it by an old name", async () => {
      server.use(answer({ a: [pr(1, "OPEN")] }))
      const renamed = { forge: "github", host: "github.com", owner: "old", name: "name" } as const
      expect(mapOf(await github.pullRequests(fetch, token, renamed, ["a"])).get("a")?.number).toBe(
        1,
      )
    })

    it("asks an Enterprise host's own API", async () => {
      let called = false
      server.use(
        http.post("https://ghe.example.com/api/graphql", () => {
          called = true
          return HttpResponse.json({ data: { repository: { p0: { nodes: [] } } } })
        }),
      )
      await find(["a"], { ...repo, host: "ghe.example.com" })
      expect(called).toBe(true)
    })

    it("answers an empty map for an unknown repository", async () => {
      server.use(
        http.post("https://api.github.com/graphql", () =>
          HttpResponse.json({
            data: { repository: null },
            errors: [{ type: "NOT_FOUND", message: "nope" }],
          }),
        ),
      )
      expect(await find(["a"])).toEqual(new Map())
    })

    it("answers an empty map on a 404", async () => {
      server.use(
        http.post("https://api.github.com/graphql", () => new HttpResponse(null, { status: 404 })),
      )
      expect(await find(["a"])).toEqual(new Map())
    })

    const status = (code: number, headers: Record<string, string> = {}) =>
      server.use(
        http.post(
          "https://api.github.com/graphql",
          () => new HttpResponse("{}", { status: code, headers }),
        ),
      )

    it("is signed out on 401", async () => {
      status(401)
      expect(await find(["a"])).toEqual({
        kind: "signed-out",
        fix: "gh auth login --hostname github.com",
      })
    })
    it("is refused on a 403, with the scope fix", async () => {
      status(403)
      expect(await find(["a"])).toEqual({
        kind: "refused",
        fix: "gh auth refresh --hostname github.com --scopes repo",
      })
    })
    it("is limited on a 403 that is a rate limit", async () => {
      status(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000000" })
      expect(await find(["a"])).toEqual({ kind: "limited", until: 1_900_000_000_000 })
    })
    it("is limited on a 429, by Retry-After", async () => {
      status(429, { "retry-after": "30" })
      const got = (await find(["a"])) as { kind: string; until: number }
      expect(got.kind).toBe("limited")
      expect(got.until).toBeGreaterThan(Date.now() + 20_000)
    })
    it("is limited on a rate-limited GraphQL answer", async () => {
      server.use(
        http.post("https://api.github.com/graphql", () =>
          HttpResponse.json({ errors: [{ type: "RATE_LIMITED", message: "slow" }] }),
        ),
      )
      expect(await find(["a"])).toMatchObject({ kind: "limited" })
    })
    it("is unreachable on a 5xx and when the network fails", async () => {
      status(502)
      expect(await find(["a"])).toEqual({ kind: "unreachable" })
      server.use(http.post("https://api.github.com/graphql", () => HttpResponse.error()))
      expect(await find(["a"])).toEqual({ kind: "unreachable" })
    })
    it("is unknown on another status", async () => {
      status(418)
      expect(await find(["a"])).toEqual({ kind: "unknown", said: "HTTP 418" })
    })
  })

  it("names its sign in", () => {
    expect(github.signIn("ghe.example.com")).toBe("gh auth login --hostname ghe.example.com")
  })
})
