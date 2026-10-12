import { describe, expect, it } from "../test.js"
import { looksSecret, parseDescription } from "./description.js"

const reply = (title: unknown) => JSON.stringify({ title })

const title = (text: string, source?: string) =>
  parseDescription(JSON.stringify({ title: text }), source)?.title

describe("reading the model's title", () => {
  it("keeps a title that fits", () => {
    expect(parseDescription(reply("Upload client retries"))).toEqual({
      title: "Upload client retries",
    })
  })

  it("tidies whitespace, markdown, quotes and a trailing full stop", () => {
    expect(parseDescription(reply('  "**Fix** the  build."  '))).toEqual({ title: "Fix the build" })
  })

  it("drops invisible and reordering characters from a title", () => {
    // A bidi override, an isolate, zero-width characters, a soft hyphen and a C1 control.
    expect(title("Fix\u202E the\u2066 build\u2069\u202C")).toBe("Fix the build")
    expect(title("Fix\u200B the\u2060 bu\u00ADild\uFEFF\u0085 now")).toBe("Fix the build now")
    // Hiding a key's middle with them does not get it past the guard.
    expect(title("Rotate sk-\u200BAbC9dEf2GhI4jKl7 key")).toBeUndefined()
  })

  it("keeps the joiners that Persian, Indic scripts and emoji need", () => {
    expect(title("برنامه\u200Cنویسی وب")).toBe("برنامه\u200Cنویسی وب")
    expect(title("Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} emoji picker")).toBe(
      "Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} emoji picker",
    )
  })

  it.each([
    "OK button styling",
    "Okay dialog copy",
    "Yes/No prompt handling",
    "Hello world example",
    "Hi-DPI icon rendering",
    "Hey Siri integration",
    "Thanks page redesign",
    "Thank you email template",
    "Continue button fix",
    "Continue onboarding flow",
    "Go on-call schedule",
    "Try again button",
    "Keep going indicator",
    "How are you form",
    "Whats up endpoint",
    "Go ahead deploy",
    "Yesterday report export",
    "Okta SSO login",
  ])("keeps %s, which only begins like a chat phrase", (text) => {
    expect(title(text)).toBeDefined()
  })

  it.each([
    "Hi there",
    "Okay sounds good",
    "Continue please",
    "Try again",
    "Is the build green?",
    "Thanks a lot",
    "Thank you so much",
    "Hey how are you",
    "Okay thanks",
    "Try again later",
    "How is it going",
    "Cześć co tam",
    "Dzięki za pomoc",
    "Dziękuję bardzo",
    "你好",
    "ありがとうございます",
    "안녕하세요",
  ])("refuses %s, which is all chat or a question", (text) => {
    expect(title(text)).toBeUndefined()
  })

  it.each([
    "Rotating webhook keys",
    "Billing webhook keys",
    "Rotating billing webhook secrets",
    "Rotating billing webhook keys rollout",
    "Following nginx access log",
    "Following the nginx error log",
    "Awaria testów runnera",
    "Walidacja formularza",
    "Walidacja formularza logowania",
    "Following the access log",
    "Upload client retries",
    "Fixing C++ build",
    "Node.js upgrade",
    "Testy jednostkowe runnera",
    "Übersicht der Tests",
    "Ошибка тестов",
  ])("keeps %s, real work that shares words with an example", (text) => {
    expect(title(text)).toBeDefined()
    // With a digest that says the same words, there is no doubt it is the work.
    expect(title(text, `about ${text}`)).toBeDefined()
  })

  it("refuses an example copied, unless the digest is about the same work", () => {
    expect(title("Rotating billing webhook keys")).toBeUndefined()
    expect(title("Awaria testów")).toBeUndefined()
    expect(title("Rotating billing webhook keys", "fix the billing page")).toBeUndefined()
    // The source is folded like the title's words: accents don't hide it.
    expect(title("Awaria testów", "Naprawa: awaria TESTÓW w CI")).toBe("Awaria testów")
    expect(title("Rotating webhook keys", "fix the billing page")).toBeUndefined()
    expect(
      title("Rotating billing webhook keys", "please rotate: rotating billing webhook keys"),
    ).toBe("Rotating billing webhook keys")
  })

  it.each([
    ["認証フローの修正", true],
    ["修复登录页面", true],
    ["ログイン 画面 修正", true],
    ["修", false],
    ["修复登录页面和注册页面的所有问题以及更多", false],
    ["Naprawa logowania", true],
  ])("counts %s by its characters when it has no spaces: %s", (text, valid) => {
    expect(title(text) !== undefined).toBe(valid)
  })

  it("keeps titles that merely share a word with an example, or start like a chat phrase", () => {
    expect(parseDescription(reply("Billing invoice export"))?.title).toBe("Billing invoice export")
    expect(parseDescription(reply("Continuous integration setup"))?.title).toBe(
      "Continuous integration setup",
    )
  })

  it("ignores fields it didn't ask for", () => {
    expect(parseDescription(JSON.stringify({ title: "Fix the build", summary: "x" }))).toEqual({
      title: "Fix the build",
    })
  })

  it.each([
    ["a question", reply("Hows going?")],
    ["a question about the work", reply("What is the build status?")],
    ["a chat phrase", reply("Try again")],
    ["a greeting", reply("Hello there")],
    ["an example title", reply("Rotating billing webhook keys")],
    ["an example title in other case", reply("rotating Billing webhook KEYS.")],
    ["not JSON", "Sure! A title."],
    ["a non-object", "[1]"],
    ["no title", JSON.stringify({ summary: "Fix the build" })],
    ["a title that isn't text", reply(3)],
    ["a one-word title", reply("Build")],
    ["a seven-word title", reply("one two three four five six seven")],
    [
      "a title past 48 characters",
      reply("Internationalisation internationalisation internationalisation"),
    ],
    ["an empty title", reply("  ")],
  ])("rejects %s", (_name, raw) => {
    expect(parseDescription(raw)).toBeUndefined()
  })
})

