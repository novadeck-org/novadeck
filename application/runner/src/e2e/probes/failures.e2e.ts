import { appendFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"

import { harnesses } from "../../harnesses/registry.js"
import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, Refusal } from "../model/script.js"
import { own, start } from "../scenarios.js"

// PROBE, not a regression test: what each harness's hooks and rollout say when its model
// answers a turn with a refusal or a usage limit, to decode `error` and `limited`.
// Every payload that ends a turn goes to <FAILURE_PROBE_OUT>/<agent>.jsonl.
// Run: NOVADECK_E2E_PROBES=1 NOVADECK_E2E_AGENTS=claude pnpm --filter @novadeck/runner exec vitest run \
//   --config vitest.e2e.config.ts src/e2e/probes/failures.e2e.ts

const out = process.env.FAILURE_PROBE_OUT ?? join(tmpdir(), "failure-probe")
mkdirSync(out, { recursive: true })

const bodies: Record<string, () => Refusal> = {
  bad: () => new Refusal(400),
  limit: () =>
    new Refusal(
      429,
      {
        type: "error",
        error: { type: "rate_limit_error", message: "This request would exceed your usage limit." },
      },
      {
        "x-should-retry": "false",
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3600),
      },
    ),
  gemini: () =>
    new Refusal(429, {
      error: {
        code: 429,
        message:
          "You have exhausted your capacity on this model. Your quota will reset after 59m30s.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "QUOTA_EXHAUSTED",
            domain: "cloudcode-pa.googleapis.com",
            metadata: { uiMessage: "true", model: "gemini-3.1-pro", quotaResetDelay: "59m30s" },
          },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1s" },
        ],
      },
    }),
  codex: () =>
    new Refusal(429, {
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        plan_type: "plus",
        resets_at: Math.floor(Date.now() / 1000) + 3600,
        resets_in_seconds: 3600,
      },
    }),
}

const which = process.env.FAILURE_PROBE_KIND ?? "bad"

for (const setup of setups) {
  describe.skipIf(!supported)(`${setup.name} failures (probe)`, () => {
    const it = e2e(setup)
    it(`ends a turn with ${which}`, async ({ e2e: run }) => {
      const harness = harnesses[setup.agent] as { decode: Harness["decode"] }
      const decode = harness.decode
      harness.decode = (report) => {
        const events = decode(report)
        if (
          /Stop|task_complete|error/i.test(JSON.stringify(report.payload).slice(0, 4000)) ||
          /Stop/.test(report.event)
        )
          appendFileSync(
            join(out, `${setup.agent}-${which}.jsonl`),
            JSON.stringify({ event: report.event, payload: report.payload, events }) + "\n",
          )
        return events
      }
      run.model.use(
        own((call) => {
          if (!call.side && asked(call, "Refuse this")) throw bodies[which]!()
          return undefined
        }),
      )
      const t1 = await start(run, setup)
      await t1.submit("Refuse this")
      await new Promise((resolve) =>
        setTimeout(resolve, Number(process.env.FAILURE_PROBE_WAIT ?? 45_000)),
      )
      appendFileSync(
        join(out, `${setup.agent}-${which}.jsonl`),
        JSON.stringify({ summary: t1.summary().activity }) + "\n",
      )
      harness.decode = decode
    })
  })
}
