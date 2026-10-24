import { describe, expect, it } from "../test.js"
import { endless } from "./waits.js"

describe("a command that may run for ever", () => {
  it.each([
    "pnpm dev",
    "pnpm run dev:web",
    "npm run dev",
    "npm start",
    "yarn serve",
    "bun run preview",
    "pnpm --filter web dev",
    "cd apps/web && pnpm dev 2>&1 | tee dev.log",
    "PORT=4000 npm run dev",
    "nohup pnpm dev > /tmp/dev.log 2>&1",
    "vite",
    "npx vite --port 3000",
    "./node_modules/.bin/vite preview",
    "next dev",
    "astro dev --host",
    "nuxt dev",
    "python3 -m http.server 8000",
    "python -u -m http.server",
    "uvicorn app:app --reload",
    "flask run",
    "rails server",
    "nodemon server.js",
    "tsc --watch",
    "tsc -w -p .",
    "vitest --watch",
    "pnpm test --watch",
    "jest --watchAll",
    "cargo watch -x test",
    "tail -f app.log",
    "tail -n 20 -F app.log",
    "docker compose up",
    "docker-compose up web",
    "ngrok http 3000",
    "php -S localhost:8000",
    "sleep infinity",
    "node --watch server.js",
    "git status && pnpm dev",
  ])("%s", (command) => {
    expect(endless(command)).toBe(true)
  })
})

describe("a command that ends", () => {
  it.each([
    "sleep 30; echo 'All checks were successful'",
    "gh pr checks 436 --watch",
    "gh run watch 1234 --exit-status",
    "gh pr checks 436 --watch --fail-fast && echo done",
    'until grep -q success ./ci-status 2>/dev/null; do sleep 1; done; echo "CI success"',
    "pnpm test",
    "pnpm run build",
    "pnpm typecheck 2>&1 | tail -20",
    "vite build",
    "vitest run",
    "tsc --noEmit",
    "docker compose up -d",
    "docker compose build",
    "cargo build --release",
    "tail -n 50 app.log",
    "python script.py",
    "npm install",
    "curl -s localhost:3000",
    "",
  ])("%s", (command) => {
    expect(endless(command)).toBe(false)
  })
})