describe("refusing a title that looks like a secret", () => {
  it.each([
    "Fix PR 131",
    "Upgrade to Node 26",
    "Migrate v2 API",
    "Review EMO-104",
    "Bump React 19.2 types",
    "Internationalisation of checkout",
  ])("keeps %s", (text) => {
    expect(title(text)).toBe(text)
  })

  it.each([
    "Rotate ghp_A1b2C3d4E5f6G7h8 key",
    "Token Zq8rT2mWx9LpKd3VnB7s",
    "Using sk-proj-abc123DEF456",
    "Fix [redacted] login",
    "Set password: hunter2xyz99",
    "Deploy a1b2c3d4e5f6g7h8i9",
  ])("refuses %s", (text) => {
    expect(title(text)).toBeUndefined()
  })
})

describe("realistic titles with names, versions and numbers", () => {
  const titles = [
    "Bumping version to v2.3.1",
    "Releasing novadeck v0.9.0-beta.2",
    "Fixing EMO-104 login redirect",
    "Working on JIRA-1234 checkout",
    "Reviewing commit 9f86d08",
    "Rebasing onto 1b19df9",
    "Fixing useWorkspaceStore selector",
    "Testing integration.test.ts timing",
    "Publishing @novadeck/protocol package",
    "Upgrading to Node 26",
    "Computing sha256 checksums",
    "Adding OAuth2 login flow",
    "Decoding base64 payloads",
    "Building for x86_64 Linux",
    "Adding IPv6 support",
    "Deploying to k8s cluster",
    "Setting up i18n strings",
    "Debugging WebSocketProvider reconnects",
    "Refactoring createResetToken helper",
    "Running pytest on test_auth.py",
    "Fixing aarch64-apple-darwin build",
    "Building aarch64-unknown-linux-gnu target",
    "Pulling postgres:16-alpine image",
    "Upgrading python3.12 dependencies",
    "Configuring ubuntu-24.04 runner",
    "Migrating to React 19",
    "Tuning PostgreSQL 16 indexes",
    "Fixing CVE-2024-3094 exposure",
    "Reading RFC 9110 semantics",
    "Building ffmpeg with libx264",
    "Encoding H.264 video",
    "Testing utf-8 decoding",
    "Fixing ES2022 target errors",
    "Updating tsconfig.build.json paths",
    "Editing docker-compose.yml services",
    "Running cargo build --release",
    "Fixing serde_json deserialization",
    "Profiling useCallback re-renders",
    "Fixing MAX_RETRY_COUNT handling",
    "Bumping @types/node to 24.0.0",
    "Installing vitest@3.2.4",
    "Fixing TS2345 type errors",
    "Tracking issue #131 review",
    "Reviewing PR #131 redaction",
    "Adding Ed25519 key support",
    "Rotating TLS certificates",
    "Writing murmur bash tests",
    "Naprawa testów integracyjnych",
    "Poprawki w przeglądarce plików",
    "Wdrażanie wersji 2.3.1",
    "Migracja bazy PostgreSQL16",
    "修复登录问题",
    "重构数据库模块",
    "テストの修正",
    "ビルドエラー修正",
    "Fixing internationalization bugs",
    "Implementing authentication middleware",
    "Optimizing ResizeObserver callbacks",
    "Debugging ReactDOMServer hydration",
    "Configuring electron-builder notarization",
    "Adding getServerSideProps caching",
    "Investigating MutationObserver leaks",
    "Updating CHANGELOG for v1.0.0-rc.1",
    "Fixing useLayoutEffect warning",
    "Testing HTTP/2 multiplexing",
    "Benchmarking SQLite WAL mode",
    "Fixing Bearer token refresh",
    "Rotating API token secrets",
    "Fixing token: refresh bug",
    "Session secret rotation",
    "Password reset flow",
    "Debugging password: reset email",
    "Adding gpt-4o-mini fallback",
    "Calling claude-opus-4-1 model",
    "Using llama3.1-8b locally",
    "Testing stm32f407 firmware",
    "Building esp32-s3 firmware",
    "Fixing win32-x64 packaging",
    "Packaging darwin-arm64 build",
    "Fixing linux-x64-gnu binary",
    "Upgrading eslint-plugin-react-hooks",
    "Configuring @typescript-eslint/parser",
    "Fixing react-native-reanimated crash",
    "Reviewing feature/murmur-redaction branch",
    "Merging task/murmur into main",
    "Fixing src/terminals/murmur.ts",
    "Fixing Basic auth2 header",
    "修复登录页面在移动端的布局错误",
    "重构用户认证模块并补充单元测试",
    "修复v2版本登录问题",
    "データベース接続エラーの修正対応",
    "Naprawa konfiguracyjnego skryptu",
    "Poprawa zabezpieczeniowych reguł",
    "Datenbankverbindungsfehler beheben",
    "Fixing Kubernetes-deployment rollout",
    "Writing TypeScript declarations",
    "Debugging IntersectionObserver usage",
    "Fixing ServiceWorkerRegistration errors",
    "Refactoring useWorkspaceStore hook",
    "Updating README.md and CHANGELOG.md",
    "Running pnpm format:check lint",
    "Fixing pnpm-lock.yaml conflicts",
    "Editing application/runner/package.json",
  ]

  it("keeps every one", () => {
    expect(titles.filter((text) => title(text) === undefined)).toEqual([])
  })

  it.each([
    "Fixing ghp_A1b2C3d4E5f6G7h8I9j0 leak",
    "Rotate sk-proj-abc123DEF456ghi789 key",
    "Remove AKIAIOSFODNN7EXAMPLE from repo",
    "Paste Zq8rT2mWx9LpKd3VnB7sYcHt5GfAb4Cd6Ef",
    "Using glpat-xxXXxx1234567890abcd",
    "Token hf_AbCdEfGhIjKlMnOpQrStUvWx012345",
    "Set password: hunter2xyz99",
    "Debug xoxb-123456789012-abcdefghijkl",
    "Google ya29.a0AfH6SMBx-abcdefghijklmnop",
  ])("refuses %s", (text) => {
    expect(title(text)).toBeUndefined()
  })
})

