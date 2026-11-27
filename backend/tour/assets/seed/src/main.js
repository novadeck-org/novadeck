// The page before the game exists: an attract-mode scene that uses the whole kit. The camera
// drifts, the look changes every 8 s, a glowing hero turns inside a force field. Replace this
// file with the game: copy what you need from here (the imports are the pattern to follow).
import * as THREE from "three"
import { createStage } from "../kit/stage.js"
import { createSky } from "../kit/sky.js"
import { createGround } from "../kit/ground.js"
import * as materials from "../kit/materials.js"

// The rest of the kit loads on its own so a missing part never blanks the page. In a game,
// plain `import { createParticles } from "../kit/particles.js"` lines are what you want.
const [{ createParticles }, { createJuice }, { createUI }, { createAudio }, shapes] = await Promise.all(
  ["particles", "juice", "ui", "audio", "shapes"].map((f) => import(`../kit/${f}.js`).catch(() => ({}))),
)

// Each scene: a look, a ground, weather, scenery, and what the hero is made of.
const SCENES = [
  { look: "neon", kind: "grid", prop: "building", weather: null, hero: "hologram", stars: true },
  { look: "dusk", kind: "water", prop: "rock", weather: "fireflies", hero: "rim" },
  { look: "ember", kind: "lava", prop: "crystal", weather: "embers", hero: "dissolve" },
  { look: "frost", kind: "snow", prop: "crystal", weather: "snow", hero: "toon", clouds: false },
  { look: "meadow", kind: "terrain", prop: "tree", weather: "dust", hero: "rim" },
]

const stage = createStage({ look: SCENES[0].look, camera: "orbit" })
const fx = createParticles?.(stage)
const juice = createJuice?.(stage)
const audio = createAudio?.()
let ui, world, hero, aura, ff, scene

const dispose = (root) => root.traverse((n) => { n.geometry?.dispose?.(); n.material?.dispose?.() })

function show(i) {
  scene = SCENES[i % SCENES.length]
  const { look } = scene
  if (world) { stage.scene.remove(world); dispose(world); aura?.stop?.() }
  stage.setLook(look)
  world = new THREE.Group()
  stage.scene.add(world)
  world.add(createSky({ look, stars: scene.stars, aurora: scene.aurora, clouds: scene.clouds }))
  const ground = createGround({ look, kind: scene.kind, height: 5 })
  world.add(ground)

  // scenery on a ring, standing on the ground
  for (let k = 0; k < 26; k++) {
    const a = k * 2.4, r = 15 + (k % 5) * 5 + Math.random() * 3
    const prop = shapes[scene.prop]?.({ look })
    if (!prop) break
    prop.scale.setScalar((scene.prop === "building" ? 0.8 : 1.4) * (1 + Math.random()))
    prop.position.set(Math.cos(a) * r, ground.heightAt(Math.cos(a) * r, Math.sin(a) * r), Math.sin(a) * r)
    prop.rotation.y = Math.random() * 6.28
    prop.traverse((n) => { if (n.isMesh) n.castShadow = true })
    world.add(prop)
  }

  // the hero: a knot made from one of the kit's materials, inside a force field
  const material = { hologram: materials.hologram, rim: materials.rim, dissolve: materials.dissolve, toon: materials.toon }[scene.hero]({ look })
  hero = new THREE.Mesh(new THREE.TorusKnotGeometry(0.9, 0.3, 160, 20), material)
  hero.castShadow = true
  if (scene.hero === "toon") materials.outline(hero)
  ff = new THREE.Mesh(new THREE.SphereGeometry(2.1, 48, 32), materials.forcefield({ look }))
  hero.add(ff)
  for (let k = 0; k < 6; k++) {
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), materials.glow({ look, color: k % 2 ? undefined : "#ffffff", intensity: 3 }))
    orb.userData.k = k
    world.add(orb)
  }
  world.add(hero)
  aura = fx?.emitter("aura", hero)
  fx?.weather(scene.weather)

  ui?.root?.remove()
  ui = createUI?.({ look })
  ui?.prompt("Your game starts here")
  ui?.toast(`${look} · ${scene.kind}`)
  stage.post.flash(0xffffff, 0.7)
  stage.post.pulse(1)
  audio?.play("select", { volume: 0.4 })
}

let index = Number(new URLSearchParams(location.search).get("scene")) || 0, since = 0, beat = 0
show(index)
addEventListener("pointerdown", () => audio?.music("ambient"), { once: true })

stage.onFrame((dt, time) => {
  // slow camera drift
  stage.cam.yaw += dt * 0.07
  stage.cam.pitch = 0.3 + Math.sin(time * 0.2) * 0.08
  stage.cam.distance = 17 + Math.sin(time * 0.15) * 3
  stage.cam.target.set(0, 2.4, 0)

  // the hero turns and bobs; the orbs circle it; the dissolve breathes
  hero.position.y = 2.5 + Math.sin(time * 1.3) * 0.25
  hero.rotation.set(time * 0.4, time * 0.7, 0)
  if (scene.hero === "dissolve") hero.material.amount = 0.2 + Math.sin(time * 1.1) * 0.15
  world.children.forEach((orb) => {
    if (orb.userData.k === undefined) return
    const a = time * (0.9 + orb.userData.k * 0.12) + orb.userData.k, r = 3.2 + (orb.userData.k % 3) * 0.5
    orb.position.set(Math.cos(a) * r, 2.5 + Math.sin(a * 1.7) * 1.1, Math.sin(a) * r)
  })

  // a beat every 2.5 s: a ripple, a burst, a squash; a new scene every 8 s
  beat += dt
  if (beat > 2.5) {
    beat = 0
    ff.material.hit(new THREE.Vector3(Math.cos(time) * 2.2, hero.position.y + 0.8, Math.sin(time) * 2.2))
    fx?.burst(Math.random() > 0.5 ? "magic" : "pickup", hero.position)
    juice?.punch(hero, 1.18)
  }
  since += dt
  if (since > 8) { since = 0; show(++index) }
})
