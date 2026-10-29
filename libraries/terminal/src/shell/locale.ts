import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"

/**
 * The shells' environment with a UTF-8 locale where it names none. An app macOS starts
 * from the Dock or Finder gets no `LANG`, so its shells would run in the C locale, where
 * bash's line editor mangles a character such as "ż" as it is typed. Terminal.app sets
 * `LANG` from the system's language and country for the same reason; this does as it
 * does, reading them from `region` (`AppleLocale`, its `@rg=` override left out), and
 * falls back to `en_US.UTF-8` where the system has no such locale. It asks `defaults`
 * synchronously, for 2 s at most, so its caller asks once.
 * Elsewhere, or with any locale variable set, the environment is left as it is.
 */
export const withLocale = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  region: () => string | undefined = systemRegion,
  installed: (locale: string) => boolean = (locale) => existsSync(`/usr/share/locale/${locale}`),
): NodeJS.ProcessEnv => {
  if (platform !== "darwin" || env.LANG || env.LC_ALL || env.LC_CTYPE) return env
  const found = region()?.split("@")[0]
  const locale = found && installed(`${found}.UTF-8`) ? `${found}.UTF-8` : "en_US.UTF-8"
  return { ...env, LANG: locale }
}

/** The region macOS formats for, as `en_US@rg=plzzzz`; undefined when it can't be read. */
const systemRegion = (): string | undefined => {
  try {
    return execFileSync("/usr/bin/defaults", ["read", "-g", "AppleLocale"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return undefined
  }
}
