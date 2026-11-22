import { describe, expect, it } from "vitest"

import { compatibility } from "./compatibility.js"
import { contract } from "./contract.js"
import { snapshotContract, writeSnapshot } from "./snapshot.js"

describe("contract.json", () => {
  // The contract as this build has it, which a release keeps for the next to be compared with
  // (scripts/compatibility). After a change to the contract, `pnpm --filter @novadeck/protocol test -u`
  // writes it again.
  it("is the contract as the source has it", async () => {
    const written = writeSnapshot(snapshotContract(contract, compatibility))
    await expect(written).toMatchFileSnapshot("../contract.json")
  })
})
