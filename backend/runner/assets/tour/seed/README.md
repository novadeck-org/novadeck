# Your game

A small browser game, started by Novadeck's tour, set in a neon city at night: a hero collects
what falls, 20 seconds a round. [Phaser](https://phaser.io) runs the game, and [three.js](https://threejs.org) draws its
hero from a 3D model.

## Run it

```sh
node dev.mjs        # or: python3 dev.py
```

Then open http://127.0.0.1:5180/ (or name a port: `node dev.mjs 3000`). The dev server lays the
work of every git worktree of this repo over this folder, so the page shows all of it at once,
before any of it is merged, and reloads when a file changes. Where two worktrees change the
same file, the page shows the one changed last.

## What is where

- `src/config.js`: the game's name, its hero, what the hero collects, and the colours (the night
  sky, and the city's neon).
- `model/hero.gltf`: the hero, a 3D model built of ready shapes. `model/README.md` says how to
  reshape it.
- `src/hero.js`: three.js draws the model, turning, as the hero's picture.
- `src/city.js`: the city behind the game: buildings, lit windows, rain.
- `src/title.js`, `src/play.js`: the start screen and a round, as Phaser scenes.
- `src/score.js`: how a pickup scores.
- `art/cover.svg`: the backdrop of the start screen. Optional: it shows once it is there.
- `vendor/`: Phaser and three.js as files, kept out of git.

## Known bug

The score never goes up: `add()` in `src/score.js` works the new score out and throws it away.
