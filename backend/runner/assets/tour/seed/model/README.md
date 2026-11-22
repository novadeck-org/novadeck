# Sculpting the hero

`hero.gltf` is a glTF model built of four ready shapes, whose geometry is in `shapes.bin`. Each
shape fits a 1 x 1 x 1 box centred on its own origin, and y is up. A shape is named by the three
numbers of its primitive:

| Shape              | Primitive                                              |
| ------------------ | ------------------------------------------------------ |
| box                | `{"attributes":{"POSITION":0,"NORMAL":1},"indices":2}` |
| sphere             | `{"attributes":{"POSITION":3,"NORMAL":4},"indices":5}` |
| cone (point up)    | `{"attributes":{"POSITION":6,"NORMAL":7},"indices":8}` |
| cylinder (axis up) | `{"attributes":{"POSITION":9,"NORMAL":10},"indices":11}` |

To reshape the hero, replace everything in `hero.gltf` from `"materials"` to the end of the file,
in one edit, and leave the lines above it (`asset`, `buffers`, `bufferViews`, `accessors`,
`scene`) exactly as they are. What you write:

- `"materials"`: one per colour, as
  `{"name":"red","pbrMetallicRoughness":{"baseColorFactor":[0.9,0.2,0.2,1],"metallicFactor":0,"roughnessFactor":0.7}}`.
- `"meshes"`: one per pair of shape and colour you use: the shape's primitive with a `material`
  (the colour's place in `materials`, counted from 0), as
  `{"name":"red box","primitives":[{"attributes":{"POSITION":0,"NORMAL":1},"indices":2,"material":0}]}`.
- `"nodes"`: one per part, as
  `{"name":"body","mesh":0,"translation":[x,y,z],"scale":[sx,sy,sz]}`, where `mesh` is the
  mesh's place in `meshes`. Only where a part must tilt, add `"rotation":[x,y,z,w]`, a unit
  quaternion.
- `"scenes"`: `[{"nodes":[0,1,2,...]}]`, listing every node's number, from 0 to the last.

End the file with `}` as it ends now.

What makes a good hero: 6 to 14 parts; it stands on the ground (y = 0) and is about 2 units
tall; parts touch or overlap, none floats apart; bright, friendly colours; it reads at a glance.
