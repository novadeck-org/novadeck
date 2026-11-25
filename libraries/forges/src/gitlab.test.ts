import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { exit, mapOf, missing, ok, scripted, timeout } from "./fakes.js"
import type { Repository } from "./forge.js"
import { gitlab } from "./gitlab.js"
import { parseRemote } from "./remote.js"

// A merge request's approvals, which every open one's lookup asks: by default none needed or given.
const server = setupServer(
  http.get("https://gitlab.com/api/v4/projects/g%2Fsub%2Fp/merge_requests/:iid/approvals", () =>
    HttpResponse.json({ approvals_required: 0, approvals_left: 0, approved_by: [] }),
  ),
  // A pipeline's trigger jobs: by default none.
  http.get("https://gitlab.com/api/v4/projects/g%2Fsub%2Fp/pipelines/:id/bridges", () =>
    HttpResponse.json([]),
  ),
)
beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo: Repository = { forge: "gitlab", host: "gitlab.com", path: "g/sub/p" }
const token = { value: "t0ken" }
const url = "https://gitlab.com/api/v4/projects/g%2Fsub%2Fp/merge_requests"

const mr = (iid: number, state: string, extra: Record<string, unknown> = {}) => ({
  iid,
  web_url: `https://gitlab.com/g/sub/p/-/merge_requests/${iid}`,
  title: `MR ${iid}`,
  state,
  draft: false,
  source_project_id: 7,
  target_project_id: 7,
  ...extra,
})

const byBranch = (lists: Record<string, unknown[]>) =>
  http.get(url, ({ request }) =>
    HttpResponse.json(lists[new URL(request.url).searchParams.get("source_branch") ?? ""] ?? []),
  )

