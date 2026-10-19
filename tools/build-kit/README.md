# @novadeck/build-kit

The apps' Vite helpers: how a build is deployed, which each app configures in its own
`vite.config.ts`. It's a tools package, not a library: what it applies is these apps' deploy
policy, so it needs no library fences.

- `contentSecurityPolicy({ placeholder, connect, envPrefix })` fills the connect-src of the
  page's Content Security Policy. `placeholder`, in `index.html`, becomes the sources
  `connect(build)` gives for the build's `mode`, `command` and environment: the variables of
  the env files the app's build reads, with `envPrefix` (the app's own by default; never
  empty), the process's before the files'. A page without the
  placeholder fails the build. `contentSecurityPolicyName` names the plugin, for a test
  runner's config that leaves it out of its own page.
- `connectSources({ api, runner, development })` (`/connect-sources`, with nothing of Vite, so
  an app's tests can read its policy anywhere), the sources of an app that talks to services
  on loopback, and where configured to an HTTP(S) API (an absolute URL, or a relative path,
  which adds nothing) and a WebSocket runner elsewhere; while served, the development server's
  WebSocket on loopback too. Each URL comes with the setting that names it, for its errors.
- `hostingHeaders({ rules })` emits a build's `_headers` file where `rules(mode)` has any;
  `headersFile(rules)` writes one, each path then its headers. A host applies every rule a
  path matches and joins a header several set, so rules should set each header once.
- `searchVisibility({ hidden })` asks search engines not to index the builds `hidden(mode)`
  names (`withNoindex(html)`), in the page itself, as a robots.txt Disallow would keep
  crawlers from reading it.
- `fontsAsFiles`, a `build.assetsInlineLimit` that always ships fonts as files: a policy that
  loads fonts only from the app itself would block one inlined as a data: URL.
- `bundleChecks({ utilities, budgets })` (`/bundle-checks`) fails a build that loads the
  terminal emulator with its first chunk, draws terminals without their styles
  (`terminal-xterm.css`), or whose CSS lost a folder the UI's stylesheet scans for Tailwind
  (`utilities` lists one utility from each: `frontendUtilities` for the visitor build and
  the preview, `desktopUtilities` for the desktop app, which adds the UI's own). It fails
  too when the build holds nothing for these checks to read. With `budgets` it also fails a
  build that weighs too much: `first`, what the page loads first, its scripts and styles
  gzipped and every woff2 font they declare, and `demo`, the module `demoModule` names with
  what it loads and the first chunk does not. The visitor build sets them in
  `apps/try/vite.config.ts`; the others have none.
- `unit()` (`/vitest`), the jsdom `unit` project of the UI's packages' tests and the try
  app's (`frontend/specs` runs projects of its own, and `frontend/test-kit` has no tests).

Each is a subpath of its own (`@novadeck/build-kit/content-security-policy`, `/connect-sources`,
`/hosting-headers`, `/search-visibility`, `/fonts`, `/bundle-checks`, `/vitest`). It ships as TypeScript source, with no build: Vite loads a
config's workspace packages in Node, which runs the source as it is, so no module imports
another, and its syntax is erasable (`erasableSyntaxOnly`): no enums, namespaces or
parameter properties, which Node can't strip.
