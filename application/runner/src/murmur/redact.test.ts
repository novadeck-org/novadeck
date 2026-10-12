import { describe, expect, it } from "../test.js"
import type { AgentDigest, ShellDigest } from "./describer.js"
import { redact, redactDigest, redacted } from "./redact.js"

describe("redacting secrets", () => {
  it.each([
    ["an OpenAI key", "export it as sk-proj-abcdefghijklmnopqrstuvwx now"],
    ["an Anthropic key", "key sk-ant-api03-AbCdEfGhIjKlMnOpQrSt-uvwxyz0123"],
    ["a GitHub token", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["a fine-grained GitHub token", "github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz"],
    ["an AWS key id", "id AKIAIOSFODNN7EXAMPLE here"],
    ["a Slack token", "xoxb-123456789012-abcdefghijkl"],
    ["a JWT", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r"],
    ["a bearer header", "Authorization: Bearer abcDEF1234567890abcdef"],
    ["a long hex run", "digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
    ["a base64 run", "blob dGhpcyBpcyBhIHNlY3JldCBrZXkgZm9yIHRlc3RpbmcgMTIzNDU2Nw1X"],
  ])("removes %s", (_name, text) => {
    const result = redact(text)
    expect(result).toContain(redacted)
    expect(result.length).toBeLessThan(text.length + redacted.length)
  })

  it("removes the value of a secret-looking assignment and keeps the name", () => {
    expect(redact("API_KEY=hunter2 pnpm dev")).toBe(`API_KEY=${redacted} pnpm dev`)
    expect(redact('export DB_PASSWORD="my pass word"')).toBe(`export DB_PASSWORD="${redacted}"`)
    expect(redact("GITHUB_TOKEN='abc'")).toBe(`GITHUB_TOKEN='${redacted}'`)
    expect(redact("client_secret=abc&x=1")).toBe(`client_secret=${redacted}&x=1`)
  })

  it("removes the value of a secret-looking key in JSON", () => {
    expect(redact('{"password": "p4ss", "user": "ada"}')).toBe(
      `{"password": "${redacted}", "user": "ada"}`,
    )
  })

  it("removes the value that follows a secret-looking flag", () => {
    expect(redact("cli login --password hunter2 --verbose")).toBe(
      `cli login --password ${redacted} --verbose`,
    )
    expect(redact("cli --api-key=abc")).toBe(`cli --api-key=${redacted}`)
  })

  it("removes a URL's credentials and keeps the rest", () => {
    expect(redact("git clone https://ada:s3cret@github.com/acme/app.git")).toBe(
      `git clone https://${redacted}@github.com/acme/app.git`,
    )
    expect(redact("postgres://user:pw@db:5432/app")).toBe(`postgres://${redacted}@db:5432/app`)
  })

  it("removes a key block, even when its end isn't there", () => {
    const block =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----"
    expect(redact(`before\n${block}\nafter`)).toBe(`before\n${redacted}\nafter`)
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIEow")).toBe(redacted)
  })

  it("leaves ordinary text alone", () => {
    const text = [
      "pnpm vitest --watch src/murmur/service.test.ts",
      "commit 69231a3e0f1d2c3b4a5968778695a4b3c2d1e0f9 on task/murmur",
      "max_tokens=300 author=ada keyboard=us",
      "application/runner/src/murmur/describer.ts and application/protocol/src/schemas.ts",
      "viridian-finale-implementation-and-the-shared-league",
      "https://github.com/mzpkdev/novadeck/pull/133",
      "Tests: 58 passed (59)",
    ].join("\n")
    expect(redact(text)).toBe(text)
  })
})

describe("redacting a digest", () => {
  const previous = { title: "Deploying app" }

  it("cleans every string of an agent digest", () => {
    const digest: AgentDigest = {
      kind: "agent",
      harness: "Claude Code",
      project: "app",
      folder: "api",
      branch: "task/API_KEY=abc",
      plan: "Rotate sk-abcdefghijklmnopqrstuvwxyz",
      folders: ["src"],
      prompts: ["use DB_PASSWORD=pw please", "now deploy"],
      reply: "done with https://u:p@host/",
      summary: "rotated sk-abcdefghijklmnopqrstuvwxyz",
      previous,
    }
    const clean = redactDigest(digest) as AgentDigest
    expect(JSON.stringify(clean)).not.toMatch(/ghp_|sk-abc|=pw|=abc|u:p@/)
    expect(clean.prompts[1]).toBe("now deploy")
    expect(clean.previous?.title).toBe("Deploying app")
  })

  it("sees a key block that spans the rows of a screen", () => {
    const digest: ShellDigest = {
      kind: "shell",
      project: null,
      folder: null,
      command: "cat id_rsa",
      screen: [
        "-----BEGIN PRIVATE KEY-----",
        "MIIEvQIBADANBgkqhkiG9w0B",
        "-----END PRIVATE KEY-----",
        "$",
      ],
      previous: null,
    }
    const clean = redactDigest(digest) as ShellDigest
    // Every row of the block is masked, and the rows stay where they are.
    expect(clean.screen).toEqual([redacted, redacted, redacted, "$"])
  })
})

// [what the terminal showed, the secret in it that must go]
const leaks: [string, string][] = [
  ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
  ["DATABASE_URL=postgres://app:Sup3rS3cret@db.internal:5432/app", "Sup3rS3cret"],
  ["REDIS_URL=redis://:p4ssw0rdXYZ@cache:6379/0", "p4ssw0rdXYZ"],
  ["mongodb+srv://admin:hunter2@cluster0.mongodb.net/test", "hunter2"],
  ["npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789", "aBcDeFgHiJkLmNoPq"],
  ["//registry.npmjs.org/:_authToken=0f3a1b2c-1111-2222-3333-444455556666", "0f3a1b2c"],
  ["password = pypi-AgEIcHlwaS5vcmcCJGE0ZjYx", "AgEIcHlwaS5v"],
  ["Authorization: token ghx0123456789abcdefABCDEF", "ghx0123456789"],
  ["x-api-key: 3f9a8b7c6d5e4f3a2b1c", "3f9a8b7c6d5e"],
  ["curl -H 'X-Api-Key: Zx9Qp2Lm7Rt4Vb8Nc1' https://api.example.com", "Zx9Qp2Lm7Rt4"],
  ["curl -u admin:hunter2 https://api.example.com", "hunter2"],
  ["ANTHROPIC_API_KEY: sk-ant-api03-short", "api03-short"],
  ["  password: hunter2", "hunter2"],
  ['    password: "hunter2"', "hunter2"],
  ["client_secret: abcDEF123ghiJKL", "abcDEF123ghiJKL"],
  ["  DB_PASS: hunter2-long-password", "hunter2-long"],
  ["sk_live_51HxYzAbCdEfGhIjKlMnOpQr", "51HxYzAbCd"],
  ["rk_live_51HxYzAbCdEfGhIjKlMnOpQr", "51HxYzAbCd"],
  ["STRIPE_SECRET_KEY=sk_live_51HxYzAbCdEfGhIjKlMnOpQr", "51HxYzAbCd"],
  ["stripe listen --api-key sk_live_51HxYzAbCdEfGhIjKlMnOpQr", "51HxYzAbCd"],
  ["AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY", "9tSrke72"],
  ["glpat-xxXXxx1234567890abcd", "xxXXxx12345"],
  ["hf_AbCdEfGhIjKlMnOpQrStUvWxYz012345", "AbCdEfGhIjKl"],
  ["https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX", "XXXXXXXXXXXX"],
  [
    "https://discord.com/api/webhooks/123456789012345678/abcDEFghiJKLmnoPQRstuVWXyz-0123456789_abc",
    "abcDEFghiJKL",
  ],
  ["https://example.com/cb?access_token=abc123XYZ&state=1", "abc123XYZ"],
  ["https://bucket.s3.amazonaws.com/f?X-Amz-Signature=abcd1234ef567890", "abcd1234ef567890"],
  ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7", "MIIEvQIBADAN"],
  ["export OPENAI_API_KEY = sk-xx", "sk-xx"],
  ["+ export GITHUB_TOKEN=gho_16C7e42F292c6912E7710c838347Ae178B4a", "16C7e42F"],
  ["PGPASSWORD=hunter2 psql", "hunter2"],
  ["MYSQL_PWD=hunter2 mysql", "hunter2"],
  ["ADMIN_PWD=hunter2", "hunter2"],
  ["DB_PASS=hunter2", "hunter2"],
  ["docker login -p hunter2 registry", "hunter2"],
  ["mysql -uroot -phunter2", "hunter2"],
  ['SECRET_KEY_BASE="a b" # comment', '"a b"'],
  ['{"apiKey": 12345678}', "12345678"],
  ["apiKey=Zx9Qp2Lm7Rt4", "Zx9Qp2Lm7Rt4"],
  ['{"clientSecret":"Zx9Qp2Lm7Rt4"}', "Zx9Qp2Lm7Rt4"],
  ["AccountName=acct;AccountKey=Zx9Qp2Lm7Rt4Vb8Nc1==;EndpointSuffix=core", "Zx9Qp2Lm7Rt4"],
  ["Server=db;User Id=sa;Password=hunter2;", "hunter2"],
  ["jdbc:postgresql://db:5432/app?user=app&password=hunter2", "hunter2"],
  ["MY_SECRETVALUE=hunter2", "hunter2"],
  ["Password: hunter2", "hunter2"],
  ['"private_key_id": "1a2b3c4d5e6f"', "1a2b3c4d5e6f"],
  ["ghp_abc123", "abc123"],
  ["set -x OPENAI_API_KEY sk-short", "sk-short"],
  ['$env:OPENAI_API_KEY = "sk-short"', "sk-short"],
  ["Authorization: Basic YWRtaW46aHVudGVyMg==", "YWRtaW46"],
  ["Authorization: Bearer abc123", "abc123"],
  ["Cookie: session=abcDEF123456; csrftoken=XyZ", "abcDEF123456"],
  ["Set-Cookie: sid=abcDEF123456789; Path=/", "abcDEF123456789"],
  ["https://user:p@ss@host/", "p@ss"],
  ["https://ghp_abc123@github.com/x/y.git", "abc123"],
  ["https://x-access-token:ghs_abc123@github.com/x/y", "abc123"],
  ["sk-abcdefghij", "abcdefghij"],
  ["AGE-SECRET-KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQ", "QYQSZQGPQYQ"],
  ["hvs.CAESIJlU9JMYEhOPYv4igdhm9PnZDrabYdobQ4Ymnlq1qY-vGh4KHGh2cy5oV", "CAESIJlU9JMY"],
  ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
  ["Bearer abc123", "abc123"],
]

// Text that mentions a secret's name or looks like one, and must reach the model whole.
const kept = [
  "integrity sha512-abc",
  "image@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "commit 69231a3",
  "commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "id 550e8400-e29b-41d4-a716-446655440000",
  "MAX_KEYS=3 KEY_COUNT=10 PRIMARY_KEY=id",
  "const key = cache.get(id)",
  "--sort-key name",
  "auth=required authority=root",
  "token_count=1200 tokenizer=bpe max_tokens=300",
  "sessionId=42",
  "/home/user/projects/novadeck/application/runner/src/murmur/ServiceTest123Abc",
  "useWorkspaceTerminalSelectionStateManager2Hook",
  "AbstractSingletonProxyFactoryBeanConfigurer2Impl",
  "SomeVeryLongTestNameThatDescribesBehaviour1AndMore",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
  "d41d8cd98f00b204e9800998ecf8427e  file.txt",
  "https://github.com/acme/app/tree/feature/AbcDefGhiJklMnoPqrStuVwx1234567890",
  "--keymap us --key-file ./id.pem",
  "pnpm --filter @novadeck/runner test -- --token-budget 300",
  "kubectl get secret my-secret -o yaml",
  "--auth-type oauth",
  '{"auth": "none", "author": "ada"}',
  "keys = d.keys()",
  "authButton=primary",
  "cat /etc/passwd",
  "ada@mac ~/Projects/Novadeck2/application/runner/src/murmur % pnpm test",
  "cd /Users/Ada/Projects/Shop2024/services/checkout",
  "C:\\Users\\Ada\\Projects\\Shop2024\\services\\checkout> npm test",
  "Wrote src/components/DashboardOverviewPanel2/index.tsx",
  "import { WorkspaceTerminalSelectionState2 } from './state'",
  "FAIL src/murmur/service.test.ts > Murmur > describes2Terminals_whenTheGpuIsReady",
  "PWD=/home/ada/project",
]

describe("redacting what terminals show", () => {
  it.each(leaks)("removes the secret in %s", (text, secret) => {
    const result = redact(text)
    expect(result).not.toContain(secret)
    expect(result).toContain(redacted)
  })

  it.each(kept)("keeps %s", (text) => {
    expect(redact(text)).toBe(text)
  })
})

describe("redacting a screen's rows", () => {
  // The terminal side joins a soft-wrapped line before redaction, so a secret is on one row.
  const secrets = [
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a09",
    "STRIPE_SECRET_KEY=sk_live_51HxYzAbCdEfGhIjKlMnOpQrStUvWxYz",
    "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-abcdefgh",
    "dGhpcyBpcyBhIHNlY3JldCBrZXkgZm9yIHRlc3RpbmcgMTIzNDU2Nw1X",
    "postgres://app:Sup3rS3cretPassword@db.internal:5432/app",
    "ya29.a0AfH6SMBx-abcdefghijklmnopqrstuvwxyz0123456789",
  ]

  it.each(secrets)("removes %s from its row, leaving the rows around it", (secret) => {
    const result = redact(`before\n${secret}\n$ ls -la`)

    expect(result).not.toMatch(/9f86d0|sk_live_51|ghp_abc|AbCdEfGh|dGhpcyBp|Sup3rS3|a0AfH6/)
    expect(result.startsWith("before\n")).toBe(true)
    expect(result.endsWith("\n$ ls -la")).toBe(true)
  })

  it("does not carry a run on into the next row", () => {
    const text = [
      "commit 69231a3e0f1d2c3b4a5968778695a4b3c2d1e0f9",
      "Author: Ada <ada@example.com>",
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822c\nuser@host",
      "Digest: sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "Status: Downloaded newer image",
    ].join("\n")

    const result = redact(text)

    expect(result).toContain("Author: Ada <ada@example.com>")
    expect(result).toContain("user@host")
    expect(result).toContain("Status: Downloaded newer image")
    expect(result.split("\n")[0]).toBe(text.split("\n")[0])
    expect(result).toContain(
      "Digest: sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    )
  })

  it("keeps the rows of ordinary text apart", () => {
    const text = "commit 69231a3e0f1d2c3b4a5968778695a4b3c2d1e0f9\non task/murmur\ndone"
    expect(redact(text)).toBe(text)
  })

  it("removes Polish password names and Google access tokens", () => {
    expect(redact("hasło: tajne123")).toBe(`hasło: ${redacted}`)
    expect(redact("haslo=tajne123")).toBe(`haslo=${redacted}`)
    expect(redact("ya29.a0AfH6SMBx-abcdefghijklmnop")).toBe(redacted)
  })

  it("leaves a short bare base64 string alone", () => {
    expect(redact("dGhpcyBpcyBhIHNlY3JldA==")).toBe("dGhpcyBpcyBhIHNlY3JldA==")
  })
})

describe("redacting what a delta review found", () => {
  const gone: [string, string][] = [
    ["$ openssl rand -base64 32\nK7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols=", "K7gNU3sdo"],
    ["AWS Secret Access Key [None]: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
    ["$ cat key.txt\nwJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
    ["redis-cli -a S3cr3tP4ss", "S3cr3tP4ss"],
    ["redis-cli -a mypassword123 ping", "mypassword123"],
    ["_auth=dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNz"],
    ["export npm_config__auth=dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    [
      "SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP",
      "abcdefghijklmnopqrstuv",
    ],
    ["SENTRY_DSN=https://abc123def456@o123.ingest.sentry.io/456", "abc123def456"],
    ["https://0123456789abcdef0123456789abcdef@o1.ingest.sentry.io/5", "0123456789abcdef"],
    ["export AUTH=Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["htpasswd -b .htpasswd admin hunter2", "hunter2"],
    ["openssl enc -k mypassword", "mypassword"],
    ["openssl enc -aes-256-cbc -pass pass:hunter2 -in a", "hunter2"],
    [
      "export DISCORD_BOT=MTE1ODk2NjEwNzA2NjEwNzA2Ng.GhJk12.abcdefghijklmnopqrstuvwxyzABCD",
      "GhJk12",
    ],
  ]
  it.each(gone)("removes the secret in %s", (text, secret) => {
    const result = redact(text)
    expect(result).not.toContain(secret)
    expect(result).toContain(redacted)
  })

  const unchanged = [
    "Server running at http://127.0.0.1:5173\n@novadeck/ui:dev: ready in 300ms",
    "listening on http://localhost:3000\n@scope/pkg@1.2.3 build",
    "ssh://git@github.com:mzpk/novadeck.git",
    "git@github.com:mzpk/novadeck.git",
    "password: z.string().min(8)",
    "password = getpass()",
    "token=os.environ['TOKEN']",
    "SECRET_KEY = os.environ.get('SECRET_KEY')",
    "apiKey: process.env.API_KEY,",
    "const password = req.body.password",
    "secret: ${{ secrets.GITHUB_TOKEN }}",
    "  --token <TOKEN>  the token",
    "export TOKEN=$VAR",
    "export TOKEN=${VAR}",
    "integrity sha512-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789==",
    "warn: integrity sha512-K7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols=",
    "integrity sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8w",
    "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
    "https://github.com/mzpk/novadeck/pull/131/files#diff-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "/home/mzpk/Workspace/novadeck/tasks/murmur/novadeck/application/runner/src/terminals/manager.ts",
    "~/Projects/Novadeck2/application/runner/src/murmur",
    "services/checkout/ServiceTest123AbcDef456Ghi789Jkl",
    "SSH_AUTH_SOCK=/run/user/1000/ssh-agent.socket",
    "auth=required",
    "Basic auth enabled for user admin",
    "Bearer token required",
  ]
  it.each(unchanged)("keeps %s", (text) => {
    expect(redact(text)).toBe(text)
  })
})

describe("redacting Polish and quoted values", () => {
  it.each([
    ['hasło: "moje tajne hasło"', "tajne"],
    ["haslo='moje tajne haslo'", "tajne"],
    ["HASLO_DB=tajne123", "tajne123"],
    ["db_hasło=tajne123", "tajne123"],
    ['--password "my secret words"', "secret"],
    ["export DB_PASSWORD='two words here'", "words"],
    ['token: "two words here"', "words"],
  ])("removes all of the value in %s", (text, secret) => {
    const result = redact(text)
    expect(result).not.toContain(secret)
    expect(result).toContain(redacted)
  })
})

const shell = (screen: string[], continues: boolean[] = []): ShellDigest => ({
  kind: "shell",
  project: null,
  folder: null,
  command: null,
  screen,
  continues,
  previous: null,
})
const screenOf = (digest: ShellDigest, continues?: boolean[]) =>
  (redactDigest({ ...digest, ...(continues && { continues }) }) as ShellDigest).screen

describe("redacting a shell's screen, row by row", () => {
  it.each([
    ["Compiling serde_json", "ghp_A1b2C3d4E5f6G7h8I9j0", "ghp_A1b2"],
    ["LOG_LEVEL=DEBUG_INFO", "TOKEN=hunter2xyz99", "hunter2xyz99"],
    ["[====] 100% 12/12 1s", "sk_live_abcd1234efghijkl", "sk_live_abcd"],
    ["host 14:47 10", "ghp_A1b2C3d4E5f6G7h8I9j0K1l2", "ghp_A1b2"],
    ["Compiling serde_json", "AKIAIOSFODNN7EXAMPLE", "AKIAIOSFOD"],
  ])("finds a secret at the start of the row after %s", (before, row, secret) => {
    const screen = screenOf(shell(["$ cat out", before, row, "$"]), [false, true, false, false])

    expect(screen.join("\n")).not.toContain(secret)
    expect(screen).toHaveLength(4)
    // The row before may go too: a group that redacts differently as one is masked whole.
    expect([before, redacted]).toContain(screen[1])
  })

  it("masks a secret split across a full row on both rows", () => {
    const hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a09"
    const screen = screenOf(shell(["$ sha256sum f", hex.slice(0, 40), hex.slice(40), "$"]), [
      false,
      true,
      false,
      false,
    ])

    expect(screen.join("")).not.toMatch(/9f86d0|15b0f00a/)
    expect(screen).toHaveLength(4)
    expect(screen[1]).toContain(redacted)
    expect(screen[2]).toContain(redacted)
    expect(screen[0]).toBe("$ sha256sum f")
    expect(screen[3]).toBe("$")
  })

  it("masks a token split mid-way", () => {
    const screen = screenOf(
      shell(["env | grep STRIPE", "STRIPE_SECRET_KEY=sk_li", "ve_51HxYzAbCdEfGhIjKlMn"]),
      [false, true, false],
    )

    expect(screen.join("")).not.toMatch(/sk_li|51HxYz/)
    expect(screen).toHaveLength(3)
  })

  it("does not join rows that don't continue, so a hex run stops at the row", () => {
    const rows = [
      "commit 69231a3e0f1d2c3b4a5968778695a4b3c2d1e0f9",
      "Author: Ada",
      "69231a3e0f1d2c3b",
    ]

    expect(screenOf(shell(rows), [false, false, false])).toEqual(rows)
  })

  it("keeps boxes and progress bars as they are", () => {
    const rows = [
      "┌────────────────────┐│ build              │",
      "│ [=======>      ] 52% │",
      "└────────────────────┘",
    ]

    expect(screenOf(shell(rows), [true, true, false])).toEqual(rows)
  })
})

describe("redacting names in other scripts, and quotes left open", () => {
  it.each([
    ['{"hasło": "tajne"}', "tajne"],
    ["hasło=tajne123", "tajne123"],
    ['{"passwörd": "tajne"}', "tajne"],
    ['--password "abc def', "def"],
    ['hasło: "niezamknięte tajne', "tajne"],
    ["export DB_PASSWORD='two words", "words"],
    ['token: "two words here', "words"],
  ])("removes the value in %s", (text, secret) => {
    const result = redact(text)

    expect(result).not.toContain(secret)
    expect(result).toContain(redacted)
  })

  it("leaves what follows a closed quote alone", () => {
    expect(redact('password: "hunter2" and more')).toBe(`password: "${redacted}" and more`)
  })
})

const chop = (text: string, width: number): string[] =>
  text.match(new RegExp(`.{1,${width}}`, "gu")) ?? []
describe("redacting key blocks and values across a screen's rows", () => {
  // Rows as a narrow pane draws them: each long line in pieces, all but the last continuing.
  const drawn = (lines: string[], width: number) => {
    const screen: string[] = []
    const continues: boolean[] = []
    for (const line of lines) {
      const pieces = chop(line, width)
      pieces.forEach((piece, i) => {
        screen.push(piece)
        continues.push(i + 1 < pieces.length)
      })
    }
    return { screen, continues }
  }
  const redactScreen = (screen: string[], continues: boolean[]) =>
    (redactDigest({ ...shell(screen), continues }) as ShellDigest).screen

  const body = [
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
    "QyNTUxOQAAACDx4kq9YtmpHq1q2kQZp0bq2M9r9kq8Xq1wQnR3sQe9RgAAAJjZp8Xp2afF",
    "AAAEDu7Wt2Zf3gq1pX8yq9sh",
  ]
  const pem = ["-----BEGIN OPENSSH PRIVATE KEY-----", ...body, "-----END OPENSSH PRIVATE KEY-----"]

  it.each([33, 40, 80])("masks every row of a key block in a %s-column pane", (width) => {
    const { screen, continues } = drawn(["$ cat id_ed25519", ...pem, "$"], width)

    const result = redactScreen(screen, continues)

    expect(result.join("\n")).not.toMatch(/b3Blbn|QyNTUx|AAAEDu7|OPENSSH|BEGIN/)
    expect(result).toHaveLength(screen.length)
    expect(result[0]).toBe("$ cat id_ed25519")
    expect(result.at(-1)).toBe("$")
  })

  it("masks to the end of the screen when the END marker is not visible", () => {
    const { screen, continues } = drawn(["$ cat id", pem[0] ?? "", ...body], 80)

    const result = redactScreen(screen, continues)

    expect(result.join("\n")).not.toMatch(/b3Blbn|QyNTUx|AAAEDu7/)
    expect(result[0]).toBe("$ cat id")
  })

  it("masks a service account's private key in a JSON line drawn in pieces", () => {
    const line = `  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\\n-----END PRIVATE KEY-----\\n",`
    const { screen, continues } = drawn(["$ cat sa.json", "{", line, "}"], 80)

    const result = redactScreen(screen, continues)

    expect(result.join("\n")).not.toContain("MIIEvQ")
  })

  it.each([
    ["{'debug': False, 'smtp_password': 'Zq8rT2mWx9LpKd3VnB7sYcHt5Gf', 'port': 25}"],
    ['{"level":"info","api_secret": "Zq8rT2mWx9LpKd3VnB7sYcHt5Gf'],
    ["      postgresPassword: 'Zq8rT2mWx9LpKd3VnB7sYcHt5Gf'  # prod"],
    ['{"level":"info","api_secret": "Zq8rT2mWx9LpKd3VnB7sYcHt5Gf", "n": 1}'],
  ])("masks a value drawn across rows: %s", (line) => {
    const { screen, continues } = drawn(["$ tail -f app.log", line, "$"], 40)

    const result = redactScreen(screen, continues)

    expect(result.join("\n")).not.toMatch(/Zq8r|T2mW|LpKd|Vn[B7]|Yc?Ht|5Gf/)
    expect(result[0]).toBe("$ tail -f app.log")
    expect(result.at(-1)).toBe("$")
  })

  it("leaves a continued pair alone when nothing crosses its boundary", () => {
    const rows = ["Compiling serde_json", "Compiling tokio v1.4"]

    expect(redactScreen(rows, [true, false])).toEqual(rows)
  })

  it.each([
    'print("password: " + user.password)',
    "log.info('token: ' + mask(t))",
    'console.log("secret: " + secret)',
  ])("keeps the code line %s", (line) => {
    expect(redact(line)).toBe(line)
  })
})

describe("redacting what a last review found", () => {
  const rowsOf = (lines: string[], width: number) => {
    const screen: string[] = []
    const continues: boolean[] = []
    for (const line of lines) {
      const pieces = chop(line, width)
      pieces.forEach((piece, i) => {
        screen.push(piece)
        continues.push(i + 1 < pieces.length)
      })
    }
    return redactDigest({
      kind: "shell",
      project: null,
      folder: null,
      command: null,
      screen,
      continues,
      previous: null,
    }) as ShellDigest
  }
  const key = [
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7aaaa",
    "bbbbQyNTUxOQAAACDx4kq9YtmpHq1q2kQZp0bq2M9r9kq8Xq1wQnR3sQe9Rg",
  ]

  it("masks a key that begins on the row where a certificate ends", () => {
    const { screen } = rowsOf(
      [
        "$ cat cert.pem key.pem",
        "-----END CERTIFICATE----------BEGIN PRIVATE KEY-----",
        ...key,
        "-----END PRIVATE KEY-----",
        "$",
      ],
      80,
    )

    expect(screen.join("\n")).not.toMatch(/MIIEvQ|bbbbQy/)
    expect(screen.at(-1)).toBe("$")
  })

  it.each([["-----BEGIN PRIVATE KEY"], ["-----BEGIN RSA PRIVATE KEY--"]])(
    "starts a block at %s, a marker cut short",
    (begin) => {
      const { screen } = rowsOf(["$ cat key", begin, ...key], 80)

      expect(screen.join("\n")).not.toMatch(/MIIEvQ|bbbbQy/)
      expect(screen[0]).toBe("$ cat key")
    },
  )

  it("masks from the top of the screen to an END whose BEGIN scrolled away", () => {
    const { screen } = rowsOf([...key, "-----END PRIVATE KEY-----", "$ ls"], 80)

    expect(screen.join("\n")).not.toMatch(/MIIEvQ|bbbbQy/)
    expect(screen.at(-1)).toBe("$ ls")
  })

  it.each([
    "DATABASE_PASSWORD=Zq8rT2mWx9LpKd3VnB7sYcHt5GfAb4Cd6EfGh8Ij",
    "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'",
  ])("masks every row of a secret across three rows or more: %s", (line) => {
    for (const width of [20, 33, 40]) {
      const { screen } = rowsOf(["$ run", line, "$"], width)

      expect(screen.join("\n")).not.toMatch(/Zq8r|LpKd|Ij$|dozjg|R8U|eyJhb/m)
      expect(screen[0]).toBe("$ run")
    }
  })

  it.each([
    "it's a password: \"correct horse battery",
    "the user's token: 'abc def ghi",
    "can't say, secret: 'two words",
  ])("still masks an unclosed quote after an apostrophe: %s", (line) => {
    const result = redact(line)

    expect(result).toContain(redacted)
    expect(result).not.toMatch(/horse|def|words/)
  })
})

const chopped = (line: string, width: number) => {
  const screen = line.match(new RegExp(`.{1,${width}}`, "gu")) ?? []
  return {
    screen,
    continues: screen.map((_row, i) => i + 1 < screen.length),
  }
}
describe("redacting strings inside strings, and only the secret's characters", () => {
  it.each([
    [String.raw`{"body":"{\"password\":\"Hunter2xyz!\"}"}`, "Hunter2xyz"],
    [String.raw`{\"apiKey\":\"Hunter2xyz!abc\"}`, "Hunter2xyz"],
    [String.raw`echo "password=\"Hunter2xyz!\""`, "Hunter2xyz"],
    [String.raw`{"msg": "request body {\"password\": \"hunter2xyz\"}"}`, "hunter2xyz"],
    [String.raw`{"msg":"login {\"password\":\"hunter2xyz\", \"user\": 1}"}`, "hunter2xyz"],
  ])("removes the value in %s", (text, secret) => {
    const result = redact(text)

    expect(result).not.toContain(secret)
    expect(result).toContain(redacted)
    // The quotes and the rest of the line stay.
    expect(result.replace(redacted, "").length).toBeGreaterThan(text.length - 40)
  })

  it("keeps quotes around a masked value", () => {
    expect(redact('PASSWORD="hunter2 abc" next')).toBe(`PASSWORD="${redacted}" next`)
    expect(redact('{"token": "abcdefgh"}')).toBe(`{"token": "${redacted}"}`)
  })

  const rowsOf = (lines: string[], width: number) => {
    const screen: string[] = []
    const continues: boolean[] = []
    for (const line of lines) {
      const pieces = chop(line, width)
      pieces.forEach((piece, i) => {
        screen.push(piece)
        continues.push(i + 1 < pieces.length)
      })
    }
    return redactDigest({
      kind: "shell",
      project: null,
      folder: null,
      command: null,
      screen,
      continues,
      previous: null,
    }) as ShellDigest
  }
  const key = [
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7aaaa",
    "bbbbQyNTUxOQAAACDx4kq9YtmpHq1q2kQZp0bq2M9r9kq8Xq1wQnR3sQe9Rg",
  ]

  it("masks a key that begins on the row where a certificate ends", () => {
    const { screen } = rowsOf(
      [
        "$ cat cert.pem key.pem",
        "-----END CERTIFICATE----------BEGIN PRIVATE KEY-----",
        ...key,
        "-----END PRIVATE KEY-----",
        "$",
      ],
      80,
    )

    expect(screen.join("\n")).not.toMatch(/MIIEvQ|bbbbQy/)
    expect(screen.at(-1)).toBe("$")
  })

  it.each([["-----BEGIN PRIVATE KEY"], ["-----BEGIN RSA PRIVATE KEY--"]])(
    "starts a block at %s, a marker cut short",
    (begin) => {
      const { screen } = rowsOf(["$ cat key", begin, ...key], 80)

      expect(screen.join("\n")).not.toMatch(/MIIEvQ|bbbbQy/)
      expect(screen[0]).toBe("$ cat key")
    },
  )

  it("masks from the top of the screen to an END whose BEGIN scrolled away", () => {
    const { screen } = rowsOf([...key, "-----END PRIVATE KEY-----", "$ ls"], 80)

    expect(screen.join("\n")).not.toMatch(/MIIEvQ|bbbbQy/)
    expect(screen.at(-1)).toBe("$ ls")
  })

  it.each([
    "DATABASE_PASSWORD=Zq8rT2mWx9LpKd3VnB7sYcHt5GfAb4Cd6EfGh8Ij",
    "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'",
  ])("masks every row of a secret across three rows or more: %s", (line) => {
    for (const width of [20, 33, 40]) {
      const { screen } = rowsOf(["$ run", line, "$"], width)

      expect(screen.join("\n")).not.toMatch(/Zq8r|LpKd|Ij$|dozjg|R8U|eyJhb/m)
      expect(screen[0]).toBe("$ run")
    }
  })

  it.each([
    "it's a password: \"correct horse battery",
    "the user's token: 'abc def ghi",
    "can't say, secret: 'two words",
  ])("still masks an unclosed quote after an apostrophe: %s", (line) => {
    const result = redact(line)

    expect(result).toContain(redacted)
    expect(result).not.toMatch(/horse|def|words/)
  })
})

describe("redacting strings inside strings, and only the secret's characters", () => {
  it.each([
    [String.raw`{"body":"{\"password\":\"Hunter2xyz!\"}"}`, "Hunter2xyz"],
    [String.raw`{\"apiKey\":\"Hunter2xyz!abc\"}`, "Hunter2xyz"],
    [String.raw`echo "password=\"Hunter2xyz!\""`, "Hunter2xyz"],
    [String.raw`{"msg": "request body {\"password\": \"hunter2xyz\"}"}`, "hunter2xyz"],
    [String.raw`{"msg":"login {\"password\":\"hunter2xyz\", \"user\": 1}"}`, "hunter2xyz"],
  ])("removes the value in %s", (text, secret) => {
    const result = redact(text)

    expect(result).not.toContain(secret)
    expect(result).toContain(redacted)
    // The quotes and the rest of the line stay.
    expect(result.replace(redacted, "").length).toBeGreaterThan(text.length - 40)
  })

  it("keeps quotes around a masked value", () => {
    expect(redact('PASSWORD="hunter2 abc" next')).toBe(`PASSWORD="${redacted}" next`)
    expect(redact('{"token": "abcdefgh"}')).toBe(`{"token": "${redacted}"}`)
  })

  const rowsOf = (line: string, width: number): string[] => {
    const { screen, continues } = chopped(line, width)
    return [...(redactDigest({ ...shell(screen), continues }) as ShellDigest).screen]
  }

  it("masks only the characters of an integrity hash that fills rows, not the line around it", () => {
    const line =
      "npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory. integrity sha512-9xq2Vb8Kc3Lm5Np7Rs1Tv4Wy6Zb0Cd2Ef5Gh8Ij1Kl3Mn6Op9Qr2St5Uv8Wx1Yz4Ab7Cd0Ef3Gh6Ij9Kl2Mn5Op8Qr1St4Uv7Wx0Yz3A=="

    const rows = rowsOf(line, 40)

    expect(rows.slice(0, 2).join("")).toBe(line.slice(0, 80))
    expect(rows[0]).toBe(line.slice(0, 40))
  })

  it("masks a token that starts a row after a row ending in a word character, and the rest of it", () => {
    const token = "ghp_OHM6rIz5PEGNr6Df0PCSJaqSIz3B0eBMR2mP"
    const rows = rowsOf(`${"x".repeat(20)}${token}" ok`, 20)

    expect(rows.join("\n")).not.toMatch(/OHM6|0PCS/)
    expect(rows[0]).toBe("x".repeat(20))
  })
})

describe("redacting text with characters outside the basic plane", () => {
  it.each([
    ["𝐀=b", "𝐀=b"],
    ["𝐱: hello", "𝐱: hello"],
    ["𠀀=1", "𠀀=1"],
    ["julia> 𝐱 = rand(3)", "julia> 𝐱 = rand(3)"],
    ["😀 token: 😀😀 abc", "😀 token: [redacted] abc"],
    ["𠀀: password: 𠀀𠀀 x", "𠀀: password: [redacted] x"],
    ["𝐱: 𝐲=𝐳 token=abcdefgh", "𝐱: 𝐲=𝐳 token=[redacted]"],
    ["𠀀password: hunter2xyz", "𠀀password: [redacted]"],
  ])("redacts %s without hanging", { timeout: 5000 }, (text, expected) => {
    expect(redact(text)).toBe(expected)
  })

  it("redacts a screen of them", { timeout: 5000 }, () => {
    const rows = ["julia> 𝐱 = rand(3)", "𠀀: password: 𠀀𠀀", "😀😀😀😀=😀😀😀😀"]
    const result = redactDigest({
      ...shell(rows),
      continues: [true, true, false],
    }) as ShellDigest

    expect(result.screen[0]).toBe(rows[0])
    expect(result.screen[1]).toBe("𠀀: password: [redacted]")
  })
})

const rows = (row: string): string[] => Array.from({ length: 60 }, () => row)
const random = (): string =>
  Array.from(
    { length: 400 },
    () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[
        Math.floor(Math.random() * 64)
      ],
  ).join("")

describe("the time redaction takes", () => {
  const time = (screen: string[]): number => {
    const started = performance.now()
    redactDigest({ ...shell(screen), continues: screen.map((_row, i) => i < screen.length - 1) })
    return performance.now() - started
  }
  it.each([
    ["Ab1+ repeated", () => rows("Ab1+".repeat(100))],
    ["a=b repeated", () => rows("a=b ".repeat(100).trimEnd().slice(0, 400))],
    ["a=b without spaces", () => rows(`${"a=b".repeat(133)}a`)],
    ["quotes", () => rows('"a: '.repeat(100))],
    ["random base64", () => Array.from({ length: 60 }, random)],
  ])("is quick for a 60 by 400 continued screen of %s", { timeout: 5000 }, (_name, screen) => {
    // A budget to catch a blow-up (it was 13 s once), not to benchmark: a loaded runner is slow.
    expect(time(screen())).toBeLessThan(2000)
  })
})

describe("code words as values", () => {
  it.each([
    "token = await fetchToken()",
    "password = new Uint8Array(32)",
    "API_TOKEN=await",
    "SECRET_KEY=import",
    "password: this",
    "secret = require('./secret.json')",
    "token: this.token",
  ])("keeps %s", (text) => {
    expect(redact(text)).toBe(text)
  })

  it.each([
    ["password: 'this'", "password: '[redacted]'"],
    ['password: "new"', 'password: "[redacted]"'],
    ["--password new", "--password [redacted]"],
    ["--token this", "--token [redacted]"],
    ["?token=this&x=1", "?token=[redacted]&x=1"],
    ["password=Await", "password=[redacted]"],
    ["PASSWORD=NEW", "PASSWORD=[redacted]"],
    ["token = newSecretValue123", "token = [redacted]"],
    ["set -x API_TOKEN new", "set -x API_TOKEN [redacted]"],
  ])("still masks %s", (text, expected) => {
    expect(redact(text)).toBe(expected)
  })
})

describe("the sentinel character in the input", () => {
  it("becomes a question mark, in a row and in a group", () => {
    const one = redactDigest({ ...shell(["\uE000 ~/proj main", "$ ls"]) }) as ShellDigest
    const group = redactDigest({
      ...shell(["TOKEN=abcdefgh", "ij\uE000 ok"]),
      continues: [true, false],
    }) as ShellDigest

    expect(one.screen).toEqual(["? ~/proj main", "$ ls"])
    expect(group.screen).toEqual(["TOKEN=[redacted]", "[redacted] ok"])
    expect(redact("a\uE000b TOKEN=abcdefgh")).toBe("a?b TOKEN=[redacted]")
  })
})

const long = (length: number): string =>
  Array.from({ length }, (_x, i) => "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"[(i * 7) % 36]).join("")

describe("long values and command lines", () => {
  it.each([1000, 1100, 1500, 3000])("masks a value of %s characters to its end", (length) => {
    const value = long(length)

    for (const line of [`AWS_SESSION_TOKEN=${value}`, `aws_session_token: ${value}`]) {
      const result = redact(line)

      expect(result).toMatch(/^(AWS_SESSION_TOKEN=|aws_session_token: )\[redacted\]$/)
    }
  })

  it("does not carry a lazy command-line match across a long line", { timeout: 5000 }, () => {
    const line = `${"curl ".repeat(2000)}-u admin:hunter2`

    expect(redact(line).length).toBeGreaterThan(0)
  })

  it.each([
    "redis-cli -a S3cr3tP4ss",
    "mysql -u root -phunter2xyz app",
    "curl -u admin:hunter2xyz https://x",
    "docker login -p hunter2xyz registry",
    "openssl enc -k hunter2xyz",
  ])("still masks the password in %s", (line) => {
    expect(redact(line)).not.toMatch(/S3cr3t|hunter2/)
  })
})

describe("a token after a row that ended in a word character", () => {
  it("is masked to its end, however long", () => {
    const jwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${"eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ".repeat(3)}.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV`
    const lines = [`${"x".repeat(20)}`, ...jwt.match(/.{1,20}/g)!, "$"]
    const continues = lines.map((_row, i) => i < lines.length - 1 && lines[i]!.length === 20)

    const result = (redactDigest({ ...shell(lines), continues }) as ShellDigest).screen.join("\n")

    expect(result).not.toMatch(/eyJh|SflKx|eyJzd|IkpvaG4/)
  })
})

describe("a secret behind a label that ends a row", () => {
  it.each([
    ["password: ", "token: B4aTpQ9xK2mWz7LvN3sYcH5g"],
    ["Secret Access Key: ", "token: B4aTpQ9xK2mWz7LvN3sYcH5g"],
    ["API_KEY= ", "ghp_B4aTpQ9xK2mWz7LvN3sYcH5gAbCd"],
  ])("masks the secret on the next row after %s", (label, secret) => {
    const width = 24
    const lines = [label.padStart(width, "x").slice(-width), ...(secret.match(/.{1,24}/g) ?? [])]
    const continues = lines.map((row, i) => i < lines.length - 1 && row.length === width)

    const result = (redactDigest({ ...shell(lines), continues }) as ShellDigest).screen.join("\n")

    expect(result).not.toMatch(/B4aTp|Q9xK|WzLv|7LvN|sYcH/)
  })
})

describe("Google keys without a digit, and ids glued to a secret", () => {
  const key = "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfG"

  it.each([
    [key, key],
    [`https://maps.example/api?q=1&key=${key}&z=2`, key],
    [`| maps | ${key} | prod |`, key],
    [`GOOGLE_KEY: ${key}`, key],
    // A run of lower case in a random key is no sign of a word.
    ["AIzaSyAbCdEfghijklmnopqrstuvWxYzAbCdEfG", "AIzaSyAbCdEfghijklmnopqrstuvWxYzAbCdEfG"],
  ])("masks the key in %s", (text, secret) => {
    const result = redact(text)

    expect(result).not.toContain(secret.slice(8))
    expect(result).toContain(redacted)
  })

  it("keeps a name that begins like a key", () => {
    expect(redact("Documenting AIzaSyDocsExampleKeyPlaceholder")).toBe(
      "Documenting AIzaSyDocsExampleKeyPlaceholder",
    )
  })

  it("masks an id glued to the secret after it, and leaves a word of capitals alone", () => {
    expect(redact("AKIAIOSFODNN7EXAMPLEwJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe(redacted)
    expect(redact("AKIAIOSFODNN7EXAMPLE")).toBe(redacted)
    expect(redact("Debugging ASIATEMPORARYCREDENTIALS logic")).toBe(
      "Debugging ASIATEMPORARYCREDENTIALS logic",
    )
    expect(redact("AKIAEXAMPLEPLACEHOLDER")).toBe("AKIAEXAMPLEPLACEHOLDER")
  })

  it.each([
    ["a capital", "AKIAIOSFODNN7EXAMPLEK7MDENGbPxRfiCYEXAMPLEKEYwJalrXUtnFEMI"],
    ["a digit", "AKIAIOSFODNN7EXAMPLE7wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"],
    [
      "a capital after an equals sign",
      "X=AKIAIOSFODNN7EXAMPLEK7MDENGbPxRfiCYEXAMPLEKEYwJalrXUtnFEMI",
    ],
    [
      "a digit after an equals sign",
      "X=AKIAIOSFODNN7EXAMPLE7wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
    ],
  ])("masks an id glued to a secret that starts with %s, and the secret with it", (_name, text) => {
    const result = redact(text)
    expect(result).not.toContain("IOSFODNN7EXAMPLE")
    expect(result).not.toContain("MDENGbPxRfiCY")
    expect(result).not.toContain("wJalrXUtnFEMI")
  })
})
