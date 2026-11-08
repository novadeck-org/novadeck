/* eslint-disable no-await-in-loop -- A scenario's steps run in order, each after the one before. */
import { setups } from "./agents/index.js"
import { item, prompted } from "./chat-prompts.js"
import { describe, e2e, expect, gated, supported } from "./fixture.js"
import { picture } from "./pictures.js"
import { replies, lacking, own, start, through } from "./scenarios.js"

// The chat's images, the same for every harness (see messaging.e2e.ts for the rule on parity).
// Their own file, so the Windows quirks job runs them with a spaced uploads folder.

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    // The chat's images: saved on the runner by `terminals.upload`, then pasted into the box
    // on their own before the words, each as the harness takes a pasted image file. A name with
    // a space makes the path one (the runner's folder may hold spaces too, on macOS and
    // Windows), which Codex and Antigravity take only quoted or escaped.
    for (const { what, images, words } of [
      {
        what: "an image with a space in its name",
        images: ["my shot.png"],
        words: "Read this one",
      },
      { what: "two images", images: ["one.png", "two shot.png"], words: "Compare these two" },
    ])
      gated(it, lacking(setup, "image"))(
        `gives its agent a prompt with ${what}, which the model receives with the words`,
        async ({ e2e: run }) => {
          run.model.use(replies(words, "Seen."))
          const t1 = await start(run, setup)
          const calls = run.model.mark()
          const mark = t1.mark()

          const settled = await prompted(
            t1,
            words,
            images.map((name) => ({ name, data: picture })),
          )
          await t1.until("Seen.")
          await settled()
          await through(t1, ["working", "settled"], { after: mark })

          const call = await run.model.waitFor(
            (each) =>
              !each.side &&
              each.turns.some((one) => one.role === "user" && one.text.includes(words)),
            { after: calls },
          )
          const user = call.turns.findLast((one) => one.role === "user" && one.text.includes(words))
          expect(
            user?.role === "user" ? (user.images ?? 0) : -1,
            "the images it passed to the model",
          ).toBe(images.length)
          // The record keeps each image's place in the words, or beside them.
          const record = await item(t1, "user", (text) => text.includes(words))
          if (setup.image!.inline) expect(record).toContain(`[Image #${images.length}]`)
        },
      )

    it(
      setup.image?.alone === false
        ? "refuses images with no words, writing nothing, where Enter would send none"
        : "sends images with no words",
      async ({ e2e: run }) => {
        run.model.use(own(() => ({ text: "Seen." })))
        const t1 = await start(run, setup)
        const image = [{ name: "shot.png", data: picture }]
        if (setup.image?.alone === false) {
          await expect(t1.prompt("", image)).rejects.toMatchObject({ code: "PROMPT_REFUSED" })
          expect(await t1.screen()).not.toContain("media attached")
          return
        }
        // Followed like any prompt: its receipt settles on the record item of its placeholders.
        const settled = await prompted(t1, "", image)
        await t1.until("Seen.")
        await settled()
      },
    )
  })
}