describe("gitlab", () => {
  describe("repository", () => {
    it("claims gitlab.com with its subgroups", () => {
      expect(gitlab.repository(parseRemote("git@gitlab.com:g/sub/p.git")!)).toEqual(repo)
      expect(gitlab.repository(parseRemote("https://gitlab.com/g/sub/p")!)).toEqual(repo)
    })
    it("claims a self-managed host only where signed in", () => {
      const remote = parseRemote("ssh://git@git.example.com:2222/g/sub/p.git")!
      expect(gitlab.repository(remote)).toBeUndefined()
      expect(gitlab.repository(remote, ["git.example.com"])).toEqual({
        ...repo,
        host: "git.example.com",
      })
    })
  })

  describe("signedIn", () => {
    const json = "glab auth status --output json"
    const text = "glab auth status"
    it("lists the hosts its JSON status reports signed in, though it exits 1", async () => {
      const hosts = JSON.stringify({
        hosts: [
          { host: "gitlab.com", state: "success", user: "me", token_source: "keyring" },
          { host: "git.example.com", state: "failed", error: "401 Unauthorized" },
        ],
      })
      expect(await gitlab.signedIn(scripted({ [json]: exit(hosts) }).run)).toEqual(["gitlab.com"])
      expect(await gitlab.signedIn(scripted({ [json]: ok(hosts) }).run)).toEqual(["gitlab.com"])
    })
    it("reads an older glab's text, which it writes on standard error even on success", async () => {
      const said =
        "gitlab.com\n  ✓ Logged in to gitlab.com as me (keyring)\ngit.example.com\n  x git.example.com: API call failed\n"
      const older = { [json]: exit("unknown flag: --output") }
      expect(await gitlab.signedIn(scripted({ ...older, [text]: ok("", said) }).run)).toEqual([
        "gitlab.com",
      ])
      expect(await gitlab.signedIn(scripted({ ...older, [text]: exit(said) }).run)).toEqual([
        "gitlab.com",
      ])
    })
    it("is missing without glab", async () => {
      expect(await gitlab.signedIn(scripted({ [json]: missing }).run)).toEqual({
        kind: "missing",
      })
    })
  })

  describe("token", () => {
    const config = "glab config get token --host gitlab.com"
    const status = "glab auth status --hostname gitlab.com --show-token"
    const fix = "glab auth login --hostname gitlab.com"
    const shown = (where: string, value: string) =>
      `gitlab.com\n  ✓ Logged in to gitlab.com as me (${where})\n  ✓ Token found in ${where}: ${value}\n`
    it("asks the status first, which renews an OAuth login, and reads the token it shows on standard error", async () => {
      const { run, calls } = scripted({ [status]: ok("", shown("keyring", "glpat-2")) })
      expect(await gitlab.token(run, "gitlab.com")).toEqual({ value: "glpat-2" })
      expect(calls).toEqual([status])
    })
    it("reads an older glab's token line", async () => {
      const older = scripted({ [status]: ok("", "  ✓ Token: glpat-3\n") })
      expect(await gitlab.token(older.run, "gitlab.com")).toEqual({ value: "glpat-3" })
    })
    it("falls back to the config where the status shows no token", async () => {
      const { run, calls } = scripted({
        [status]: ok("", "✓ Logged in\n"),
        [config]: ok("glpat-1\n"),
      })
      expect(await gitlab.token(run, "gitlab.com")).toEqual({ value: "glpat-1" })
      expect(calls).toEqual([status, config])
    })
    it("does not take a masked token", async () => {
      const masked = scripted({
        [status]: ok("", shown("config file", "**************")),
        [config]: ok(""),
      })
      expect(await gitlab.token(masked.run, "gitlab.com")).toEqual({ kind: "signed-out", fix })
    })
    it("is signed out when the status fails, and passes on nothing it wrote", async () => {
      const failed = scripted({ [status]: exit(shown("keyring", "glpat-secret")) })
      const answer = await gitlab.token(failed.run, "gitlab.com")
      expect(answer).toEqual({ kind: "signed-out", fix })
      expect(JSON.stringify(answer)).not.toContain("glpat-secret")
    })
    it("is unreachable, not signed out, when the status fails offline", async () => {
      const offline = scripted({
        [status]: exit(
          "gitlab.com\n  x gitlab.com: api call failed: GET https://gitlab.com/api/v4/user: dial tcp: lookup gitlab.com: no such host\n",
        ),
      })
      expect(await gitlab.token(offline.run, "gitlab.com")).toEqual({ kind: "unreachable" })
    })
    it("is missing without glab and unreachable on a timeout", async () => {
      expect(await gitlab.token(scripted({ [status]: missing }).run, "gitlab.com")).toEqual({
        kind: "missing",
      })
      expect(await gitlab.token(scripted({ [status]: timeout }).run, "gitlab.com")).toEqual({
        kind: "unreachable",
      })
    })
  })

  describe("pullRequests", () => {
    const find = (branches: string[], target: Repository = repo) =>
      gitlab.pullRequests(fetch, token, target, branches)

    it("reads open, draft, merged and closed", async () => {
      server.use(
        byBranch({
          a: [mr(1, "opened")],
          b: [mr(2, "opened", { draft: true })],
          c: [mr(3, "merged", { merged_at: "2026-01-01T00:00:00Z" })],
          d: [mr(4, "closed", { closed_at: "2026-01-01T00:00:00Z" })],
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
    it("sends the token and the branch", async () => {
      let seen: { auth: string | null; branch: string | null } | undefined
      server.use(
        http.get(url, ({ request }) => {
          seen = {
            auth: request.headers.get("authorization"),
            branch: new URL(request.url).searchParams.get("source_branch"),
          }
          return HttpResponse.json([])
        }),
      )
      await find(["feat/x"])
      expect(seen).toEqual({ auth: "Bearer t0ken", branch: "feat/x" })
    })
    it("prefers open, then the latest merged, then the latest closed", async () => {
      server.use(
        byBranch({
          open: [mr(1, "merged", { merged_at: "2026-03-01T00:00:00Z" }), mr(2, "opened")],
          merged: [
            mr(3, "closed", { closed_at: "2026-05-01T00:00:00Z" }),
            mr(4, "merged", { merged_at: "2026-01-01T00:00:00Z" }),
            mr(5, "merged", { merged_at: "2026-02-01T00:00:00Z" }),
          ],
          closed: [
            mr(6, "closed", { closed_at: "2026-01-01T00:00:00Z" }),
            mr(7, "closed", { closed_at: "2026-02-01T00:00:00Z" }),
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
    it("ignores a merge request from a fork", async () => {
      server.use(byBranch({ main: [mr(1, "opened", { source_project_id: 99 })] }))
      expect(await find(["main"])).toEqual(new Map())
    })
    it("asks a self-managed host's own API", async () => {
      let called = false
      server.use(
        http.get("https://git.example.com/api/v4/projects/g%2Fsub%2Fp/merge_requests", () => {
          called = true
          return HttpResponse.json([])
        }),
      )
      await find(["a"], { ...repo, host: "git.example.com" })
      expect(called).toBe(true)
    })

    const status = (code: number, headers: Record<string, string> = {}) =>
      server.use(http.get(url, () => new HttpResponse("{}", { status: code, headers })))
    it("answers an empty map on 404", async () => {
      status(404)
      expect(await find(["a"])).toEqual(new Map())
    })
    it("is signed out on 401", async () => {
      status(401)
      expect(await find(["a"])).toEqual({
        kind: "signed-out",
        fix: "glab auth login --hostname gitlab.com",
      })
    })
    it("is refused on 403", async () => {
      status(403)
      expect(await find(["a"])).toEqual({ kind: "refused" })
    })
    it("is limited on 403 with Retry-After and on 429", async () => {
      status(403, { "retry-after": "10" })
      expect(await find(["a"])).toMatchObject({ kind: "limited" })
      status(429, { "ratelimit-reset": "1900000000" })
      expect(await find(["a"])).toEqual({ kind: "limited", until: 1_900_000_000_000 })
    })
    it("is unreachable on 5xx", async () => {
      status(503)
      expect(await find(["a"])).toEqual({ kind: "unreachable" })
    })
    it("is unknown on another status", async () => {
      status(400)
      expect(await find(["a"])).toEqual({ kind: "unknown", said: "HTTP 400" })
    })
  })

  describe("ci", () => {
    const pipeline = (iid: number, body: Record<string, unknown>) =>
      http.get(`${url}/${iid}`, () => HttpResponse.json(body))
    const found = async (pipelines: Record<string, Record<string, unknown>>) => {
      const branches = Object.keys(pipelines)
      server.use(
        byBranch(
          Object.fromEntries(branches.map((branch, at) => [branch, [mr(at + 1, "opened")]])),
        ),
        ...branches.map((branch, at) => pipeline(at + 1, pipelines[branch]!)),
      )
      const map = mapOf(await gitlab.pullRequests(fetch, token, repo, branches))
      return Object.fromEntries([...map].map(([branch, one]) => [branch, one.ci]))
    }
    const status = (value: string) => ({ head_pipeline: { status: value } })
    it("maps the head pipeline's status", async () => {
      expect(
        await found({
          a: status("failed"),
          b: status("success"),
          c: status("running"),
          d: status("pending"),
          e: status("created"),
          f: status("waiting_for_resource"),
          g: status("preparing"),
          h: status("scheduled"),
          i: status("canceled"),
          j: status("skipped"),
          k: status("manual"),
          l: { head_pipeline: null },
        }),
      ).toEqual({
        a: "failing",
        b: "passed",
        c: "running",
        d: "running",
        e: "running",
        f: "running",
        g: "running",
        h: "running",
        i: "none",
        j: "none",
        k: "none",
        l: "none",
      })
    })
    it("asks only open merge requests", async () => {
      server.use(byBranch({ m: [mr(1, "merged", { merged_at: "2026-01-01T00:00:00Z" })] }))
      const map = mapOf(await gitlab.pullRequests(fetch, token, repo, ["m"]))
      expect(map.get("m")).not.toHaveProperty("ci")
    })
    it("leaves ci absent where the pipeline can't be read, keeping the request", async () => {
      server.use(
        byBranch({ a: [mr(1, "opened")] }),
        http.get(`${url}/1`, () => new HttpResponse("{}", { status: 403 })),
      )
      const map = mapOf(await gitlab.pullRequests(fetch, token, repo, ["a"]))
      expect(map.get("a")).toEqual({
        number: 1,
        url: "https://gitlab.com/g/sub/p/-/merge_requests/1",
        title: "MR 1",
        state: "open",
      })
    })
  })
})

describe("gitlab unfinished checks", () => {
  afterEach(() => vi.useRealTimers())
  it("lists a running pipeline's pending and running jobs with their tags", async () => {
    // The Jobs API has no queued_at: a pending job says how many seconds it has queued.
    const now = Date.parse("2026-01-01T10:00:00Z")
    vi.useFakeTimers({ toFake: ["Date"], now })
    server.use(
      byBranch({ a: [mr(1, "opened", { target_branch: "release" })] }),
      http.get(`${url}/1`, () =>
        HttpResponse.json({ head_pipeline: { id: 9, status: "running" } }),
      ),
      http.get("https://gitlab.com/api/v4/projects/g%2Fsub%2Fp/pipelines/9/jobs", () =>
        HttpResponse.json([
          {
            name: "build",
            status: "running",
            started_at: "2026-01-01T10:00:00Z",
            tag_list: ["macos"],
          },
          {
            name: "test",
            status: "pending",
            created_at: "2026-01-01T09:00:00Z",
            queued_duration: 600.5,
            tag_list: ["macos", "arm"],
          },
          { name: "old", status: "pending", created_at: "2026-01-01T09:30:00Z", tag_list: [] },
          { name: "later", status: "created", created_at: "2026-01-01T09:50:00Z", tag_list: [] },
        ]),
      ),
    )
    const found = mapOf(await gitlab.pullRequests(fetch, token, repo, ["a"])).get("a")
    expect(found?.base).toBe("release")
    expect(found?.checks).toEqual([
      {
        name: "build",
        state: "running",
        since: Date.parse("2026-01-01T10:00:00Z"),
        runner: "macos",
      },
      {
        name: "test",
        state: "queued",
        since: now - 600_500,
        runner: "macos arm",
      },
      { name: "old", state: "queued", since: Date.parse("2026-01-01T09:30:00Z") },
      { name: "later", state: "held", hold: "earlier" },
    ])
  })
})

describe("gitlab merge request facts", () => {
  const jobs = "https://gitlab.com/api/v4/projects/g%2Fsub%2Fp/pipelines/9/jobs"
  it("lists every job of the head pipeline, by job id, finished or not", async () => {
    server.use(
      byBranch({ a: [mr(1, "opened", { target_branch: "main" })] }),
      http.get(`${url}/1`, () => HttpResponse.json({ head_pipeline: { id: 9, status: "failed" } })),
      // The API lists the newest job first.
      http.get(jobs, () =>
        HttpResponse.json([
          { id: 8, name: "deploy", status: "manual" },
          { id: 7, name: "docs", status: "skipped" },
          { id: 6, name: "wait", status: "waiting_for_resource" },
          { id: 5, name: "e2e", status: "canceled" },
          { id: 4, name: "flaky", status: "failed", allow_failure: true },
          { id: 3, name: "unit", status: "failed", allow_failure: false },
          { id: 2, name: "lint", status: "success" },
          { id: 1, name: "build", status: "success" },
        ]),
      ),
    )
    const found = mapOf(await gitlab.pullRequests(fetch, token, repo, ["a"])).get("a")
    expect(found?.ci).toBe("failing")
    expect(found?.checks).toEqual([
      { name: "build", state: "passed" },
      { name: "lint", state: "passed" },
      { name: "unit", state: "failed" },
      { name: "flaky", state: "passed" },
      { name: "e2e", state: "failed" },
      { name: "wait", state: "held", hold: "concurrency" },
    ])
  })

  it("lists trigger jobs among the jobs, held by their pipeline while it runs", async () => {
    server.use(
      byBranch({ a: [mr(1, "opened")] }),
      http.get(`${url}/1`, () =>
        HttpResponse.json({ head_pipeline: { id: 9, status: "running" } }),
      ),
      http.get(jobs, () => HttpResponse.json([{ id: 1, name: "build", status: "success" }])),
      http.get("https://gitlab.com/api/v4/projects/g%2Fsub%2Fp/pipelines/9/bridges", () =>
        HttpResponse.json([
          { id: 3, name: "deploy-docs", status: "success" },
          { id: 2, name: "child", status: "running" },
        ]),
      ),
    )
    const found = mapOf(await gitlab.pullRequests(fetch, token, repo, ["a"])).get("a")
    expect(found?.checks).toEqual([
      { name: "build", state: "passed" },
      { name: "child", state: "held", hold: "downstream" },
      { name: "deploy-docs", state: "passed" },
    ])
  })

  it("keeps the jobs where the trigger jobs can't be read", async () => {
    server.use(
      byBranch({ a: [mr(1, "opened")] }),
      http.get(`${url}/1`, () =>
        HttpResponse.json({ head_pipeline: { id: 9, status: "success" } }),
      ),
      http.get(jobs, () => HttpResponse.json([{ id: 1, name: "build", status: "success" }])),
      http.get(
        "https://gitlab.com/api/v4/projects/g%2Fsub%2Fp/pipelines/9/bridges",
        () => new HttpResponse("{}", { status: 403 }),
      ),
    )
    const found = mapOf(await gitlab.pullRequests(fetch, token, repo, ["a"])).get("a")
    expect(found?.checks).toEqual([{ name: "build", state: "passed" }])
  })

  it("keeps the target branch of a merged or closed merge request", async () => {
    server.use(
      byBranch({
        m: [mr(1, "merged", { merged_at: "2026-01-01T00:00:00Z", target_branch: "feature" })],
        c: [mr(2, "closed", { closed_at: "2026-01-01T00:00:00Z", target_branch: "main" })],
      }),
    )
    const found = mapOf(await gitlab.pullRequests(fetch, token, repo, ["m", "c"]))
    expect(found.get("m")).toMatchObject({ state: "merged", base: "feature" })
    expect(found.get("c")).toMatchObject({ state: "closed", base: "main" })
    expect(found.get("m")).not.toHaveProperty("review")
  })

  describe("review", () => {
    const reviews = async (
      cases: Record<string, { status?: string; approvals?: Record<string, unknown> | 403 }>,
    ) => {
      const branches = Object.keys(cases)
      server.use(
        byBranch(
          Object.fromEntries(branches.map((branch, at) => [branch, [mr(at + 1, "opened")]])),
        ),
        ...branches.flatMap((branch, at) => {
          const { status, approvals } = cases[branch]!
          return [
            http.get(`${url}/${at + 1}`, () =>
              HttpResponse.json({
                head_pipeline: null,
                ...(status !== undefined && { detailed_merge_status: status }),
              }),
            ),
            ...(approvals === undefined
              ? []
              : [
                  http.get(`${url}/${at + 1}/approvals`, () =>
                    approvals === 403
                      ? new HttpResponse("{}", { status: 403 })
                      : HttpResponse.json(approvals),
                  ),
                ]),
          ]
        }),
      )
      const map = mapOf(await gitlab.pullRequests(fetch, token, repo, branches))
      return Object.fromEntries([...map].map(([branch, one]) => [branch, one.review]))
    }
    const approved = { approved_by: [{ user: { username: "x" } }] }
    it("reads requested changes, approvals still needed, and approvals given", async () => {
      expect(
        await reviews({
          a: { status: "requested_changes", approvals: { approvals_left: 0, ...approved } },
          b: { status: "not_approved", approvals: { approvals_left: 1, approved_by: [] } },
          c: { status: "mergeable", approvals: { approvals_left: 1, ...approved } },
          d: { status: "mergeable", approvals: { approvals_left: 0, ...approved } },
          e: { status: "mergeable", approvals: { approved_by: [] } },
          f: { status: "not_approved", approvals: 403 },
          g: { status: "mergeable", approvals: 403 },
        }),
      ).toEqual({
        a: "changes_requested",
        b: "required",
        c: "required",
        d: "approved",
        e: "none",
        f: "required",
        g: undefined,
      })
    })
  })
})
