import type { ChangesContent } from "@novadeck/core/items"
import type { Work } from "@novadeck/core/works"

import { ready, type SampleArtifact } from "./artifacts"
import { contentOf, diffOf, rangeOf, type Files, type History, type Step } from "./history"

// What the dev server's terminal shows of an agent's whole change, in each shape the pane
// draws: an ordinary change in layers (commits since main and the work not committed yet),
// files renamed, deleted and added, a binary file, one that may hold secrets, a change past
// what the runner reads, and none. Each is a small history of file texts (./history.ts), so
// the layers, the counts and every file's diff come from the same lines.

const repo = "~/projects/studio"

// A module's address in a sample's code (one the repository's own tools read no import of).
const address = (path: string): string => `"@/${path}"`

/** The text of a file from its lines. */
export const text = (...lines: string[]): string => `${lines.join("\n")}\n`

const minutes = (ago: number): number => Date.now() - ago * 60_000

/** A hash-like id for a commit, from its first seven characters. */
const hash = (start: string): string => start.padEnd(40, "0")

export const sample = (
  id: string,
  name: string,
  history: Omit<History, "root" | "base"> & Partial<Pick<History, "root" | "base">>,
): SampleArtifact => {
  const whole: History = { root: `${repo}/${id}`, base: "main", ...history }
  const content = contentOf(whole)
  const files = new Set(content.layers.flatMap((layer) => layer.files.map((file) => file.path)))
  const added = content.layers.reduce((sum, layer) => sum + layer.added, 0)
  const removed = content.layers.reduce((sum, layer) => sum + layer.removed, 0)
  return {
    item: {
      id,
      kind: "changes",
      name,
      detail:
        files.size === 0
          ? "Against main"
          : `${files.size} ${files.size === 1 ? "file" : "files"} · +${added} −${removed}`,
      path: whole.root,
      url: null,
      lines: null,
      secret: false,
    },
    content: ready(content),
    changeFile: (path, layers) => diffOf(whole, path, layers),
    changeRange: (layers) => rangeOf(whole, layers),
  }
}

// ── The work of @owl's refactor of auth: a commit, a test commit, and an edit not committed ──

const cookies = (age: number) =>
  text(
    "const day = 24 * 60 * 60 * 1000",
    "",
    "// How long a session cookie lives.",
    `export const cookieMaxAge = ${age} * day`,
    "",
    "// The name the cookie travels under.",
    'export const cookieName = "session"',
    "",
    "export const sessionCookie = (value: string, maxAge: number) =>",
    '  [cookieName + "=" + value, "Max-Age=" + Math.floor(maxAge / 1000), "Path=/", "HttpOnly"].join("; ")',
  )

const session = text(
  `import { cookieMaxAge } from ${address("auth/cookies")}`,
  "",
  "export type Session = { userId: string; expiresAt: number }",
  "",
  "const day = 24 * 60 * 60 * 1000",
  "",
  "// One expiry rule for every route: good until expiresAt,",
  "// renewed by a request in its last day.",
  "export const verifySession = (session: Session | null, now = Date.now()) => {",
  '  if (!session) return { ok: false, reason: "missing" } as const',
  '  if (now >= session.expiresAt) return { ok: false, reason: "expired" } as const',
  "  const renew = session.expiresAt - now < day",
  "  return {",
  "    ok: true,",
  "    session: renew ? { ...session, expiresAt: now + cookieMaxAge } : session,",
  "  } as const",
  "}",
)

const sessionTest = (more: boolean) =>
  text(
    'import { describe, expect, it } from "vitest"',
    `import { verifySession } from ${address("auth/session")}`,
    "",
    'describe("verifySession", () => {',
    '  it("turns away an expired session", () => {',
    '    expect(verifySession({ userId: "u1", expiresAt: 10 }, 20).ok).toBe(false)',
    "  })",
    ...(more
      ? [
          '  it("keeps a month-old login on mobile", () => {',
          "    const now = Date.now()",
          '    expect(verifySession({ userId: "u1", expiresAt: now + 29 * 86_400_000 }, now).ok).toBe(true)',
          "  })",
        ]
      : []),
    "})",
  )

