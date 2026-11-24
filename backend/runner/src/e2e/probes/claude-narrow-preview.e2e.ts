import { surface } from "./claude-support.js"

// PROBE, not a test of Novadeck: how Claude Code draws a previewed question on a narrow pane,
// where its options' column wraps their labels. At some widths a wrapped label's number moves
// a row down ("❯   Commit merge and" over " 1.push (Recommended)"), seen live on 2.1.331 at
// 49x36 (2026-11-24). The screens go to PROBE_OUT, merged into fixtures/narrow-preview.probe.json.
//
// Run: PROBE_OUT=<folder> NOVADECK_E2E_PROBES=1 pnpm --filter @novadeck/runner exec vitest run \
//   --config vitest.e2e.config.ts src/e2e/probes/claude-narrow-preview.e2e.ts

const Down = "\x1b[B"
const Up = "\x1b[A"

// A question shaped like the one that showed it live (as long, with a preview as wide), in
// words of its own.
const merge = {
  questions: [
    {
      question:
        "The release branch moved on, so this branch conflicts again, only in the session file. I've resolved it, and the saved token state now lives in the shared store. Local results:\n- Lint, type checks and the build pass.\n- Full end-to-end run: 385 passed. The 2 failures were timeouts under heavy machine load (load average about 40), and both test files pass on their own (9/9).\n- Component tests: 453 of 454 passed. The one failure, a keyboard test of the list view, passes on its own; this branch doesn't touch it.\n\nMay I make this merge commit and push it (no force)? I'll then send the new head to its reviewer, who will watch CI and merge.",
      header: "Merge+push",
      multiSelect: false,
      options: [
        {
          label: "Commit merge and push (Recommended)",
          description:
            "Make the merge commit with this message and push the branch. No change to the pull request and no replies.",
          preview:
            "Merge branch 'release' into feature/saved-token-state-refresh\n\nBring in the release. Resolve the conflict in the session file by moving\nthe token state (tokensSucceed, failTokens and getTokensNow) onto\nthe shared global SessionStoreFake, so the stories' two copies\nof the session file share one session.",
        },
        {
          label: "Don't push yet",
          description: "Leave the resolved merge uncommitted in the worktree.",
        },
      ],
    },
  ],
}

surface({
  name: "narrow-preview",
  reply: { calls: [{ name: "AskUserQuestion", input: merge }] },
  shows: /Merge\+push/,
  sizes: [
    [49, 36],
    [49, 42],
    [60, 36],
    [80, 24],
    [100, 30],
  ],
  drive: async (t, _probe, shot) => {
    t.resize(49, 36)
    await shot("49x36-first", 900)
    t.press(Down)
    await shot("49x36-second")
  },
})

const preview = "line one of the preview\nline two\nline three\nline four"
const three = {
  questions: [
    {
      question: "Which way should this go?",
      header: "Way",
      multiSelect: false,
      options: [
        { label: "Short", description: "a", preview },
        { label: "A much longer label that wraps over three rows here", description: "b", preview },
        { label: "Commit merge and push (Recommended)", description: "c", preview },
      ],
    },
  ],
}

// Three labels, the one that wraps moved at each width, and the highlight moved onto it.
surface({
  name: "narrow-three",
  reply: { calls: [{ name: "AskUserQuestion", input: three }] },
  shows: /Which way should this go\?/,
  sizes: [40, 44, 49, 52, 56, 60, 64].map((columns) => [columns, 30] as [number, number]),
  drive: async (t, _probe, shot) => {
    const at = async (columns: number) => {
      t.resize(columns, 30)
      await shot(`${columns}x30-first`, 900)
      t.press(Down)
      await shot(`${columns}x30-second`)
      t.press(Down)
      await shot(`${columns}x30-third`)
      t.press(Up)
      t.press(Up)
      await shot(`${columns}x30-back`)
    }
    await at(40)
    await at(44)
  },
})
