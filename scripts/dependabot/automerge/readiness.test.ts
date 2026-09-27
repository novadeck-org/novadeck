import { HttpResponse, http } from "msw"

import { context, describe, expect, it } from "../../test"
import { server } from "../../test/server"
import { hasRequiredChecks, ready } from "./readiness"

const env = {
  BASE_REF: "main",
  GH_TOKEN: "fixture-token",
  GITHUB_API_URL: "https://api.github.test",
  GITHUB_REPOSITORY: "test/consumer",
}

const repository = (auto = true): void => {
  server.use(
    http.get("https://api.github.test/repos/test/consumer", () =>
      HttpResponse.json({ allow_auto_merge: auto, allow_squash_merge: true }),
    ),
  )
}

describe("Dependabot automerge readiness", () => {
  context("when the repository has required checks", () => {
    it("accepts classic branch protection", async () => {
      repository()
      server.use(
        http.get("https://api.github.test/repos/test/consumer/branches/main", () =>
          HttpResponse.json({
            protected: true,
            protection: { required_status_checks: { contexts: ["Verify"] } },
          }),
        ),
      )

      await expect(ready(env)).resolves.toBe(true)
    })

    it("accepts an active ruleset", async () => {
      repository()
      server.use(
        http.get("https://api.github.test/repos/test/consumer/branches/main", () =>
          HttpResponse.json({ protected: false }),
        ),
        http.get("https://api.github.test/repos/test/consumer/rules/branches/main", () =>
          HttpResponse.json([
            {
              type: "required_status_checks",
              parameters: { required_status_checks: [{ context: "Test" }] },
            },
          ]),
        ),
      )

      await expect(ready(env)).resolves.toBe(true)
    })
  })

  context("when readiness is incomplete", () => {
    it("stops when repository automerge is disabled", async () => {
      repository(false)

      await expect(ready(env)).resolves.toBe(false)
    })

    it("fails closed when branch rules cannot be read", async () => {
      repository()
      server.use(
        http.get("https://api.github.test/repos/test/consumer/branches/main", () =>
          HttpResponse.json({ protected: false }),
        ),
        http.get(
          "https://api.github.test/repos/test/consumer/rules/branches/main",
          () => new HttpResponse(null, { status: 403 }),
        ),
      )

      await expect(ready(env)).rejects.toThrow("GitHub API returned 403")
    })
  })

  it("rejects an invalid branch rules response", () => {
    expect(() => hasRequiredChecks({}, {})).toThrow("Branch rules response must be a list")
  })
})
