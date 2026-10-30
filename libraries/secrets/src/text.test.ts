import { randomBytes } from "node:crypto"

import { describe, expect, it } from "vitest"

import { redacted } from "./marks.js"
import { maskedSpans, redact, redactAs } from "./text.js"

describe("redacting secrets", () => {
  it("writes each secret as the placeholder it is given", () => {
    expect(
      redactAs("<secret>")("API_KEY=hunter2 and ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
    ).toBe("API_KEY=<secret> and <secret>")
  })

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

// Text that mentions a secret's name or looks like one, and must be kept whole.
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

describe("redacting a text line by line", () => {
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

describe("redacting tools' output, and code that only reads a secret", () => {
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

describe("redacting quotes in code and prose", () => {
  it.each([
    'print("password: " + user.password)',
    "log.info('token: ' + mask(t))",
    'console.log("secret: " + secret)',
  ])("keeps the code line %s", (line) => {
    expect(redact(line)).toBe(line)
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

describe("redacting strings inside strings", () => {
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
})

describe("secrets nested in ordinary fields", () => {
  it("counts Unicode code points at the value cap when a nested secret is already masked", () => {
    const emoji = "😀".repeat(513)
    expect(redact(`password: ${emoji}=token=Hunter2xyz!`)).toBe(
      `password: ${emoji}=token=${redacted}`,
    )
  })

  it.each([
    ["long assignments", `outer=${"a=b".repeat(800)}=PASSWORD=Hunter2xyz!`],
    ["a quoted assignment", 'outer="before password=Hunter2xyz! after"'],
    ["a YAML field", "outer: before token: Hunter2xyz! after"],
    ["escaped JSON", String.raw`{"outer":"{\"password\":\"Hunter2xyz!\"}"}`],
  ])("still masks the nested secret in %s", (_name, text) => {
    expect(redact(text)).not.toContain("Hunter2xyz")
    expect(redact(text)).toContain(redacted)
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
  it("becomes a question mark", () => {
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

describe("long runs of random base64", () => {
  it.each([1000, 4000])("masks %i random bytes of base64 whole, as a key or a blob", (bytes) => {
    for (let i = 0; i < 30; i += 1) {
      const blob = randomBytes(bytes).toString("base64")
      expect(redact(blob)).toBe(redacted)
      expect(redact(`  tls.key: ${blob}`)).toBe(`  tls.key: ${redacted}`)
      expect(redact(randomBytes(bytes).toString("base64url"))).toBe(redacted)
    }
  })

  it("masks a base64 PEM body, which is base64 of base64", () => {
    const pem = Buffer.from(
      `-----BEGIN PRIVATE KEY-----\n${randomBytes(1200).toString("base64")}\n-----END PRIVATE KEY-----\n`,
    ).toString("base64")

    expect(redact(`data: ${pem}`)).toBe(`data: ${redacted}`)
  })

  it.each([
    [
      "a camelCase identifier",
      "someVeryLongCamelCaseIdentifierWithoutAnythingSpecialAtAll_v2_getUserAccountBalanceFromRemote",
    ],
    [
      "a long URL path",
      "https://example.com/api/v1/organizations/members/permissions/assignments/12345/history",
    ],
    [
      "a file path",
      "/usr/local/lib/node_modules/typescript/lib/typescript.js:1234:56 src/components/ui/button/index.tsx",
    ],
    [
      "a minified function",
      "function a(b,c){return b.map(function(d){return d.value+c}).filter(Boolean).join(',')}",
    ],
    [
      "a long snake_case name",
      "test_that_the_user_account_balance_is_updated_after_a_remote_service_call_2",
    ],
    [
      "a kebab-case slug",
      "how-to-configure-the-remote-service-and-cache-the-account-balance-in-2024-edition",
    ],
    [
      "a Go import path",
      "github.com/aws/aws-sdk-go-v2/service/secretsmanager/internal/endpoints/v1",
    ],
  ])("leaves %s alone", (_name, text) => {
    expect(redact(text)).toBe(text)
  })
})

describe("mangled symbols are not keys", () => {
  it.each([
    "_ZN4llvm15ScalarEvolution18getOrCreateAddExprENS_8ArrayRefIPKNS_4SCEVEEENS2_11NoWrapFlagsE",
    "_ZN4llvm4yaml7yamlizeISt6vectorINS0_22DebugValueSubstitutionESaIS3_EENS0_12EmptyContextEEENSt9enable_ifIXsr18has_SequenceTraitsIT_EE5valueEvE4typeERNS0_2IOERS8_bRT0_",
    "_ZNK4llvm15ScalarEvolution31getNonTrivialDefiningScopeBoundEPKNS_4SCEVE",
    "__ZN4core3fmt9Formatter9write_str17h0123456789abcdefE",
    "_RNvMs0_NtNtCs9ltFPbKhVHr_4core3fmt9Formatter9write_str",
  ])("leaves %s alone", (symbol) => {
    const line = `    at ${symbol} (lib.so)`

    expect(redact(line)).toBe(line)
  })
})

describe("long keys that look like something else at first", () => {
  it("masks a base64url key that starts as a mangled name does", () => {
    const key =
      "_ZqH3mKp9vX2-abcdefgLw8Rt5YuNc4Ve7Bn1Mz6Qa0Sd3Fg8Hj2Kl5Px9Cv4Bn7Mz1Qw6Er3Ty8Ui2Op5As0Df7Gh4Jk9Lz2Xc6Vb1Nm3Qp8Wo5Ei7Ru4Ty0"
    expect(redact(`echo ${key}`)).toBe(`echo ${redacted}`)
  })

  it("keeps a mangled name with a stack frame's offset glued on", () => {
    const frame =
      "./app(_Z34uspoof_getSkeletonUnicodeString_74PK13USpoofCheckerjRKN6icu_7413UnicodeStringERS3_P10UErrorCode+0x1a2) [0x7f3a2b1c4d5e]"
    expect(redact(frame)).toBe(frame)
  })

  it("masks a key that ends a sentence, and keeps the full stop", () => {
    const key = "wJalrXUtnFEMI9K7MDENGbPxRfiCYEXAMPLEKEY99Ab3dZ"
    expect(redact(`your key is ${key}.`)).toBe(`your key is ${redacted}.`)
  })
})

describe("the pieces redaction masks", () => {
  it("are the secrets as the text had them, a run across newlines as one", () => {
    expect(maskedSpans("API_KEY=hunter2 and ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toEqual([
      "hunter2",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ])
    expect(maskedSpans("-----BEGIN RSA PRIVATE KEY-----\nMIIEow")).toEqual([
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow",
    ])
    expect(maskedSpans("nothing here")).toEqual([])
  })
})
