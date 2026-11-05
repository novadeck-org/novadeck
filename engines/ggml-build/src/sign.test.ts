import { describe, expect, it } from "vitest"

import { quote, windowsSigning } from "./sign.ts"

describe("signing on Windows", () => {
  it("quotes a value as a PowerShell string, doubling its quotes", () => {
    expect(quote("C:\\nvw\\staging")).toBe("'C:\\nvw\\staging'")
    expect(quote("it's'; Remove-Item x; '")).toBe("'it''s''; Remove-Item x; '''")
  })

  it("signs only when the release names the endpoint, account and profile", () => {
    const named = {
      AZURE_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net",
      AZURE_SIGNING_ACCOUNT: "novadeck",
      AZURE_SIGNING_PROFILE: "release",
    }
    expect(windowsSigning(named)).toEqual({
      endpoint: "https://weu.codesigning.azure.net",
      account: "novadeck",
      profile: "release",
    })
    expect(windowsSigning({ ...named, AZURE_SIGNING_PROFILE: "" })).toBeUndefined()
    expect(windowsSigning({})).toBeUndefined()
  })
})
