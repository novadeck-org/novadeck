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
      const fix = { kind: "signed-out", fix: "az login --allow-no-subscriptions" }
      expect(
        await azure.token(scripted({ [line]: exit("Please run 'az login'") }).run, "x"),
      ).toEqual(fix)
      expect(await azure.token(scripted({ [line]: ok("not json") }).run, "x")).toEqual(fix)
    })
    it("is unreachable, not signed out, when renewing the token fails offline", async () => {
      const said =
        "ERROR: HTTPSConnectionPool(host='login.microsoftonline.com', port=443): Max retries exceeded with url: /organizations/oauth2/v2.0/token (Caused by NewConnectionError('Failed to establish a new connection: [Errno -3] Temporary failure in name resolution'))"
      expect(await azure.token(scripted({ [line]: exit(said) }).run, "x")).toEqual({
        kind: "unreachable",
      })
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
      expect(await find(["a"])).toEqual({
        kind: "signed-out",
        fix: "az login --allow-no-subscriptions",
      })
      server.use(http.get(url, () => new HttpResponse("<html>sign in</html>", { status: 203 })))
      expect(await find(["a"])).toEqual({
        kind: "signed-out",
        fix: "az login --allow-no-subscriptions",
      })
    })
    it("is refused on 401 naming the organization's tenant, with a sign-in to it", async () => {
      const tenant = "3F1C9A52-7D4E-4B8A-9C61-2E5D8F0A7B13"
      status(401, { "x-vss-resourcetenant": tenant })
      expect(await find(["a"])).toEqual({
        kind: "refused",
        fix: "az login --allow-no-subscriptions --tenant 3f1c9a52-7d4e-4b8a-9c61-2e5d8f0a7b13",
      })
    })
    it("is signed out on 401 naming no tenant, or none it can use", async () => {
      for (const named of ["00000000-0000-0000-0000-000000000000", "x; rm -rf ~", ""]) {
        status(401, { "x-vss-resourcetenant": named })
        // eslint-disable-next-line no-await-in-loop -- One answer set up at a time.
        expect(await find(["a"])).toEqual({
          kind: "signed-out",
          fix: "az login --allow-no-subscriptions",
        })
      }
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

  describe("ci", () => {
    const root = "https://dev.azure.com/org/My%20Project/_apis"
    const open = pr(5, "active", { repository: { project: { id: "proj-guid" } } })
    const build = (status: string, extra: Record<string, unknown> = {}) => ({
      status,
      configuration: { id: 1, isEnabled: true, type: { displayName: "Build" }, ...extra },
    })
    // A status as the list gives it: its context, its id, and the iteration it was posted on.
    const posted = (
      id: number,
      state: string,
      name = "ci",
      iterationId = 1,
      genre = "continuous-integration",
    ) => ({ id, state, iterationId, context: { genre, name } })
    const checks = (evaluations: unknown, statuses: unknown) => {
      let artifact: string | null = null
      server.use(
        byBranch({ a: [open] }),
        http.get(`${root}/policy/evaluations`, ({ request }) => {
          artifact = new URL(request.url).searchParams.get("artifactId")
          return evaluations === 403
            ? new HttpResponse("{}", { status: 403 })
            : HttpResponse.json({ value: evaluations })
        }),
        http.get(`${root}/git/repositories/repo/pullrequests/5/statuses`, () =>
          statuses === 403
            ? new HttpResponse("{}", { status: 403 })
            : HttpResponse.json({ value: statuses }),
        ),
      )
      return async () => ({
        ci: mapOf(await azure.pullRequests(fetch, token, repo, ["a"])).get("a")?.ci,
        artifact,
      })
    }
    it("asks the policy evaluations of the pull request in its project", async () => {
      const run = checks([build("approved")], [])
      expect(await run()).toEqual({
        ci: "passed",
        artifact: "vstfs:///CodeReview/CodeReviewId/proj-guid/5",
      })
    })
    it("fails on a rejected build policy or a failed or errored status", async () => {
      expect((await checks([build("rejected"), build("approved", { id: 2 })], [])()).ci).toBe(
        "failing",
      )
      expect(
        (await checks([], [posted(1, "failed", "lint"), posted(2, "succeeded", "unit")])()).ci,
      ).toBe("failing")
      expect((await checks([], [posted(1, "error")])()).ci).toBe("failing")
    })
    it("runs while a build is queued or running, or a status pending", async () => {
      expect((await checks([build("queued")], [])()).ci).toBe("running")
      expect((await checks([build("running")], [posted(1, "succeeded")])()).ci).toBe("running")
      expect((await checks([], [posted(1, "pending")])()).ci).toBe("running")
    })
    it("passes on an approved build or a succeeded status", async () => {
      expect((await checks([], [posted(1, "succeeded")])()).ci).toBe("passed")
    })
    it("is none where nothing builds, and ignores other policies and disabled builds", async () => {
      const review = {
        status: "rejected",
        configuration: { type: { displayName: "Minimum number of reviewers" } },
      }
      expect(
        (await checks([review, build("rejected", { isEnabled: false })], [posted(1, "notSet")])())
          .ci,
      ).toBe("none")
    })
    it("counts only each status context's newest post, not its history", async () => {
      // Pending, then succeeded: not running. Failed, then fixed on a later iteration: passed.
      expect((await checks([], [posted(1, "pending"), posted(2, "succeeded")])()).ci).toBe("passed")
      expect(
        (await checks([], [posted(9, "succeeded", "ci", 2), posted(3, "failed", "ci", 1)])()).ci,
      ).toBe("passed")
      // The other way round, a later failure stands over an earlier pass.
      expect((await checks([], [posted(1, "succeeded"), posted(2, "failed")])()).ci).toBe("failing")
      // Contexts apart are each their own: a second one still running keeps it running.
      expect(
        (await checks([], [posted(1, "succeeded", "unit"), posted(2, "pending", "e2e")])()).ci,
      ).toBe("running")
      expect((await checks([], [posted(1, "partiallySucceeded")])()).ci).toBe("passed")
      expect((await checks([], [posted(1, "failed"), posted(2, "notApplicable")])()).ci).toBe(
        "none",
      )
    })

    it("counts only each build policy's current evaluation", async () => {
      const old = { startedDate: "2026-01-01T00:00:00Z" }
      const now = { startedDate: "2026-01-02T00:00:00Z" }
      expect(
        (
          await checks(
            [
              { ...build("rejected"), ...old },
              { ...build("approved"), ...now },
            ],
            [],
          )()
        ).ci,
      ).toBe("passed")
      expect(
        (
          await checks(
            [
              { ...build("approved"), ...now },
              { ...build("queued"), ...old },
            ],
            [],
          )()
        ).ci,
      ).toBe("passed")
      // Another policy's own evaluation is not superseded by it.
      expect(
        (
          await checks(
            [
              { ...build("approved"), ...now },
              { ...build("rejected", { id: 2 }), ...old },
            ],
            [],
          )()
        ).ci,
      ).toBe("failing")
    })

    it("leaves ci absent where it can't be read, unless what it read already fails", async () => {
      expect((await checks(403, [posted(1, "succeeded")])()).ci).toBeUndefined()
      expect((await checks([build("approved")], 403)()).ci).toBeUndefined()
      expect((await checks(403, [posted(1, "failed")])()).ci).toBe("failing")
    })
    it("keeps the pull request where ci can't be read", async () => {
      checks(403, 403)
      const map = mapOf(await azure.pullRequests(fetch, token, repo, ["a"]))
      expect(map.get("a")).toMatchObject({ number: 5, state: "open" })
      expect(map.get("a")).not.toHaveProperty("ci")
    })
  })
})

