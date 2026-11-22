// A round: the hero follows the pointer and collects what falls. 20 seconds.
import { drawCity, font } from "./city.js"
import { config } from "./config.js"
import { add } from "./score.js"
const roundMs = 20_000

export class Play extends Phaser.Scene {
  constructor() {
    super("play")
  }

  create() {
    const { width, height } = this.scale
    drawCity(this)
    this.score = 0
    this.last = 0
    this.hero = this.physics.add.image(width / 2, height * 0.8, "hero")
    this.hero.setScale(110 / this.hero.height)
    this.hero.body.setCircle(this.hero.width * 0.3, this.hero.width * 0.2, this.hero.height * 0.2)
    this.pickups = this.physics.add.group()
    this.physics.add.overlap(this.hero, this.pickups, (_hero, pickup) => this.collect(pickup))

    const text = { fontFamily: font, color: config.accent, fontStyle: "bold", fontSize: 24, padding: 12 }
    this.scoreText = this.add.text(8, 2, "SCORE 0", text).setShadow(0, 0, config.accent, 10, false, true)
    this.timeText = this.add.text(width - 8, 2, "", text).setOrigin(1, 0)
    this.timeText.setShadow(0, 0, config.accent, 10, false, true)
    // The score and the time stay over what falls.
    this.scoreText.setDepth(1)
    this.timeText.setDepth(1)

    this.time.addEvent({ delay: 450, loop: true, callback: () => this.drop() })
    this.time.delayedCall(roundMs, () => this.scene.start("title", { last: this.score }))
    this.ends = this.time.now + roundMs
  }

  // A pickup falls from a random place along the top.
  drop() {
    const x = Phaser.Math.Between(40, this.scale.width - 40)
    const pickup = this.add.text(x, -30, config.pickup, { fontSize: 40 }).setOrigin(0.5)
    this.pickups.add(pickup)
    pickup.body.setVelocity(Phaser.Math.Between(-40, 40), Phaser.Math.Between(150, 260))
  }

  collect(pickup) {
    this.score = add(this.score, this.time.now - this.last)
    this.last = this.time.now
    this.scoreText.setText("SCORE " + this.score)
    pickup.body.enable = false
    this.tweens.add({
      targets: pickup,
      scale: 2,
      alpha: 0,
      duration: 200,
      onComplete: () => pickup.destroy(),
    })
  }

  update(time) {
    this.registry.get("hero").draw(time)
    this.textures.get("hero").refresh()
    // The hero glides toward the pointer.
    const pointer = this.input.activePointer
    this.hero.x += (pointer.x - this.hero.x) * 0.15
    this.hero.y += (pointer.y - this.hero.y) * 0.15
    this.timeText.setText("TIME " + Math.max(0, Math.ceil((this.ends - time) / 1000)))
    for (const pickup of this.pickups.getChildren())
      if (pickup.y > this.scale.height + 40) pickup.destroy()
  }
}
