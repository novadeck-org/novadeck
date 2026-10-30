type SpellcheckSession = { setSpellCheckerLanguages(languages: string[]): void }

type SessionEvents = {
  on(event: "session-created", listener: (session: SpellcheckSession) => void): unknown
}

/**
 * Keeps spellcheck from going online. On Linux, Chromium spellchecks with Hunspell
 * dictionaries it downloads from Google for the system's language, as soon as a window opens
 * in a session; Novadeck goes online only for updates and the models the person turns on
 * (novadeck-website's privacy page says so). So on Linux every session, the default one and
 * the panes' too, gets no language, and text fields there go without spellcheck. macOS and
 * Windows check with the system's own spellchecker and keep it. Call it before the app is
 * ready: the default session is created then.
 */
export const keepSpellcheckOffline = (
  app: SessionEvents,
  platform: NodeJS.Platform = process.platform,
): void => {
  if (platform !== "linux") return
  app.on("session-created", (session) => session.setSpellCheckerLanguages([]))
}
