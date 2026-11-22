// The game's dev server: node dev.mjs [port]
//
// It serves this folder, with the work of every git worktree of this repo laid over it: a
// file that a worktree changed (or added) since it parted from this folder is served from
// that worktree, the newest change first. So the page shows everyone's work at once, before
// any of it is merged. The page reloads by itself when a file changes.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, join, normalize, sep } from "node:path"

const port = Number(process.argv[2] ?? 5180)
const home = process.cwd()
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
}

// The other worktrees of this repo, as git lists them; none without git.
const worktrees = () => {
  try {
    const listed = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: home })
    return String(listed)
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => normalize(line.slice(9)))
      .filter((folder) => folder !== normalize(home) && existsSync(folder))
  } catch {
    return []
  }
}

const read = (file) => {
  try {
    return statSync(file).isFile() ? readFileSync(file) : undefined
  } catch {
    return undefined
  }
}

// When a file last changed; 0 for one that is gone meanwhile.
const changedAt = (file) => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

// The path a request names, inside the project: its parts, with none that leaves the folder or
// names a hidden file (.git and the like), a drive or a device. Undefined for any other.
const partsOf = (pathname) => {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  const parts = decoded.split(/[/\\]+/).filter(Boolean)
  const fine = (part) => !part.startsWith(".") && !/[:\0]/.test(part)
  return parts.every(fine) ? (parts.length ? parts : ["index.html"]) : undefined
}

// Runs git in a folder: what it prints, or undefined where it fails (no git, no repo, no commit).
const git = (folder, ...args) => {
  try {
    return String(execFileSync("git", args, { cwd: folder, stdio: ["ignore", "pipe", "ignore"] }))
  } catch {
    return undefined
  }
}

// The files a folder changed since `base`: those that differ from that commit, and those git
// doesn't track yet. As git names them, from the top of the project, with "/" between parts.
const changedSince = (folder, base) => {
  const names = (printed) => (printed ?? "").split("\0").filter(Boolean)
  return new Set([
    ...names(git(folder, "diff", "--name-only", "-z", base)),
    ...names(git(folder, "ls-files", "--others", "--exclude-standard", "-z")),
  ])
}

// What each worktree changed since it parted from this folder (`theirs`), and what this
// folder changed since then (`ours`). They parted at the last commit both have; where they
// share none, a worktree's changes are those since its own last commit. A worktree's file that
// nobody touched there is not its work, however far this folder has moved on since.
const changes = () => {
  const head = git(home, "rev-parse", "HEAD")?.trim()
  return worktrees().map((folder) => {
    const base = (head && git(folder, "merge-base", "HEAD", head)?.trim()) || "HEAD"
    return { folder, theirs: changedSince(folder, base), ours: changedSince(home, base) }
  })
}

// The changes as of now: read again when a file changed anywhere, and every two seconds for
// what changes no file (a commit, a merge).
let kept
const current = () => {
  const now = version()
  if (!kept || kept.version !== now || Date.now() - kept.at > 2000)
    kept = { version: now, at: Date.now(), list: changes() }
  return kept.list
}

// The file to serve for a path: the copy of a worktree that changed it (the newest such copy,
// this folder's own among them where it changed the file too), else this folder's own.
const pick = (path) => {
  const own = join(home, path)
  const has = read(own) !== undefined
  if (path.startsWith("vendor" + sep)) return has ? own : undefined
  const name = path.split(sep).join("/")
  const changed = current().filter((each) => each.theirs.has(name))
  const copies = changed
    .map((each) => join(each.folder, path))
    .filter((file) => read(file) !== undefined)
  if (has && (copies.length === 0 || changed.some((each) => each.ours.has(name)))) copies.push(own)
  return copies.sort((a, b) => changedAt(b) - changedAt(a))[0]
}

// When anything the page could show last changed, in any worktree: the page asks, and reloads.
const skipped = new Set([".git", "vendor", "node_modules"])
const newest = (folder) => {
  let latest = 0
  let entries = []
  try {
    entries = readdirSync(folder, { withFileTypes: true })
  } catch {
    // Gone meanwhile, as a worktree that was just removed.
  }
  for (const entry of entries) {
    if (skipped.has(entry.name) || entry.name.startsWith(".")) continue
    const path = join(folder, entry.name)
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : changedAt(path))
  }
  return latest
}
const version = () => String(Math.max(...[home, ...worktrees()].map(newest)))

const reload = `<script>
  // Added by dev.mjs: reload when a file changes.
  let seen
  setInterval(async () => {
    const now = await fetch("/__version").then((answer) => answer.text(), () => seen)
    if (seen !== undefined && now !== seen) location.reload()
    seen = now
  }, 700)
</script>`

// Only this computer's own pages may ask: a request under another host name is some other
// site's page reaching for this server, and is refused.
const hosts = new Set(["127.0.0.1:" + port, "localhost:" + port])

createServer((request, response) => {
  const send = (status, type, body) => {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" })
    response.end(body)
  }
  try {
    if (!hosts.has(request.headers.host)) return send(403, "text/plain", "No.")
    const url = new URL(request.url, "http://localhost")
    if (url.pathname === "/__version") return send(200, "text/plain", version())
    const parts = partsOf(url.pathname)
    if (!parts) return send(404, "text/plain", "Not found.")
    const path = parts.join(sep)
    const file = pick(path)
    if (file === undefined) return send(404, "text/plain", "Not found: " + parts.join("/"))
    const type = types[extname(file)] ?? "application/octet-stream"
    const body = readFileSync(file)
    const html = type.startsWith("text/html")
    send(200, type, html ? String(body).replace("</body>", reload + "</body>") : body)
    console.log(request.method, url.pathname, file.startsWith(home) ? "" : "  <- " + file)
  } catch (error) {
    // A file that went away between the look and the read, say: this request fails, the
    // server stays.
    send(500, "text/plain", "The dev server couldn't answer that: " + error.message)
  }
}).listen(port, "127.0.0.1", () => console.log("The game is at http://127.0.0.1:" + port + "/"))
