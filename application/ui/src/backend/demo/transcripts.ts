import type { ChatAnswer, ChatDialog, ChatItem, ChatRequest } from "../../model/conversation"

// What a demo agent's conversation opens with: its records, as its harness wrote them, and
// what waits on the person.
export type DemoTranscript = {
  readonly items: readonly ChatItem[]
  readonly requests: readonly ChatRequest[]
  // What answering a request does, by the request's id: only for those the demo can answer.
  readonly outcomes?: Readonly<
    Record<string, (answer: ChatAnswer, dialog: ChatDialog) => DemoOutcome>
  >
}

// What an answer leaves in the conversation, as the harness records it: the records it
// adds, then either what the agent says as its turn goes on, or the person's words, which
// become the agent's next prompt.
export type DemoOutcome =
  | { readonly items: readonly DemoDraft[]; readonly reply: string }
  | { readonly items: readonly DemoDraft[]; readonly prompt: string }
  // The turn ends there, and the agent waits at its prompt for the person's words.
  | { readonly items: readonly DemoDraft[]; readonly waits: true }

export type DemoDraft = Pick<ChatItem, "role" | "kind" | "text"> &
  Partial<Pick<ChatItem, "tool" | "call" | "author" | "truncated">>

const user = (text: string): DemoDraft => ({ role: "user", kind: "text", text })
const say = (text: string): DemoDraft => ({
  role: "assistant",
  kind: "text",
  text,
})
const use = (call: string, tool: string, input: unknown): DemoDraft => ({
  role: "assistant",
  kind: "tool-call",
  tool,
  call,
  text: typeof input === "string" ? input : JSON.stringify(input),
})
const got = (call: string, text: string, truncated = false): DemoDraft => ({
  role: "tool",
  kind: "tool-result",
  call,
  text,
  truncated,
})
const from = (author: string, text: string): DemoDraft => ({
  role: "agent",
  kind: "text",
  text,
  author,
})

// Numbers the drafts as one terminal's items, a half minute apart, the last just now.
const written = (terminalId: string, now: number, drafts: readonly DemoDraft[]): ChatItem[] =>
  drafts.map((draft, index) => ({
    id: `${terminalId}:${index + 1}`,
    at: now - (drafts.length - index) * 30_000,
    role: draft.role,
    kind: draft.kind,
    text: draft.text,
    truncated: draft.truncated ?? false,
    tool: draft.tool ?? null,
    call: draft.call ?? null,
    author: draft.author ?? null,
  }))

// A file as Claude Code's Read returns it, a numbered line to each.
const numbered = (lines: readonly string[]): string =>
  lines.map((line, index) => `${String(index + 1).padStart(6)}→${line}`).join("\n")

const cartFields = ["subtotal", "tax", "shipping", "discount", "total", "itemCount", "weight"]
const cartSource = numbered([
  `import { useSyncExternalStore } from "react"`,
  ``,
  `import { cartStore, type Cart } from "./cart-store"`,
  ``,
  ...cartFields.flatMap((field) => [
    `// The cart's ${field}, in cents, recomputed whenever a line changes.`,
    `export const select${field[0]!.toUpperCase()}${field.slice(1)} = (cart: Cart): number =>`,
    `  cart.lines.reduce((sum, line) => sum + line.${field === "itemCount" ? "quantity" : "unitPrice * line.quantity"}, 0)`,
    ``,
  ]),
  `export const useCart = (): Cart =>`,
  `  useSyncExternalStore(cartStore.subscribe, cartStore.getSnapshot)`,
])

const plan = `## Checkout flow

The cart lives in \`useCart\` and is already a store, so checkout can read it without new state. I'd build it in three steps:

1. **Cart summary** in \`src/cart/CartSummary.tsx\`: lines, quantity steppers, the running total.
2. **Address form** with the fields the shipping API needs:
   - name and phone
   - street, city, postcode, country
   - a "billing is the same" toggle
3. **Payment step**, behind a provider interface so the choice stays open.

Totals should come from one function, not each screen:

\`\`\`ts
export const orderTotal = (cart: Cart, shipping: number): number =>
  selectSubtotal(cart) + selectTax(cart) + shipping - selectDiscount(cart)
\`\`\`

Open question: do we need guest checkout? See [the payments notes](https://docs.example.com/payments#guest) for what each provider allows.`

