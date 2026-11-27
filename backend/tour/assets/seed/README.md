# Your game

A start for a browser game. Nothing of the game is built yet: the page shows the kit's showcase,
which the game replaces.

## The stack

Plain JavaScript modules, no build step and nothing to install: save a file and the page shows
it.

- **The kit** (`kit/`, read `kit/README.md`): ready parts that make a game look and sound
  finished from its first minute: a stage with bloom and post-processing, cameras, skies and
  grounds, particles, juice (shake, hit-stop, tweens), shapes, shader materials, sound effects
  and music made in code, title, HUD and end screens, and input. Build on it.
- [three.js](https://threejs.org) r187, which the kit runs on: `import * as THREE from "three"`.
  Of its addons only these are here: `three/addons/loaders/GLTFLoader.js`,
  `three/addons/utils/BufferGeometryUtils.js` and `three/addons/utils/SkeletonUtils.js`. The
  kit has its own cameras, controls and post-processing in their place.
- [Phaser](https://phaser.io) 3.90 for a 2D game: the global `Phaser`, already loaded by
  `index.html`.

## What is where

- `index.html`: the page. It loads `src/main.js` into `<div id="game">`.
- `src/main.js`: the kit's showcase. Replace it with the game, and add more files beside it.
- `kit/`: the kit. `kit/README.md` lists every part and how to call it.
- `src/models.js`: loads a model from `models/`, for a 3D scene or as a picture for a 2D game.
- `models/`: glTF models, short text files built of ready shapes. `models/README.md` says how to
  make one. `placeholder.gltf` is one.
- `src/style.css`: the page's own style (a full-window game).
- `vendor/`: three.js and Phaser as files, kept out of git.

## Run it

```sh
node dev.mjs        # or: python3 dev.py
```

Then open http://127.0.0.1:5180/ (or name a port: `node dev.mjs 3000`). The page reloads by
itself when a file changes. The dev server lays the work of every git worktree of this repo over
this folder, so the page shows all of it at once, before any of it is merged. Where two worktrees
change the same file, the page shows the one changed last.