describe("the guard on titles and the words in them", () => {
  const legit = [
    "Bumping version to v2.3.1",
    "Releasing novadeck v0.9.0-beta.2",
    "Fixing EMO-104 login redirect",
    "Working on JIRA-1234 checkout",
    "Reviewing commit 9f86d08",
    "Rebasing onto 1b19df9",
    "Fixing useWorkspaceStore selector",
    "Testing integration.test.ts timing",
    "Publishing @novadeck/protocol package",
    "Upgrading to Node 26",
    "Computing sha256 checksums",
    "Adding OAuth2 login flow",
    "Decoding base64 payloads",
    "Building for x86_64 Linux",
    "Adding IPv6 support",
    "Deploying to k8s cluster",
    "Setting up i18n strings",
    "Debugging WebSocketProvider reconnects",
    "Refactoring createResetToken helper",
    "Running pytest on test_auth.py",
    "Fixing aarch64-apple-darwin build",
    "Building aarch64-unknown-linux-gnu target",
    "Pulling postgres:16-alpine image",
    "Upgrading python3.12 dependencies",
    "Configuring ubuntu-24.04 runner",
    "Migrating to React 19",
    "Tuning PostgreSQL 16 indexes",
    "Fixing CVE-2024-3094 exposure",
    "Reading RFC 9110 semantics",
    "Building ffmpeg with libx264",
    "Encoding H.264 video",
    "Testing utf-8 decoding",
    "Fixing ES2022 target errors",
    "Updating tsconfig.build.json paths",
    "Editing docker-compose.yml services",
    "Running cargo build --release",
    "Fixing serde_json deserialization",
    "Profiling useCallback re-renders",
    "Fixing MAX_RETRY_COUNT handling",
    "Bumping @types/node to 24.0.0",
    "Installing vitest@3.2.4",
    "Fixing TS2345 type errors",
    "Tracking issue #131 review",
    "Adding Ed25519 key support",
    "Rotating TLS certificates",
    "Writing murmur bash tests",
    "Naprawa testów integracyjnych",
    "Poprawki w przeglądarce plików",
    "Wdrażanie wersji 2.3.1",
    "Migracja bazy PostgreSQL16",
    "修复登录问题",
    "重构数据库模块",
    "テストの修正",
    "ビルドエラー修正",
    "Fixing internationalization bugs",
    "Implementing authentication middleware",
    "Optimizing ResizeObserver callbacks",
    "Debugging ReactDOMServer hydration",
    "Configuring electron-builder notarization",
    "Adding getServerSideProps caching",
    "Investigating MutationObserver leaks",
    "Updating CHANGELOG for v1.0.0-rc.1",
    "Fixing useLayoutEffect warning",
    "Testing HTTP/2 multiplexing",
    "Benchmarking SQLite WAL mode",
    "Fixing Bearer token refresh",
    "Rotating API token secrets",
    "Fixing token: refresh bug",
    "Session secret rotation",
    "Password reset flow",
    "Debugging password: reset email",
    "Adding gpt-4o-mini fallback",
    "Calling claude-opus-4-1 model",
    "Using llama3.1-8b locally",
    "Testing stm32f407 firmware",
    "Building esp32-s3 firmware",
    "Fixing win32-x64 packaging",
    "Packaging darwin-arm64 build",
    "Fixing linux-x64-gnu binary",
    "Upgrading eslint-plugin-react-hooks",
    "Configuring @typescript-eslint/parser",
    "Fixing react-native-reanimated crash",
    "Merging task/murmur into main",
    "Fixing src/terminals/murmur.ts",
    "Fixing Basic auth2 header",
    "  -",
    "ALSO-PREV",
    "guard-only refusals",
    "修复数据库连接池超时问题并添加重试",
    "修复登录页面在移动端的布局错误",
    "重构用户认证模块并补充单元测试",
    "升级到React19并修复类型错误",
    "修复v2版本登录问题",
    "データベース接続エラーの修正対応",
    "ログイン画面のレイアウト崩れを修正",
    "사용자인증모듈리팩토링및테스트추가",
    "Naprawa konfiguracyjnego skryptu",
    "Poprawa zabezpieczeniowych reguł",
    "Datenbankverbindungsfehler beheben",
    "Fixing Kubernetes-deployment rollout",
    "Writing TypeScript declarations",
    "Debugging IntersectionObserver usage",
    "Fixing ServiceWorkerRegistration errors",
    "Refactoring useWorkspaceStore hook",
    "Updating README.md and CHANGELOG.md",
    "Running pnpm format:check lint",
    "Fixing pnpm-lock.yaml conflicts",
    "Editing application/runner/package.json",
    "internationalization",
    "responsibilities",
    "troubleshooting",
    "implementations",
    "authentication",
    "synchronization",
    "synchronizowania",
    "konfiguracyjnego",
    "konfiguracyjnych",
    "uwierzytelniania",
    "uwierzytelnienia",
    "zabezpieczeniowych",
    "przeprogramowania",
    "niezawodnościowych",
    "współbieżnościowy",
    "bezpieczeństwa",
    "Datenbankverbindungsfehler",
    "Benutzerverwaltung",
    "Zugriffsberechtigungen",
    "Abhängigkeitsauflösung",
    "incompatibilities",
    "misconfiguration",
    "misconfigurations",
    "reproducibility",
    "characterization",
    "straightforward",
    "WebSocketProvider",
    "MutationObserver",
    "ResizeObserver",
    "useLayoutEffect",
    "createResetToken",
    "getServerSideProps",
    "ServiceWorkerRegistration",
    "IntersectionObserver",
    "DocumentFragment",
    "HTMLCanvasElement",
    "XMLHttpRequest",
    "AbortController",
    "TypeScript-compiler",
    "electron-builder",
    "docker-compose.yml",
    "tsconfig.build.json",
    "vite.config.ts",
    "package-lock.json",
    "@novadeck/protocol",
    "@novadeck/runner",
    "@tanstack/react-query",
    "react-router-dom",
    "prettier-plugin-tailwindcss",
  ]

  it("passes every legitimate title and word", () => {
    expect(legit.filter((text) => looksSecret(text))).toEqual([])
  })

  it.each([
    "Using Zq8rT2mWx9Lp now",
    "Using a1b2c3d4e5f6g7h8 now",
    "Using X7K2M9Q4W8P3 now",
    "Using k3j9x2m8q1w7z5v4 now",
    "Fix 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "Fix 1b19df98cc13089e7bd5f741397680787156d32e",
    "Using sk_live_51HxYzAbCdEf now",
    "Using rk_live_51HxYzAbCdEf now",
    "Using SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP now",
    "Using AGE-SECRET-KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQ now",
  ])("refuses a random-looking piece or a hash in %s", (text) => {
    expect(looksSecret(text)).toBe(true)
  })

  it(
    "keeps titles with astral letters, emoji and extension B ideographs, and does not hang",
    { timeout: 5000 },
    () => {
      for (const text of ["Solving 𝐱: system", "修复𠀀登录问题", "😀 Fix login 😀", "Fix 𝐀=b"])
        expect(title(text)).toBe(text)
    },
  )
})

