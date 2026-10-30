import type { WebPreferences } from "electron"

/**
 * What every page's view and window is held to, whatever it asks for: no Node, isolated
 * from any preload, sandboxed, with the web's own security, and no page views of its own.
 */
export const lockedPreferences = {
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
} as const satisfies WebPreferences