describe("azure unfinished checks", () => {
  const root = "https://dev.azure.com/org/My%20Project/_apis"
  it("lists the pull request's builds waiting for an agent or running, with their pool", async () => {
    server.use(
      byBranch({
        a: [
          pr(5, "active", {
            targetRefName: "refs/heads/main",
            repository: { project: { id: "g" } },
          }),
        ],
      }),
      http.get(`${root}/policy/evaluations`, () =>
        HttpResponse.json({
          value: [
            {
              status: "running",
              configuration: { id: 1, isEnabled: true, type: { displayName: "Build" } },
            },
          ],
        }),
      ),
      http.get(`${root}/git/repositories/repo/pullrequests/5/statuses`, () =>
        HttpResponse.json({ value: [] }),
      ),
      http.get(`${root}/build/builds`, ({ request }) => {
        expect(new URL(request.url).searchParams.get("branchName")).toBe("refs/pull/5/merge")
        return HttpResponse.json({
          value: [
            {
              definition: { name: "ci" },
              status: "notStarted",
              queueTime: "2026-01-01T09:50:00Z",
              queue: { pool: { name: "Mac Pool" } },
            },
            {
              definition: { name: "lint" },
              status: "inProgress",
              startTime: "2026-01-01T10:00:00Z",
              queue: { pool: { name: "Azure Pipelines" } },
            },
          ],
        })
      }),
    )
    const found = mapOf(await azure.pullRequests(fetch, token, repo, ["a"])).get("a")
    expect(found?.base).toBe("main")
    expect(found?.checks).toEqual([
      {
        name: "ci",
        state: "queued",
        since: Date.parse("2026-01-01T09:50:00Z"),
        runner: "Mac Pool",
      },
      {
        name: "lint",
        state: "running",
        since: Date.parse("2026-01-01T10:00:00Z"),
        runner: "Azure Pipelines",
      },
    ])
  })
})
