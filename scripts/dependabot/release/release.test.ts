import { HttpResponse, http } from "msw"
import { vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { server } from "../../test/server"
import { dispatchReleaseAfterMerge } from "./release"

const env = {
  GH_TOKEN: "fixture-token",
  GITHUB_API_URL: "https://api.github.test",
  GITHUB_REPOSITORY: "test/consumer",
  PR_NUMBER: "42",
}

describe("Dependabot release dispatch", () => {
  context("when automerge completes", () => {
    it("dispatches the exact merge commit", async () => {
      let payload: unknown
      server.use(
        http.get("https://api.github.test/repos/test/consumer/pulls/42", () =>
          HttpResponse.json({ merge_commit_sha: "abc123", merged: true, state: "closed" }),
        ),
        http.post(
          "https://api.github.test/repos/test/consumer/dispatches",
          async ({ request }) => {
            payload = await request.json()
            return new HttpResponse(null, { status: 204 })
          },
        ),
      )

      await expect(dispatchReleaseAfterMerge(env)).resolves.toBe("abc123")
      expect(payload).toEqual({
        client_payload: { sha: "abc123" },
        event_type: "release",
      })
    })

    it("waits while the pull request is open", async () => {
      const pause = vi.fn(async () => undefined)
      let reads = 0
      server.use(
        http.get("https://api.github.test/repos/test/consumer/pulls/42", () => {
          reads += 1
          return HttpResponse.json(
            reads === 1
              ? { merge_commit_sha: null, merged: false, state: "open" }
              : { merge_commit_sha: "abc123", merged: true, state: "closed" },
          )
        }),
        http.post(
          "https://api.github.test/repos/test/consumer/dispatches",
          () => new HttpResponse(null, { status: 204 }),
        ),
      )

      await dispatchReleaseAfterMerge(env, pause)

      expect(pause).toHaveBeenCalledOnce()
    })
  })

  context("when the pull request closes without merging", () => {
    it("does not dispatch", async () => {
      server.use(
        http.get("https://api.github.test/repos/test/consumer/pulls/42", () =>
          HttpResponse.json({ merge_commit_sha: null, merged: false, state: "closed" }),
        ),
      )

      await expect(dispatchReleaseAfterMerge(env)).rejects.toThrow("closed without merging")
    })
  })
})
