import { inject } from "vitest"

import { expect, it } from "./test"

declare module "vitest" {
  // eslint-disable-next-line typescript/consistent-type-definitions -- Only an interface merges with vitest's.
  export interface ProvidedContext {
    // Set in vitest.config.ts: CI's browsers must give WebGL2 to the specs that need it.
    webglRequired: boolean
  }
}

// Whether this browser gives WebGL2. Headless Chromium draws it in software, which a browser
// or runner image bump can take away.
export const hasWebgl = Boolean(document.createElement("canvas").getContext("webgl2"))

// The WebGL specs skip where the browser has no WebGL2, which on CI would leave their guards
// silently vacant (cell-fit's among them, #458's): there, each spec that needs it fails here
// instead, unless NOVADECK_WEBGL_OPTIONAL=1 allows the skip.
export const requireWebglOnCi = (): void => {
  it.runIf(inject("webglRequired"))("has WebGL2 in this browser, as CI requires", () => {
    expect(
      hasWebgl,
      "No WebGL2 here, so the WebGL specs skip; set NOVADECK_WEBGL_OPTIONAL=1 to allow it",
    ).toBe(true)
  })
}