// The agents demo's transcripts, by terminal: Claude Code waiting on a plan, Codex on a
// permission, Claude Code with subagents running, and one whose turn is over.
export const agentTranscripts = (now: number): Readonly<Record<string, DemoTranscript>> => ({
  "01": {
    items: written("01", now, [
      user(
        "Plan the checkout flow for the storefront: cart summary, address form and a payment step. Don't write code yet.",
      ),
      say("I'll start by finding how the cart is used today."),
      use("toolu_01a", "Grep", {
        pattern: "useCart",
        path: "src",
        output_mode: "files_with_matches",
      }),
      got("toolu_01a", "src/cart/use-cart.ts\nsrc/cart/CartSummary.tsx\nsrc/routes/cart.tsx"),
      use("toolu_01b", "Read", {
        file_path: "/Users/alex/projects/storefront/src/cart/use-cart.ts",
      }),
      got("toolu_01b", cartSource, true),
      use("toolu_01c", "Task", {
        description: "Survey payment providers",
        subagent_type: "Explore",
        prompt:
          "Compare Stripe, Adyen and Mollie for a small EU storefront: guest checkout, SCA support, webhook model. Report in under 150 words.",
      }),
      got(
        "toolu_01c",
        "Stripe and Mollie both support guest checkout and handle SCA through their hosted fields; Adyen needs a separate drop-in component. All three confirm payments by signed webhook, so the order should be marked paid only from the webhook, never from the browser redirect.",
      ),
      say(plan),
      use("toolu_01d", "ExitPlanMode", { plan }),
    ]),
    requests: [
      {
        id: "01:plan",
        kind: "plan",
        tool: "ExitPlanMode",
        subject: "Checkout flow",
        choices: [
          "Yes, and auto-accept edits",
          "Yes, and manually approve edits",
          "No, keep planning",
        ],
        subagent: false,
        answered: false,
        dialog: {
          type: "choices",
          id: "01:d",
          detail:
            "Checkout flow\n1. Cart summary in src/cart/CartSummary.tsx\n2. Address form\n3. Payment step, behind a provider interface",
          title: "Claude has written up a plan and is ready to execute. Would you like to proceed?",
          options: [
            { id: "1", label: "Yes, and auto-accept edits", text: null },
            { id: "2", label: "Yes, and manually approve edits", text: null },
            { id: "3", label: "No, and tell Claude what to change", text: "field" },
          ],
        },
      },
    ],
    outcomes: {
      "01:plan": (answer) =>
        answer.type === "choice" && answer.option === "3"
          ? {
              items: [
                got(
                  "toolu_01d",
                  `The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said:\n${answer.text ?? ""}`,
                ),
              ],
              reply: `Understood. I'll revise the plan: ${answer.text ?? "your notes"}`,
            }
          : {
              items: [got("toolu_01d", "User has approved your plan. You can now start coding.")],
              reply: "Starting with the cart summary in `src/cart/CartSummary.tsx`.",
            },
    },
  },
  "03": {
    items: written("03", now, [
      user("Run the whole test suite and look into anything flaky."),
      say(
        "Starting the suite in the background, and sending two agents to look at the slowest files.",
      ),
      use("toolu_03a", "Bash", {
        command: "pnpm test",
        description: "Run the full test suite",
        run_in_background: true,
      }),
      got(
        "toolu_03a",
        "Command running in background with ID: b7k2xq9. Output is being written to: /tmp/claude/tasks/b7k2xq9.output",
      ),
      use("toolu_03x", "mcp__plugin_novadeck_novadeck__agents", {}),
      got("toolu_03x", "t1 claude (this terminal)\nt2 codex: Review the checkout change"),
      use("toolu_03y", "mcp__plugin_novadeck_novadeck__send", {
        to: "t2",
        text: "The suite is running here. Hold your checkout tests until it ends.",
      }),
      got("toolu_03y", "Sent to t2."),
      use("toolu_03b", "Task", {
        description: "Find flaky tests in cart specs",
        subagent_type: "general-purpose",
        prompt: "Run src/cart specs five times and report which ones fail or time out.",
      }),
      use("toolu_03c", "Task", {
        description: "Find flaky tests in checkout specs",
        subagent_type: "general-purpose",
        prompt: "Run src/checkout specs five times and report which ones fail or time out.",
      }),
    ]),
    // A dialog the chat can't read, as after an agent update changed it.
    requests: [
      {
        id: "03:raw",
        kind: "permission",
        tool: "Bash",
        subject: "pnpm test --filter cart --repeat 5",
        choices: [],
        subagent: true,
        answered: false,
        dialog: {
          type: "raw",
          reason: "unrecognized",
          text: [
            "╭──────────────────────────────────────────────────────────╮",
            "│ Bash command                                             │",
            "│                                                          │",
            "│   pnpm test --filter cart --repeat 5                     │",
            "│   Run the cart specs five times                          │",
            "│                                                          │",
            "│ Allow this command?                                      │",
            "│                                                          │",
            "│ ❯ [a] Allow once                                         │",
            "│   [s] Allow for this session                             │",
            "│   [d] Deny                                               │",
            "╰──────────────────────────────────────────────────────────╯",
          ].join("\n"),
        },
      },
    ],
  },
  "04": {
    items: written("04", now, [
      user("Review the checkout change on this branch for bugs, and fix what you find."),
      say("I'll read the diff first, then have two explorers check the call sites."),
      use("call_04a", "exec_command", {
        cmd: "git diff main...HEAD --stat",
        workdir: "/Users/alex/projects/novadeck",
        yield_time_ms: 1000,
      }),
      got(
        "call_04a",
        "Chunk ID: 8f2c1d\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 41\nOutput:\n src/checkout/total.ts    | 14 +++++++-------\n src/checkout/address.ts  | 32 ++++++++++++++++++++++++++++++++\n 2 files changed, 39 insertions(+), 7 deletions(-)\n",
      ),
      use("call_04n", "mcp__novadeck__open_terminal", {
        agent: "claude",
        message: "Check that the export job still rounds cents the old way.",
      }),
      got("call_04n", "Opened a new terminal t3."),
      use("call_04b", "update_plan", {
        plan: [
          { step: "Read the diff", status: "completed" },
          { step: "Check call sites of computeTotal", status: "in_progress" },
          { step: "Fix and run the checkout tests", status: "pending" },
        ],
      }),
      got("call_04b", "Plan updated"),
      from(
        "/root/explorer_1",
        "computeTotal is called from CartSummary, the order email and the export job. Only the export job still passes cents as a float.",
      ),
      from("/root/explorer_2", "No other caller depends on the old rounding."),
      use(
        "call_04c",
        "apply_patch",
        "*** Begin Patch\n*** Update File: src/checkout/total.ts\n@@ export const computeTotal = (cart: Cart): number => {\n-  return cart.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0) * 1.2\n+  return Math.round(cart.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0) * 1.2)\n }\n*** End Patch",
      ),
      got("call_04c", "Success. Updated the following files:\nM src/checkout/total.ts\n"),
      say("The total was a float in cents. I rounded it and I'm running the checkout tests next."),
      use("call_04d", "exec_command", {
        cmd: "pnpm test --filter checkout",
        workdir: "/Users/alex/projects/novadeck",
        yield_time_ms: 10000,
      }),
    ]),
    requests: [
      {
        id: "04:permission",
        kind: "permission",
        tool: "exec_command",
        subject: "pnpm test --filter checkout",
        choices: [
          "Yes, proceed",
          "Yes, and don't ask again for commands that start with `pnpm test`",
          "No, and tell Codex what to do differently",
        ],
        subagent: false,
        answered: false,
        dialog: {
          type: "choices",
          id: "04:d",
          detail: "pnpm test --filter checkout",
          title: "Would you like to run the following command?",
          options: [
            { id: "1", label: "Yes, proceed", text: null },
            {
              id: "2",
              label: "Yes, and don't ask again for commands that start with `pnpm test`",
              text: null,
            },
            { id: "3", label: "No, and tell Codex what to do differently", text: "prompt" },
          ],
        },
      },
    ],
    outcomes: {
      "04:permission": (answer) =>
        answer.type === "choice" && answer.option === "3"
          ? {
              items: [got("call_04d", "aborted by user")],
              prompt: answer.text ?? "Don't run that.",
            }
          : {
              items: [
                got(
                  "call_04d",
                  "Chunk ID: 5d1e90\nWall time: 4.2100 seconds\nProcess exited with code 0\nOutput:\n Test Files  3 passed (3)\n      Tests  41 passed (41)\n",
                ),
              ],
              reply: "The checkout tests pass with the rounding fix. Nothing else needs changing.",
            },
    },
  },
  "05": {
    items: written("05", now, [
      user("Why does the runtime log every request twice? Find it and fix it."),
      use("step:1a", "call_mcp_tool", {
        ServerName: JSON.stringify("novadeck_novadeck"),
        ToolName: JSON.stringify("send"),
        Arguments: { to: "t1", text: "Looking into the double logging now." },
        toolSummary: JSON.stringify("Tell t1 what I'm doing"),
        toolAction: JSON.stringify("Calling send"),
      }),
      got("step:1a", "Sent to t1."),
      use("step:1b", "mcp_novadeck_novadeck_describe", {
        title: "Request logging",
        summary: "Finds why the runtime logs every request twice.",
        toolSummary: JSON.stringify("Title this terminal"),
      }),
      got("step:1b", "Titled."),
      say("Before I dig in, I'll close the idle terminal and check what is on show."),
      use("step:1c", "call_mcp_tool", {
        ServerName: JSON.stringify("novadeck_novadeck"),
        ToolName: JSON.stringify("close_terminal"),
        Arguments: { to: "t3" },
        toolSummary: JSON.stringify("Close the idle terminal"),
        toolAction: JSON.stringify("Calling close_terminal"),
      }),
      got("step:1c", "Closed t3."),
      use("step:1d", "mcp_novadeck_novadeck_showing", {
        toolSummary: JSON.stringify("See what is shown"),
      }),
      got("step:1d", "Nothing is shown beside this terminal."),
      use("step:1e", "call_mcp_tool", {
        ServerName: JSON.stringify("deploy"),
        ToolName: JSON.stringify("list_targets"),
        Arguments: {},
        toolSummary: JSON.stringify("List the deploy targets"),
        toolAction: JSON.stringify("Calling list_targets"),
      }),
      got("step:1e", "staging\nproduction"),
      say("I'll search for where the request logger is registered."),
      use("step:2", "run_command", {
        CommandLine: JSON.stringify("grep -rn requestLogger src/runtime"),
        Cwd: JSON.stringify("/Users/alex/projects/novadeck/runtime"),
        SafeToAutoRun: "true",
        toolAction: JSON.stringify("Searching for the request logger"),
      }),
      got(
        "step:2",
        "Exit code: 0\nOutput:\nsrc/runtime/server.ts:18:  app.use(requestLogger)\nsrc/runtime/routes.ts:4:  router.use(requestLogger)\n",
      ),
      use("step:3", "view_file", {
        AbsolutePath: JSON.stringify("/Users/alex/projects/novadeck/runtime/src/runtime/routes.ts"),
        toolAction: JSON.stringify("Viewing routes.ts"),
        toolSummary: JSON.stringify("Check the router's middleware"),
      }),
      got(
        "step:3",
        'File Path: `file:///Users/alex/projects/novadeck/runtime/src/runtime/routes.ts`\nTotal Lines: 6\nShowing lines 1 to 6\n1: import { Router } from "express"\n2: import { requestLogger } from "./log"\n3: export const router = Router()\n4: router.use(requestLogger)\n5: router.get("/health", health)\n6: router.get("/jobs", jobs)\n',
      ),
      say(
        "The router registers `requestLogger` again after the app already did. I'll remove the router's copy.",
      ),
      use("step:6", "replace_file_content", {
        TargetFile: JSON.stringify("/Users/alex/projects/novadeck/runtime/src/runtime/routes.ts"),
        TargetContent: JSON.stringify("router.use(requestLogger)\n"),
        ReplacementContent: JSON.stringify(""),
        Description: JSON.stringify("Remove the duplicate logger"),
        toolAction: JSON.stringify("Editing routes.ts"),
      }),
      got(
        "step:6",
        "The following changes were made by the replace_file_content tool to: /Users/alex/projects/novadeck/runtime/src/runtime/routes.ts",
      ),
      use("step:7", "write_to_file", {
        TargetFile: JSON.stringify("/Users/alex/projects/novadeck/runtime/notes/logging.md"),
        CodeContent: JSON.stringify(
          "# Request logging\n\nThe logger is registered once, in `server.ts`.\n",
        ),
        Overwrite: "true",
        Description: JSON.stringify("Note where logging lives"),
        toolAction: JSON.stringify("Creating logging.md"),
      }),
      got(
        "step:7",
        "Created file file:///Users/alex/projects/novadeck/runtime/notes/logging.md with requested content.",
      ),
      say(
        "Fixed: each request is now logged once. I removed the duplicate `router.use(requestLogger)` from `routes.ts` and noted where logging lives in `notes/logging.md`.",
      ),
      use("step:8", "ask_question", {
        questions: [
          {
            question: "Which checks should run before each deploy?",
            options: ["Unit tests", "Type check", "Lint", "End-to-end tests"],
            is_multi_select: true,
          },
          {
            question: "Where should the logging note live?",
            options: ["notes/logging.md", "The README"],
            is_multi_select: false,
          },
        ],
      }),
    ]),
    // Antigravity says nothing of what it waits on; its question is read from its screen.
    requests: [
      {
        id: "05:question",
        kind: "question",
        tool: "ask_question",
        subject: null,
        choices: [],
        subagent: false,
        answered: false,
        dialog: {
          type: "questions",
          id: "05:d",
          chat: "prompt",
          questions: [
            {
              id: "checks",
              header: "Checks",
              question: "Which checks should run before each deploy?",
              options: [
                { id: "unit", label: "Unit tests", description: "Fast, runs in a few seconds" },
                { id: "types", label: "Type check", description: null },
                { id: "lint", label: "Lint", description: null },
                {
                  id: "e2e",
                  label: "End-to-end tests",
                  description: "Drives a real browser and takes a few minutes",
                },
              ],
              multiSelect: true,
              text: true,
            },
            {
              id: "note",
              header: "Note",
              question: "Where should the logging note live?",
              options: [
                { id: "file", label: "notes/logging.md", description: null },
                { id: "readme", label: "The README", description: null },
              ],
              multiSelect: false,
              text: true,
            },
          ],
        },
      },
    ],
    outcomes: {
      "05:question": (answer, dialog) => {
        if (answer.type === "chat")
          return answer.text
            ? {
                items: [got("step:8", "The user chose to chat about the questions instead.")],
                prompt: answer.text,
              }
            : {
                items: [got("step:8", "The user chose to chat about the questions instead.")],
                waits: true,
              }
        const labels = new Map(
          dialog.type === "questions"
            ? dialog.questions.flatMap((q) => q.options.map((o) => [o.id, o.label] as const))
            : [],
        )
        const said =
          answer.type === "questions"
            ? answer.answers
                .map((each) =>
                  [
                    ...each.options.map((id) => labels.get(id) ?? id),
                    ...(each.text ? [each.text] : []),
                  ].join(", "),
                )
                .join("; ")
            : ""
        return {
          items: [got("step:8", `User answered: ${said}`)],
          reply: `Noted: ${said}. I'll set the deploy up that way.`,
        }
      },
    },
  },
  "06": {
    items: written("06", now, [
      user("Build the app and tell me how big the bundle is."),
      use("toolu_06a", "Bash", {
        command: "pnpm build",
        description: "Build the app",
      }),
      got(
        "toolu_06a",
        'Exit code 1\n> vite build\n\nsrc/checkout/total.ts (4:22): "selectShipping" is not exported by "src/cart/use-cart.ts"\nerror during build:\nRollupError: "selectShipping" is not exported by "src/cart/use-cart.ts"',
      ),
      say("The build breaks on a missing export. I'll fix the import."),
      use("toolu_06b", "Edit", {
        file_path: "/Users/alex/projects/novadeck/src/checkout/total.ts",
        old_string: 'import { selectShipping } from "../cart/use-cart"',
        new_string: 'import { selectShipping } from "../cart/selectors"',
      }),
      got(
        "toolu_06b",
        "The file /Users/alex/projects/novadeck/src/checkout/total.ts has been updated.",
      ),
      use("toolu_06c", "Bash", {
        command: "pnpm build",
        description: "Build the app again",
      }),
      got(
        "toolu_06c",
        "> vite build\n\ndist/index.html                 0.52 kB\ndist/assets/index-4f3a1c.css  18.40 kB\ndist/assets/index-9b2e77.js  214.06 kB │ gzip: 68.12 kB\n✓ built in 2.31s",
      ),
      use("toolu_06d", "Bash", {
        command: "pnpm preview",
        description: "Serve the build to check it loads",
        run_in_background: true,
      }),
      got("toolu_06d", "Command running in background with ID: p4m8c1d."),
      say(
        "## Build\n\nIt passes now. The failure was an import from the wrong module, fixed in `src/checkout/total.ts`.\n\n| Asset | Size |\n| --- | --- |\n| JavaScript | 214 kB (68 kB gzip) |\n| CSS | 18 kB |\n\nI left `pnpm preview` running in the background so you can open it at <http://localhost:4173>.",
      ),
      use("toolu_06e", "mcp__deploy__configure_target", {
        message: "Configure the deploy target",
      }),
    ]),
    // An MCP server asks for a form.
    requests: [
      {
        id: "06:form",
        kind: "question",
        tool: "mcp__deploy__configure_target",
        subject: null,
        choices: [],
        subagent: false,
        answered: false,
        dialog: {
          type: "form",
          id: "06:d",
          message: "Configure the deploy target",
          fields: [
            {
              id: "target",
              label: "Target name",
              description: "As it is named in the deploy config",
              kind: "text",
              choices: [],
              required: true,
            },
            {
              id: "environment",
              label: "Environment",
              description: null,
              kind: "choice",
              choices: ["staging", "production"],
              required: true,
            },
            {
              id: "replicas",
              label: "Replicas",
              description: null,
              kind: "number",
              choices: [],
              required: false,
            },
            {
              id: "dryRun",
              label: "Dry run first",
              description: "Shows what would change without deploying",
              kind: "boolean",
              choices: [],
              required: false,
            },
          ],
        },
      },
    ],
    outcomes: {
      "06:form": (answer) =>
        answer.type === "form" && answer.action === "accept"
          ? {
              items: [got("toolu_06e", `User accepted: ${JSON.stringify(answer.values)}`)],
              reply: `Deploying ${String(answer.values.target ?? "the target")} to ${String(answer.values.environment ?? "staging")}.`,
            }
          : {
              items: [got("toolu_06e", "User declined to provide the configuration.")],
              reply: "Understood, I won't deploy. Tell me when you want to try again.",
            },
    },
  },
})