const header = (after: boolean) =>
  after
    ? text(
        `import { useSession } from ${address("auth/session")}`,
        "",
        "const DAY = 24 * 60 * 60 * 1000",
        "",
        "// The site's header, with its nav once there is a session.",
        "export const Header = () => {",
        "  const session = useSession()",
        "  return (",
        '    <header className="site-header">',
        "      {session.ok && (",
        "        <nav>",
        '          <a href="/work">Work</a>',
        '          <a href="/about">About</a>',
        "        </nav>",
        "      )}",
        "    </header>",
        "  )",
        "}",
        "",
        "export default Header",
      )
    : text(
        `import { signOut, useUser } from ${address("auth")}`,
        "",
        "const DAY = 24 * 60 * 60 * 1000",
        "",
        "// The site's header, with its nav once there is a session.",
        "export const Header = () => {",
        "  const user = useUser()",
        "  if (user && Date.now() - user.loginAt > 7 * DAY) {",
        "    signOut()",
        "    return null",
        "  }",
        "  return (",
        '    <header className="site-header">',
        "      <nav>",
        '        <a href="/work">Work</a>',
        '        <a href="/about">About</a>',
        "      </nav>",
        "    </header>",
        "  )",
        "}",
        "",
        "export default Header",
      )

const routes = (after: boolean) =>
  text(
    `import { HttpError, json } from ${address("server/http")}`,
    ...(after ? [`import { verifySession, type Session } from ${address("auth/session")}`] : []),
    `import { accounts, users } from ${address("server/store")}`,
    `import { checkPassword } from ${address("server/passwords")}`,
    "",
    "const DAY = 24 * 60 * 60 * 1000",
    "",
    ...(after
      ? [
          "const readSession = (req: Request): Session | null => {",
          '  const match = /session=([^;]+)/.exec(req.headers.get("cookie") ?? "")',
          "  return match ? JSON.parse(atob(match[1]!)) : null",
          "}",
          "",
          "export const requireUser = (req: Request) => {",
          "  const result = verifySession(readSession(req))",
          "  if (!result.ok) throw new HttpError(401, result.reason)",
          "  return result.session.userId",
          "}",
        ]
      : [
          "export const requireUser = (req: Request) => {",
          '  const raw = req.headers.get("cookie") ?? ""',
          "  const match = /session=([^;]+)/.exec(raw)",
          '  if (!match) throw new HttpError(401, "No session")',
          "  const session = JSON.parse(atob(match[1]))",
          "  const age = Date.now() - session.loginAt",
          '  if (age > 7 * DAY) throw new HttpError(401, "Expired")',
          "  return session.user",
          "}",
        ]),
    "",
    'router.get("/health", () => json({ ok: true }))',
    "",
    'router.get("/products", async () => json(await products.list()))',
    "",
    'router.get("/products/:id", async (req) => {',
    "  const product = await products.find(req.params.id)",
    '  if (!product) throw new HttpError(404, "No such product")',
    "  return json(product)",
    "})",
    "",
    'router.get("/account", async (req) => {',
    ...(after
      ? ["  const userId = requireUser(req)", "  return json(await accounts.find(userId))"]
      : ["  const user = requireUser(req)", "  return json(await accounts.find(user.id))"]),
    "})",
    "",
    'router.post("/cart", async (req) => {',
    "  requireUser(req)",
    "  const { productId, quantity } = await req.json()",
    "  return json(await cart.add(productId, quantity))",
    "})",
    "",
    'router.post("/logout", () => json({ ok: true }, 200, { "set-cookie": "session=; Max-Age=0" }))',
    "",
    'router.post("/login", async (req) => {',
    ...(after
      ? [
          "  const { email, password, device } = await req.json()",
          "  const user = await users.byEmail(email)",
          "  if (!user || !(await checkPassword(user, password)))",
          '    return json({ error: "Wrong email or password" }, 401)',
          "  const session = startSession(user.id, Date.now(), device)",
          "  await audit.record({ kind: 'login', userId: user.id, device })",
          "  await users.touch(user.id, session.expiresAt)",
          "  if (device?.trusted) await devices.remember(user.id, device.id)",
          "  else await devices.forget(user.id, device?.id)",
          "  const welcome = await accounts.find(user.id)",
          "  const cart = await carts.merge(user.id, req.headers.get('x-cart') ?? null)",
          "  const notices = await inbox.unread(user.id)",
          "  const offers = await offers.forAccount(welcome)",
          "  const redirect = new URL(req.url).searchParams.get('next') ?? '/'",
          "  const safe = redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/'",
          "  const body = { ok: true, next: safe, cart: cart.count, notices: notices.length, offers }",
          "  const headers = {",
          '    "set-cookie": sessionCookie(session, cookieMaxAge),',
          '    "cache-control": "no-store",',
          "  }",
          "  metrics.count('login', { device: device?.kind ?? 'unknown' })",
          "  logger.info('login', { userId: user.id, next: safe })",
          "  return json(body, 200, headers)",
        ]
      : [
          "  const body = await req.json()",
          "  const user = await users.byEmail(body.email)",
          "  if (!user || !(await checkPassword(user, body.password))) {",
          '    return json({ error: "Wrong email or password" }, 401)',
          "  }",
          "  const session = startSession(user.id, Date.now())",
          "  await audit.record({ kind: 'login', userId: user.id })",
          "  await users.touch(user.id, session.expiresAt)",
          "  const welcome = await accounts.find(user.id)",
          "  const cart = await carts.merge(user.id, req.headers.get('x-cart') ?? null)",
          "  const notices = await inbox.unread(user.id)",
          "  const redirect = new URL(req.url).searchParams.get('next') ?? '/'",
          "  const body2 = { ok: true, next: redirect, cart: cart.count, notices: notices.length }",
          "  void welcome",
          "  return json(body2, 200, { 'set-cookie': sessionCookie(session, 7 * DAY) })",
        ]),
    "})",
    "",
    'router.get("/orders", async (req) => {',
    "  const userId = requireUser(req)",
    "  return json(await orders.forAccount(userId))",
    "})",
    ...(after
      ? [
          "",
          "export const refreshSession = (req: Request) => {",
          "  const result = verifySession(readSession(req))",
          "  if (!result.ok) return null",
          "  return sessionCookie(result.session, cookieMaxAge)",
          "}",
        ]
      : []),
  )

