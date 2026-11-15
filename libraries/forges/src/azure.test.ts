import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { azure } from "./azure.js"
import { exit, mapOf, missing, ok, scripted, timeout } from "./fakes.js"
import type { Repository } from "./forge.js"
import { parseRemote } from "./remote.js"

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo: Repository = {
  forge: "azure",
  host: "dev.azure.com",
  organization: "org",
  project: "My Project",
  name: "repo",
}
const token = { value: "t0ken" }
const url = "https://dev.azure.com/org/My%20Project/_apis/git/repositories/repo/pullrequests"

const pr = (id: number, status: string, extra: Record<string, unknown> = {}) => ({
  pullRequestId: id,
  title: `PR ${id}`,
  status,
  isDraft: false,
  creationDate: "2026-01-01T00:00:00Z",
  ...extra,
})

const byBranch = (lists: Record<string, unknown[]>) =>
  http.get(url, ({ request }) => {
    const ref = new URL(request.url).searchParams.get("searchCriteria.sourceRefName") ?? ""
    return HttpResponse.json({ value: lists[ref.replace("refs/heads/", "")] ?? [] })
  })

describe("azure", () => {
  describe("repository", () => {
    it.each([
      ["https://dev.azure.com/org/proj/_git/repo", "proj"],
      ["https://org@dev.azure.com/org/proj/_git/repo", "proj"],
      ["git@ssh.dev.azure.com:v3/org/proj/repo", "proj"],
      ["https://org.visualstudio.com/proj/_git/repo", "proj"],
      ["https://org.visualstudio.com/DefaultCollection/proj/_git/repo", "proj"],
      ["org@vs-ssh.visualstudio.com:v3/org/proj/repo", "proj"],
      ["https://dev.azure.com/org/My%20Project/_git/repo", "My Project"],
    ])("claims %s", (remote, project) => {
      expect(azure.repository(parseRemote(remote)!)).toEqual({
        forge: "azure",
        host: "dev.azure.com",
        organization: "org",
        project,
        name: "repo",
      })
    })
    it("reads a repository named alone as its own project", () => {
      expect(azure.repository(parseRemote("https://dev.azure.com/org/_git/repo")!)).toMatchObject({
        project: "repo",
        name: "repo",
      })
    })
    it("does not claim other hosts, even a signed-in one", () => {
      expect(
        azure.repository(parseRemote("https://devops.example.com/org/proj/_git/repo")!, [
          "devops.example.com",
        ]),
      ).toBeUndefined()
      expect(azure.repository(parseRemote("https://github.com/o/r")!)).toBeUndefined()
    })
  })

  describe("signedIn", () => {
    const show = "az account show -o json"
    it("is the Azure DevOps host when az has an account", async () => {
      expect(await azure.signedIn(scripted({ [show]: ok("{}") }).run)).toEqual(["dev.azure.com"])
    })
    it("is none when az says to log in", async () => {
      expect(
        await azure.signedIn(
          scripted({ [show]: exit("ERROR: Please run 'az login' to setup account.") }).run,
        ),
      ).toEqual([])
    })
    it("is missing without az", async () => {
      expect(await azure.signedIn(scripted({ [show]: missing }).run)).toEqual({ kind: "missing" })
    })
  })

  describe("token", () => {
    const line =
      "az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 -o json"
    it("reads the token and its expiry in seconds", async () => {
      const out = JSON.stringify({
        accessToken: "eyJ",
        expiresOn: "2026-11-15 10:00:00.000000",
        expires_on: 1_900_000_000,
      })
      expect(await azure.token(scripted({ [line]: ok(out) }).run, "dev.azure.com")).toEqual({
        value: "eyJ",
        expiresAt: 1_900_000_000_000,
      })
    })
    it("reads expiresOn when that is all there is", async () => {
      const out = JSON.stringify({ accessToken: "eyJ", expiresOn: "2026-11-15 10:00:00.000000" })
      const got = (await azure.token(scripted({ [line]: ok(out) }).run, "dev.azure.com")) as {
        expiresAt?: number
      }
      expect(got.expiresAt).toBe(new Date(2026, 10, 15, 10).getTime())
    })
    it("has no expiry where az gives none", async () => {
      expect(
        await azure.token(scripted({ [line]: ok('{"accessToken":"eyJ"}') }).run, "dev.azure.com"),
      ).toEqual({ value: "eyJ" })
    })
    it("is signed out when az fails or answers nothing usable", async () => {
      const fix = { kind: "signed-out", fix: "az login" }
      expect(
        await azure.token(scripted({ [line]: exit("Please run 'az login'") }).run, "x"),
      ).toEqual(fix)
      expect(await azure.token(scripted({ [line]: ok("not json") }).run, "x")).toEqual(fix)
    })
    it("is missing without az and unreachable on a timeout", async () => {
      expect(await azure.token(scripted({ [line]: missing }).run, "x")).toEqual({ kind: "missing" })
      expect(await azure.token(scripted({ [line]: timeout }).run, "x")).toEqual({
        kind: "unreachable",
      })
    })
  })

  describe("pullRequests", () => {
    const find = (branches: string[]) => azure.pullRequests(fetch, token, repo, branches)

    it("reads open, draft, merged and closed, with the page's address", async () => {
      server.use(
        byBranch({
          a: [pr(1, "active")],
          b: [pr(2, "active", { isDraft: true })],
          c: [pr(3, "completed")],
          d: [pr(4, "abandoned")],
        }),
      )
      const found = mapOf(await find(["a", "b", "c", "d", "e"]))
      expect([...found].map(([b, p]) => [b, p.number, p.state])).toEqual([
        ["a", 1, "open"],
        ["b", 2, "draft"],
        ["c", 3, "merged"],
        ["d", 4, "closed"],
      ])
      expect(found.get("a")?.url).toBe(
        "https://dev.azure.com/org/My%20Project/_git/repo/pullrequest/1",
      )
    })
    it("sends the token and the branch's ref", async () => {
      let seen: { auth: string | null; params: URLSearchParams } | undefined
      server.use(
        http.get(url, ({ request }) => {
          seen = {
            auth: request.headers.get("authorization"),
            params: new URL(request.url).searchParams,
          }
          return HttpResponse.json({ value: [] })
        }),
      )
      await find(["feat/x"])
      expect(seen?.auth).toBe("Bearer t0ken")
      expect(seen?.params.get("searchCriteria.sourceRefName")).toBe("refs/heads/feat/x")
      expect(seen?.params.get("searchCriteria.status")).toBe("all")
      expect(seen?.params.get("api-version")).toBe("7.1")
    })
    it("prefers open, then the latest completed, then the latest abandoned", async () => {
      server.use(
        byBranch({
          open: [pr(1, "completed", { closedDate: "2026-03-01T00:00:00Z" }), pr(2, "active")],
          merged: [
            pr(3, "abandoned", { closedDate: "2026-05-01T00:00:00Z" }),
            pr(4, "completed", { closedDate: "2026-01-01T00:00:00Z" }),
            pr(5, "completed", { closedDate: "2026-02-01T00:00:00Z" }),
          ],
          closed: [
            pr(6, "abandoned", { closedDate: "2026-01-01T00:00:00Z" }),
            pr(7, "abandoned", { closedDate: "2026-02-01T00:00:00Z" }),
          ],
        }),
      )
      const found = mapOf(await find(["open", "merged", "closed"]))
      expect([
        found.get("open")?.number,
        found.get("merged")?.number,
        found.get("closed")?.number,
      ]).toEqual([2, 5, 7])
    })
    it("ignores a pull request from a fork", async () => {
      server.use(byBranch({ main: [pr(1, "active", { forkSource: { repository: { id: "x" } } })] }))
      expect(await find(["main"])).toEqual(new Map())
    })

    const status = (code: number, headers: Record<string, string> = {}) =>
      server.use(http.get(url, () => new HttpResponse("<html>", { status: code, headers })))
    it("answers an empty map on 404", async () => {
      status(404)
      expect(await find(["a"])).toEqual(new Map())
    })
    it("is signed out on 401, and on a 203 sign-in page", async () => {
      status(401)
      expect(await find(["a"])).toEqual({ kind: "signed-out", fix: "az login" })
      server.use(http.get(url, () => new HttpResponse("<html>sign in</html>", { status: 203 })))
      expect(await find(["a"])).toEqual({ kind: "signed-out", fix: "az login" })
    })
    it("is refused on 403", async () => {
      status(403)
      expect(await find(["a"])).toEqual({ kind: "refused" })
    })
    it("is limited on 429", async () => {
      status(429, { "retry-after": "5" })
      expect(await find(["a"])).toMatchObject({ kind: "limited" })
    })
    it("is unreachable on 5xx", async () => {
      status(500)
      expect(await find(["a"])).toEqual({ kind: "unreachable" })
    })
  })
})