// The content preview's transcripts: its two agents, each at the plan it just wrote.
export const showcaseTranscripts = (now: number): Readonly<Record<string, DemoTranscript>> => ({
  "01": {
    items: written("01", now, [
      user("Plan a small portfolio for Studio before we start building."),
      say("I'll look at the project first."),
      use("call_s1a", "exec_command", {
        cmd: "ls",
        workdir: "/Users/alex/projects/studio",
      }),
      got(
        "call_s1a",
        "Chunk ID: 1c7e0b\nWall time: 0.0000 seconds\nProcess exited with code 0\nOutput:\npackage.json\npages\nplans\nsrc\n",
      ),
      use(
        "call_s1b",
        "apply_patch",
        "*** Begin Patch\n*** Add File: plans/studio.md\n+# Studio portfolio\n+\n+1. [ ] Set the visual direction.\n+2. [ ] Build the home page.\n*** End Patch",
      ),
      got("call_s1b", "Success. Updated the following files:\nA plans/studio.md\n"),
      say(
        "The plan is ready in `plans/studio.md`. Approve it to start, or tell me what to change.",
      ),
    ]),
    requests: [],
  },
  "03": {
    items: written("03", now, [
      user("Why does the mobile app log people out early? Plan a fix first."),
      use("toolu_s3a", "Read", {
        file_path: "/Users/alex/projects/studio/server/auth.ts",
      }),
      got(
        "toolu_s3a",
        numbered([
          `export const isExpired = (token: Token): boolean => token.expiresAt < Date.now()`,
          ``,
          `export const refresh = async (token: Token): Promise<Token> => {`,
          `  if (isExpired(token)) throw new Error("expired")`,
          `  return issue(token.user)`,
          `}`,
        ]),
      ),
      use("toolu_s3b", "Grep", {
        pattern: "expiresAt",
        path: "server",
        output_mode: "content",
      }),
      got(
        "toolu_s3b",
        "server/auth.ts:1:export const isExpired = ...\nserver/routes/session.ts:14:  if (token.expiresAt - 60_000 < now) return reject()\nserver/routes/admin.ts:9:  if (now > token.expiresAt + 86_400_000) return reject()",
      ),
      say(
        "Expiry is checked three different ways: strictly, with a minute of slack, and with a day of grace on admin routes. I've written a plan to consolidate it in `~/.claude/plans/refactor-auth.md`.",
      ),
    ]),
    requests: [],
  },
})