describe("names in code are no tokens", () => {
  const titles = [
    "Upgrading to Python 3.12.4",
    "Fixing issue PROJ-12345",
    "Building arm64-v8a APK",
    "Fixing x86_64-pc-windows-msvc build",
    "Testing ES2015 polyfills",
    "Updating base64url encoder",
    "Fixing SHA256SUMS verification",
    "Testing Win10x64 installer",
    "Fixing GPT4o32k context",
    "Adding WebGL2RenderingContext support",
    "Fixing H264Decoder crash",
    "Fixing utf8mb4 collation",
    "Upgrading Ubuntu22.04LTS",
    "Fixing AES256GCM decrypt",
    "Supporting Float32Array buffers",
    "Handling ERR_SSL_PROTOCOL_ERROR",
    "Fixing E11000 duplicate key",
    "Fixing 0x80070005 access error",
    "Debugging SIGSEGV in libc6",
    "Investigating OOMKilled pods",
    "Testing RTX4090 drivers",
    "Fixing MacBookPro18,3 display",
    "Testing iPhone15Pro layout",
    "Fixing ISO8601 date parsing",
    "Parsing RFC3339 timestamps",
    "Adding X25519 key exchange",
    "Fixing P256 signature check",
    "Updating Cargo.lock for 1.80",
    "Fixing node22-alpine image",
    "Testing python3.13t free-threading",
    "Fixing 2024Q3 revenue report",
    "Fixing Q4FY2025 dashboard",
    "Migrating to MySQL8.0.36",
    "Testing HTTP2ConnectionPool",
    "Fixing win-x64 and osx-arm64 RIDs",
    "Building v8.12.0 snapshot",
    "Fixing CVE-2021-44228 log4j2",
    "Running k6 load test",
    "Fixing S3Bucket2Policy rule",
    "Fixing B2B checkout",
    "Fixing t3.2xlarge sizing",
    "Using m6i.32xlarge nodes",
    "Fixing YYYYMMDD-HHMMSS naming",
    "Rendering 3840x2160 frames",
    "Testing 1920x1080p60 capture",
    "Fixing AB12CD34 test",
    "Fixing PR 1234 build",
    "Fixing 2fa TOTP setup",
    "Fixing ed25519-dalek2 build",
    "Fixing build 20241010T1651",
    "Fixing BuildID 4f3c2a1",
    "Testing GH200 NVL72 cluster",
    "Fixing MI300X kernels",
    "Fixing ROCm6.2.1 install",
  ]
  const identifiers = [
    "Float32Array",
    "Float64Array",
    "Float16Array",
    "BigInt64Array",
    "BigUint64Array",
    "Int32Array",
    "WebGL2Context",
    "Http2ServerRequest",
    "Http2SecureServer",
    "Base64Encoder",
    "Utf8Decoder",
    "Sha256Hasher",
    "Ipv4Address",
    "Ipv6Address",
    "Mat4x4Multiply",
    "OAuth2Client",
    "X509Certificate",
    "PKCS12Keystore",
    "Win32Exception",
    "GL_RGBA32F",
    "R8G8B8A8_UNORM",
    "H265Decoder",
    "Ed25519Signer",
    "Ed25519PublicKey",
    "EC2InstanceConnect",
    "DynamoDBv2Table",
    "S3PutObject2",
    "ES2022Target",
    "MacBookPro18",
    "iPhone15ProMax",
    "ThinkPadX1C11",
    "RTX4090Ti",
    "GH200NVL72",
    "SM8650Snapdragon",
    "A17ProChip",
    "AV1Encoder",
    "VP9Decoder",
    "UTF16LEDecoder",
    "ISO88591Codec",
    "GB18030Decoder",
    "Windows11ARM64",
    "macOS15Sequoia",
    "TLS13Handshake",
    "SHA3_256Digest",
    "P256Verifier",
    "Secp256k1Signer",
    "X25519KeyPair",
  ]

  it("keeps titles with versions, ids and model names", () => {
    expect(titles.filter((text) => looksSecret(text))).toEqual([])
  })

  it("keeps titles with identifiers like Float32Array and iPhone15ProMax", () => {
    expect(identifiers.filter((name) => looksSecret(`Fixing ${name} bug`))).toEqual([])
  })

  it("refuses the same hash as a title, which is a commit id in a log", () => {
    expect(looksSecret("Fixing 0123456789abcdef0123456789abcdef test")).toBe(true)
  })
})

