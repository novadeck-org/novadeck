// Starts the game: Phaser runs it, and three.js draws its hero (hero.js).
import { config } from "./config.js"
import { loadHero } from "./hero.js"
import { Play } from "./play.js"
import { Title } from "./title.js"

const hero = await loadHero()

// The first scene: the hero's canvas becomes a picture the scenes use, by the name "hero".
class Boot extends Phaser.Scene {
  create() {
    this.registry.set("hero", hero)
    this.textures.addCanvas("hero", hero.canvas)
    this.scene.start("title")
  }
}

document.title = config.title
window.game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: config.background,
  scale: { mode: Phaser.Scale.RESIZE },
  physics: { default: "arcade" },
  scene: [Boot, Title, Play],
})