const authStart: Files = {
  "src/auth/cookies.ts": cookies(7),
  "src/components/Header.tsx": header(false),
  "src/server/routes.ts": routes(false),
  "README.md": text("# Studio", "", "## Debug panel", "", "Open it from the footer.", ""),
}

const authSteps: Step[] = [
  {
    id: hash("a1c3f9e"),
    subject: "Check session expiry in one place",
    time: minutes(78),
    set: {
      "src/auth/session.ts": session,
      "src/components/Header.tsx": header(true),
      "src/server/routes.ts": routes(true),
    },
  },
  {
    id: hash("7d02b4a"),
    subject: "Test verifySession across routes",
    time: minutes(41),
    set: { "src/auth/session.test.ts": sessionTest(false) },
  },
  {
    id: "uncommitted",
    subject: "",
    time: null,
    set: {
      "src/auth/cookies.ts": cookies(30),
      "src/auth/session.test.ts": sessionTest(true),
      "README.md": text(
        "# Studio",
        "",
        "## Debug panel",
        "",
        "Open it from the footer: Debug.",
        "",
      ),
    },
  },
]

// ── The other shapes ─────────────────────────────────────────────────────────────────

const styles = (sticky: boolean) =>
  text(
    ".site-header {",
    "  display: flex;",
    ...(sticky ? ["  position: sticky;", "  top: 0;", "  background: var(--ivory);"] : []),
    "}",
  )

const readme = text("# Studio", "", "An independent design practice's site.")

const credits = (long: boolean) =>
  text(
    "{",
    '  "credits": [',
    long
      ? '    "Wayfinding with Hollis & Reyes Architects; signage fabricated by Northfield Metalworks; photography by Ana Lindqvist; additional illustration by the studio team over two seasons of site visits, with thanks to the neighbours who let us measure their doors.",'
      : '    "Wayfinding with Hollis & Reyes Architects.",',
    '    "Typeset in Archivo."',
    "  ]",
    "}",
  )

const generated = (index: number) =>
  text(...Array.from({ length: 2_000 }, (_, at) => `{ "part": ${index}, "row": ${at} }`))