describe("provider keys with an underscore", () => {
  it.each([
    "sk_live_51HxYzAbCdEfGhIjKlMn",
    "rk_live_51HxYzAbCdEfGhIjKlMn",
    "hf_AbCdEfGhIjKlMnOpQrStUvWx",
    "shpat_0123456789abcdef0123456789abcdef",
    "ghp_A1b2C3d4E5f6G7h8I9j0K1l2",
    "github_pat_11ABCDEFG0abcdefghijkl",
    "pypi-AgEIcHlwaS5vcmcCJGE0ZjYx",
    "npm_aBcDeFgHiJkLmNoPqRsT",
  ])("refuses %s in a title", (key) => {
    expect(title(`Using ${key} now`)).toBeUndefined()
    expect(title(`Using **${key}** now`)).toBeUndefined()
  })
})

describe("provider keys, wherever they are and whatever is around them", () => {
  const keys = [
    "npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ01",
    "hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123",
    "sk_live_AbCdEfGhIjKlMnOpQrSt",
    "shpat_abcdefabcdefabcdefabcdefabcdefab",
    "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "pypi-AgEIcHlwaS5vcmcCJGE0ZjYxYjE0LTk4NzYtNGQ1Yy1iYjk1",
    "github_pat_ABCDEFGHabcdefghijklmnop",
    "dop_v1_abcdefabcdefabcdefabcdefabcdefab",
  ]
  const wrappers: ((key: string) => string)[] = [
    (key) => `**${key}**`,
    (key) => `\`${key}\``,
    (key) => `"${key}"`,
    (key) => `(${key})`,
    (key) => `[${key}]`,
    (key) => `<${key}>`,
    (key) => `TOKEN=${key}`,
    (key) => `token:${key}`,
    (key) => `$${key}`,
    (key) => `key/${key}`,
    (key) => `_${key}_`,
    (key) => `${key}.`,
  ]

  it("refuses every key in every wrapping", () => {
    const passed: string[] = []
    for (const key of keys)
      for (const wrap of wrappers)
        for (const place of ["Using X now", "X rotated", "Rotating X"]) {
          const text = place.replace("X", wrap(key))
          if (title(text) !== undefined) passed.push(text)
        }
    expect(passed).toEqual([])
  })

  it.each([
    "Fix hf_ hub upload",
    "Docs for sk- keys",
    "Reading npm_config_cache",
    "Setting npm_package_version",
    "Testing hf_hub_download",
    "Fixing hf_transfer_flag",
    "Debugging sk_test_helpers",
    "Fixing npm_lifecycle_event",
    "Rotating hf_token_cache",
    "Fixing sk-learn-contrib import",
    "Using sk-learn pipeline",
    "Setting HF_HUB_ENABLE_HF_TRANSFER",
    "Tuning ghp_ token scopes",
    "Building pypi-publish workflow",
    "Running pypi-attestations check",
    "Fixing glpat-rotation script",
    "Fixing **npm_config_cache** env",
    "Fixing `hf_hub_download` retries",
    "Fixing sk_test_mode handling",
    "Testing dop_v1_tokens docs",
    "Fixing eyJhbGci parsing",
    "Debugging AIzaSyClient wrapper",
    "Fixing xoxb-scopes docs",
  ])("keeps the name in %s", (text) => {
    expect(title(text)).toBeDefined()
  })

  it.each([
    "Fixing `ThinkPadX1C11` bug",
    "Fixing **ThinkPadX1C11** bug",
    "Fixing `GH200NVL72` bug",
    "Testing **stm32f407** firmware",
    "Fixing _iPhone15ProMax_ layout",
    "Fixing `Float32Array` bug",
  ])("keeps a code name in markdown: %s", (text) => {
    expect(title(text)).toBeDefined()
  })
})

