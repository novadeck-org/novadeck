// The start screen: the city, the cover over it (art/cover.svg, once there is one), the hero,
// the game's name.
import { drawCity, font } from "./city.js"
import { config } from "./config.js"

export class Title extends Phaser.Scene {
  constructor() {
    super("title")
  }

  preload() {
    // The cover is optional: without the file, the start screen is the city.
    this.load.svg("cover", "art/cover.svg", { width: 960, height: 540 })
  }

  create({ last } = {}) {
    const { width, height } = this.scale
    drawCity(this)
    if (this.textures.exists("cover")) {
      const cover = this.add.image(width / 2, height / 2, "cover")
      cover.setScale(Math.max(width / cover.width, height / cover.height)).setAlpha(0.9)
    }
    this.hero = this.add.image(width / 2, height * 0.4, "hero")
    this.hero.setScale((height * 0.55) / this.hero.height)
    const text = { fontFamily: font, color: config.accent, fontStyle: "bold" }
    this.add
      .text(width / 2, height * 0.74, config.title.toUpperCase(), { ...text, fontSize: 44, padding: 24 })
      .setOrigin(0.5)
      .setStroke(config.background, 6)
      .setShadow(0, 0, config.accent, 16, true, true)
    const prompt = last === undefined ? "Click to play" : last + " points. Click to play again"
    this.add
      .text(width / 2, height * 0.87, prompt, { ...text, fontSize: 20, color: "#ffffff" })
      .setOrigin(0.5)
    this.input.once("pointerdown", () => this.scene.start("play"))
    // Lay the screen out again when the page changes size.
    this.scale.once("resize", () => this.scene.restart({ last }))
  }

  update(time) {
    this.registry.get("hero").draw(time)
    this.textures.get("hero").refresh()
  }
}