export const changesArtifacts: readonly SampleArtifact[] = [
  sample("change", "Changes", {
    start: authStart,
    steps: authSteps,
  }),
  sample("change-moves", "Renamed, deleted and added", {
    start: {
      "src/pages/Projects.tsx": text("export const Projects = () => null"),
      "src/legacy.js": text("// Old build script", "module.exports = {}"),
      "src/pages/About.tsx": text("export const About = () => null"),
    },
    steps: [
      {
        id: hash("5c0de11"),
        subject: "Rename the pages, drop the legacy build script",
        time: minutes(30),
        move: {
          "src/pages/Work.tsx": "src/pages/Projects.tsx",
          "src/pages/Studio.tsx": "src/pages/About.tsx",
        },
        set: { "src/pages/Work.tsx": text("export const Work = () => null"), "README.md": readme },
        remove: ["src/legacy.js"],
      },
    ],
  }),
  sample("change-long", "A change with long lines", {
    start: { "src/content/credits.json": credits(false), "src/styles/site.css": styles(false) },
    steps: [
      {
        id: "uncommitted",
        subject: "",
        time: null,
        set: { "src/content/credits.json": credits(true), "src/styles/site.css": styles(true) },
      },
    ],
  }),
  sample("change-binary", "A binary file", {
    start: { "src/styles/site.css": styles(false), "public/logo.png": "" },
    steps: [
      {
        id: "uncommitted",
        subject: "",
        time: null,
        set: { "src/styles/site.css": styles(true), "public/logo.png": "changed" },
        binary: ["public/logo.png"],
      },
    ],
  }),
  sample("change-held", "A file that may hold secrets", {
    start: { "src/styles/site.css": styles(false) },
    steps: [
      {
        id: "uncommitted",
        subject: "",
        time: null,
        set: {
          "src/styles/site.css": styles(true),
          ".env.local": text("API_KEY=held", "REGION=eu"),
        },
        held: [".env.local"],
      },
    ],
  }),
  sample("change-truncated", "A change past what is shown", {
    start: { "src/components/Header.tsx": header(false) },
    steps: [
      {
        id: "uncommitted",
        subject: "",
        time: null,
        set: {
          "src/components/Header.tsx": header(true),
          "src/generated/part-1.json": generated(1),
          "src/generated/part-2.json": generated(2),
          "src/generated/part-3.json": generated(3),
        },
      },
    ],
    big: ["src/generated/part-1.json", "src/generated/part-2.json", "src/generated/part-3.json"],
    truncated: true,
  }),
  sample("change-old-git", "A merge against its first parent", {
    start: { "src/pages/Home.tsx": text("export const Home = () => null") },
    steps: [
      {
        id: hash("0a1b2c3"),
        subject: "Add the footer",
        time: minutes(90),
        set: { "src/components/Footer.tsx": text("export const Footer = () => null") },
      },
      {
        id: hash("4d5e6f7"),
        subject: "Merge branch 'main' into feature",
        time: minutes(40),
        set: { "src/pages/Contact.tsx": text("export const Contact = () => null") },
        firstParent: true,
      },
    ],
  }),
  sample("change-none", "No changes", {
    start: { "README.md": readme },
    steps: [{ id: "uncommitted", subject: "", time: null }],
  }),
]

/** A change's content, for specs that only want its layers. */
export const contentOfSample = (artifact: SampleArtifact): ChangesContent | undefined =>
  artifact.content.state === "ready" && artifact.content.content.kind === "changes"
    ? artifact.content.content
    : undefined

const stepLines = (path: string, kind: "before" | "after", count: number): string[] =>
  Array.from({ length: count }, (_, step) => `  // ${kind}, step ${step + 1} of ${path}`)
const frame = (path: string, middle: string[]): string =>
  text(`// ${path.split("/").at(-1)}`, "", ...middle, "", "export {}")

// The change a terminal's work shows as: its files, against main, as a layer of work not
// committed yet, each a few lines the demo invents (the counts are the work's own).
export const workChanges = (work: Work, title: string): SampleArtifact => {
  const before: Record<string, string> = {}
  const after: Record<string, string> = {}
  for (const each of work.files) {
    before[each.path] = frame(each.path, stepLines(each.path, "before", each.removed))
    after[each.path] = frame(each.path, stepLines(each.path, "after", each.added))
  }
  const count = `${work.files.length} ${work.files.length === 1 ? "file" : "files"}`
  const made = sample(`work-${work.terminalId}`, "Changes", {
    start: before,
    steps: [{ id: "uncommitted", subject: "", time: null, set: after }],
  })
  return {
    ...made,
    item: { ...made.item, detail: `${title} against ${work.base} · ${count}` },
    content:
      made.content.state === "ready" && made.content.content.kind === "changes"
        ? ready({ ...made.content.content, root: work.root, base: work.base })
        : made.content,
  }
}