describe("keys cut short, and names that begin like keys", () => {
  it.each([
    "hf_QxTzRmWpLkJhGfDsAeV",
    "hf_QxTzRmWpLkJh",
    "ghp_Ab3dEf6hIj9lMn",
    "npm_Ab3dEf6hIj9lMn",
    "sk-Ab3dEf6hIj9lMn",
    "sk_live_Ab3dEf6hIj9lMn",
    "whsec_Ab3dEf6hIj9lMnOp",
    "glpat-Ab3dEf6hIj9lMn",
    "AIzaSyAb3dEf6hIj9lMn",
    "xoxb-123456789012-12345",
  ])("refuses %s, whole or cut short", (key) => {
    expect(title(`Fix ${key}`)).toBeUndefined()
    expect(title(`Fix (${key})`)).toBeUndefined()
  })

  it.each([
    "Installing sk-learn-contrib-imbalanced",
    "Fixing xoxb-token-rotation-handler",
    "Rotating xoxp-user-token-refresh flow",
    "Scoping github_pat_fine_grained_permissions",
    "Reading github_pat_expiration_warnings",
    "Testing sk-proj-scoped-api-keys docs",
    "Fixing glpat-expiration-reminder-job",
    "Parsing ya29.access-token-response bodies",
    "Documenting AIzaSyDocsExampleKeyPlaceholder",
    "Updating sk-SK-translations-for-dashboard",
    "Fixing sk-SK_localization_strings_file",
    "Running pypi-publish-github-action-workflow",
    "Debugging ASIATEMPORARYCREDENTIALS logic",
    "Debugging AKIA prefix detection",
    "Fixing SG.api-key-prefix-validation-rules.check",
    "Reading eyJhbGciOi.eyJzdWIi header",
    "Fixing `sk-learn-contrib-imbalanced` import",
    "Fixing **xoxb-bot-token-scopes-config**",
    "Tuning hf_hub_download_timeout_seconds",
    "Fixing npm_config_registry_url_override",
    "Testing dop_v1_token_format docs",
    "Fixing sk_live_mode_feature_flagging",
    "Fixing rk_test_restricted_keys docs",
    "Using AGE-SECRET-KEY-1 format docs",
    "Reviewing shpat_access_token_scopes",
  ])("keeps %s", (text) => {
    expect(title(text)).toBeDefined()
  })
})
