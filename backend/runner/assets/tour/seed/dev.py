"""The game's dev server: python3 dev.py [port]

It serves this folder, with the work of every git worktree of this repo laid over it: a file
that a worktree changed (or added) is served from that worktree, the newest change first. So
the page shows everyone's work at once, before any of it is merged. The page reloads by itself
when a file changes. (dev.mjs is the same server for Node.)
"""

import os
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5180
HOME = os.getcwd()
TYPES = {
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
SKIPPED = {".git", "vendor", "node_modules"}
HOSTS = {"127.0.0.1:" + str(PORT), "localhost:" + str(PORT)}
RELOAD = b"""<script>
  // Added by dev.py: reload when a file changes.
  let seen
  setInterval(async () => {
    const now = await fetch("/__version").then((answer) => answer.text(), () => seen)
    if (seen !== undefined && now !== seen) location.reload()
    seen = now
  }, 700)
</script>"""


def worktrees():
    """The other worktrees of this repo, as git lists them; none without git."""
    try:
        listed = subprocess.run(
            ["git", "worktree", "list", "--porcelain"], cwd=HOME, capture_output=True, text=True
        ).stdout
    except OSError:
        return []
    folders = [line[9:] for line in listed.splitlines() if line.startswith("worktree ")]
    return [f for f in map(os.path.normpath, folders) if f != os.path.normpath(HOME) and os.path.isdir(f)]


def read(file):
    try:
        with open(file, "rb") as opened:
            return opened.read()
    except OSError:
        return None


def changed_at(file):
    """When a file last changed; 0 for one that is gone meanwhile."""
    try:
        return os.path.getmtime(file)
    except OSError:
        return 0.0


def parts_of(route):
    """The path a request names, inside the project: its parts, with none that leaves the
    folder or names a hidden file (.git and the like), a drive or a device. None for any other."""
    parts = [part for part in re.split(r"[/\\]+", route) if part]
    for part in parts:
        if part.startswith(".") or ":" in part or "\0" in part:
            return None
    return parts or ["index.html"]


def pick(path):
    """The file to serve for a path: a worktree's copy where it differs from this folder's
    (the newest such copy), else this folder's own."""
    own = os.path.join(HOME, path)
    base = read(own)
    changed = []
    if path.split(os.sep)[0] != "vendor":
        for folder in worktrees():
            file = os.path.join(folder, path)
            copy = read(file)
            if copy is not None and copy != base:
                changed.append(file)
    changed.sort(key=changed_at, reverse=True)
    return changed[0] if changed else (own if base is not None else None)


def version():
    """When anything the page could show last changed, in any worktree."""
    latest = 0.0
    for root in [HOME, *worktrees()]:
        for folder, folders, files in os.walk(root):
            folders[:] = [n for n in folders if n not in SKIPPED and not n.startswith(".")]
            for name in files:
                if not name.startswith("."):
                    latest = max(latest, changed_at(os.path.join(folder, name)))
    return str(latest)


class Handler(BaseHTTPRequestHandler):
    def send(self, status, kind, body):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            self.answer()
        except Exception as error:  # A file that went away meanwhile, say: the server stays.
            self.send(500, "text/plain", ("The dev server couldn't answer that: " + str(error)).encode())

    def answer(self):
        # Only this computer's own pages may ask: a request under another host name is some
        # other site's page reaching for this server, and is refused.
        if self.headers.get("Host") not in HOSTS:
            return self.send(403, "text/plain", b"No.")
        try:
            route = unquote(urlsplit(self.path).path, errors="strict")
        except ValueError:
            return self.send(404, "text/plain", b"Not found.")
        if route == "/__version":
            return self.send(200, "text/plain", version().encode())
        parts = parts_of(route)
        if parts is None:
            return self.send(404, "text/plain", b"Not found.")
        file = pick(os.path.join(*parts))
        if file is None:
            return self.send(404, "text/plain", ("Not found: " + "/".join(parts)).encode())
        kind = TYPES.get(os.path.splitext(file)[1], "application/octet-stream")
        body = read(file)
        if body is None:
            return self.send(404, "text/plain", ("Not found: " + "/".join(parts)).encode())
        if kind.startswith("text/html"):
            body = body.replace(b"</body>", RELOAD + b"</body>")
        self.send(200, kind, body)
        print("GET", route, "" if file.startswith(HOME) else "  <- " + file, flush=True)

    def log_message(self, *args):
        pass


print(f"The game is at http://127.0.0.1:{PORT}/", flush=True)
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
