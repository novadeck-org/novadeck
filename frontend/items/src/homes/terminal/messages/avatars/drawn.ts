// The handle words' critters: an 8×8 sprite drawn for each word the runner gives a
// terminal (`backend/runner/src/terminals/handles.ts`), in the same order, which is the
// word's rank. Rows go top to bottom, split by `/`: `#` lit, `+` dim, `o` bright, `x` a
// dark eye (lidded when it blinks), `e` a bright eye (out when it blinks), `.` unlit.
export const drawnCritters: readonly (readonly [word: string, rows: string])[] = [
  // Antennae, lit forewings, dim hindwings.
  ["moth", ".#....#./..#..#../##.##.##/##x##x##/########/.+####+./++.##.++/+..##..+"],
  // Pointed ears, face narrowing to a snout.
  ["fox", "#......#/##....##/########/#x####x#/########/+######+/..####../...##..."],
  // Ear tufts, big eyes, dim beak and belly.
  ["owl", "##....##/.######./#xx##xx#/###++###/.######./.#++++#./.######./..#..#.."],
  // Sleek side-view bird.
  ["crow", "......../..###.../##x###../..#####./..######/...#####/....#..#/...##..."],
  // Raptor with spread wings, hooked beak, forked tail.
  ["kite", "..####../.#x##x#./###++###/########/##.##.##/#..##..#/..####../.##..##."],
  // Big bird, heavy beak.
  ["raven", "...###../..####../###x###./##.#####/..######/..######/...##.##/...#.#.."],
  // Setting sun on the horizon, dim reflection.
  ["dusk", ".#.##.#./......../..####../.#x##x#./########/++++++++/.++++++./..+..+.."],
  // Lightning bolt with eyes.
  ["volt", "..######/.######./#x##x#../########/...####./..###.../.##...../#......."],
  // Soft glowing blob dissolving into haze bands.
  ["haze", "......../..++++../.+####+./+#x##x#+/+######+/.+####+./++.++.++/.++.++.+"],
  // Tufted ears, cheek ruffs.
  ["lynx", "#......#/#......#/##....##/########/##x##x##/########/+##++##+/++.##.++"],
  // Small weasel, long body, bushy tail.
  ["sable", "......../.#.#..../#####.../#x###.++/#######+/.#######/.##..##./.#...#.."],
  // Gem critter with a bright glint.
  ["glint", "......../..####.o/.#o####./########/#x####x#/.######./..####../...##..."],
  // Feather quill with eyes, nib at the bottom.
  ["quill", ".....###/....####/...#x#x#/..#####./.+####../.###+.../.#....../#......."],
  // Dark hooded shadow with bright eyes.
  ["umbra", "...++.../..++++../.++..++./++e..e++/++....++/+++..+++/++++++++/+.+.+.+."],
  // Round bird with a big curling topknot plume.
  ["plume", ".###..../##+##.../...##.../..#####./.#x##x#./.######./..####../..#..#.."],
  // Flame creature with white-hot core.
  ["blaze", "...#..#./..##.##./.#####.#/########/#x####x#/###oo###/##+oo+##/.######."],
  // Fedora, eyes in shadow, trench-coat collar.
  ["noir", "..####../..#++#../########/..e..e../......../.##..##./###..###/###..###"],
  // Floating haloed will-o'-the-wisp.
  ["wisp", "...+..../...#+.../..+##+../.+####+./.#x##x#./.+####+./..+##+../...++..."],
  // Black-cat imp with grin and hooked tail.
  ["jinx", "#...#.../#####.../#x#x#..#/#####.#./.###...#/#####..#/######.#/#######."],
  // Spiny cactus in a pot.
  ["thorn", "+..##..+/..####../#.####.#/#.x##x.#/########/+.####.+/..####../.######."],
  // Daisy face: petals round a dim centre, on a leafy stem.
  ["aster", ".#.##.#./##++++##/.#e++e#./##++++##/.#.##.#./...##.../.##.#.../...##..."],
  // Carved dark-wood tiki idol with grain cuts.
  ["ebony", ".######./#++++++#/##x##x##/###++###/########/#++++++#/########/.#.##.#."],
  // Wading bird, long down-curved beak.
  ["ibis", "..###.../.#x##.../#...##../#..#####/...#####/....####/....#.#./...##.##"],
  // Glowing atom in a dim orbit.
  ["xenon", "......o./.++++++./+.####.+/+.x##x.+/+.####.+/+..##..+/.++++++./........"],
  // Tall peaked critter with a star at its tip.
  ["zenith", "...oo.../...##.../..####../.######./##x##x##/########/.######./.#....#."],
  // Charred coal lump with glowing cracks and a white-hot core.
  ["cinder", "...#..../.#....#./..++++../.+e++e+./++#+++#+/+##o#+++/++++##++/.++++++."],
  // Round head streaking down with a long tail.
  ["comet", "#+....../+##+..../.+###+../..+####./...#####/...#x#x#/...#####/....###."],
  // Snowflake critter with six spiky arms.
  ["frost", "#..##..#/.#.##.#./..####../##x##x##/..####../.#.##.#./#..##..#/...##..."],
  // Fierce raptor, hooked beak, talons.
  ["hawk", "#.####.#/##x##x##/###++###/####+###/.######./..####../..#..#../.##..##."],
  // Soft drifting fog blob trailing wisps.
  ["mist", "......../..++++../.+####+./+#x##x#+/+######+/.++++++./++.++++./....+++."],
  // Dark banded stone, bright eyes.
  ["onyx", "..####../.#++++#./#++++++#/#+e++e+#/#++++++#/########/.#++++#./..####.."],
  // Creature split down the middle by a jagged crack.
  ["rift", ".##..##./###.####/#x#.##x#/###..###/####.###/###.####/###..###/.#....#."],
  // Masked bandit bird, hooked beak, on a branch.
  ["shrike", "...###../..#####./.#..e.##/.#####.#/######../+#####../+..#.#../++######"],
  // Steam puff with smaller puffs rising off it.
  ["vapor", ".++...../.++.##../...####./....##../.######./##x##x##/########/.##..##."],
  // Banded star cloud with stars drifting round it.
  ["nebula", ".o..##.o/..+####./.#####++/##x##x##/++######/.######./o.+##+../....+..o"],
  // Lantern with a flame in its glass.
  ["lantern", "...##.../..#..#../########/.#x##x#./.#+oo+#./.#+oo+#./########/.#....#."],
  // Critter braced against streaming wind.
  ["gale", "...++##./+++.####/...#x#x#/++.#####/...#####/+++.###./....###./...##.##"],
  // Tall wading bird, long neck and legs.
  ["heron", "..###.../##x##.../...##.../...###../...#####/....####/....#.#./....#.#."],
  // Carved jade dragon, horns and spiky back.
  ["jade", "...#.#../.#####../##x###.#/..####+#/..######/...#####/..##.#+#/.##.##++"],
  // Spotted carp, side view, fanned tail.
  ["koi", "......../..###.../.#####.#/#x#++###/###++###/######.#/.####.../..+..+.."],
  // Long fish, snout right, a tooth.
  ["pike", "......../......../...##.../#.#####./######x#/#.#####o/...#.#../........"],
  // Crystal cluster: three shards on a rock body.
  ["quartz", "...##.../.#.##.#./.#.#o.#./##+##+##/########/##x##x##/########/.######."],
  // Small songbird with white speckles.
  ["starling", "......../...###../...#x###/..####../##o###../#####o#./..####../...#.#.."],
  // Squat flat-headed bird with a wide gape.
  ["nightjar", "......../......../.######./#x####x#/##....##/#+####+#/+######+/..#..#.."],
  // Chipped stone throwing a spark.
  ["flint", "......o./..##.o.o/.####.../######+./#x##x#++/+######+/#+####+#/.######."],
  // Eyes shut, finger to its lips.
  ["hush", "......../.######./########/#xx##xx#/###++###/#..++..#/##++++##/.#++++#."],
  // Glowing light-bulb creature.
  ["lumen", "o.####.o/.######./##x##x##/###oo###/.######./..####../..++++../...++..."],
  // Round iridescent gem with a shine.
  ["opal", "......../..####../.o#++##./#o#####+/##x##x++/#++###+#/.##++##./..####.."],
  // Spider dangling on its thread.
  ["silk", "...++.../...++.../#.####.#/.######./##x##x##/.######./#.####.#/#......#"],
  // Walrus with long white tusks.
  ["tusk", "......../..####../.#x##x#./########/##++++##/##o##o##/#.o..o.#/#.o..o.#"],
  // Evening bell with a star beside it.
  ["vesper", "...##..o/..####../.#x##x#./.######./.######./########/##++++##/...oo..."],
  // Sturdy little robot.
  ["cobalt", "...oo.../...++.../.######./.#x##x#./+######+/+#++++#+/.######./.##..##."],
  // Small crow with a pale grey nape.
  ["jackdaw", "......../..###+../##x#++../..####../..#####./...#####/....####/...#.#.."],
  // Rain cloud.
  ["nimbus", "......../..##.##./.#######/##x##x##/########/.######./..#..#../.#..#..#"],
  // Egg-shaped creature bearing a glowing rune.
  ["sigil", "...##.../..####../.#x##x#./########/###o####/##o#o###/###o####/.######."],
  // Creature flashing light rays.
  ["strobe", "o..oo..o/.o.##.o./..####../o#x##x#o/o######o/..####../.o.##.o./o......o"],
  // Spiky soot sprite with big eyes.
  ["soot", "..#..#../#.####.#/.######./#ox##xo#/.######./########/.######./.#.##.#."],
  // Wide-eyed watcher holding a candle.
  ["vigil", "#....#../######.o/#x##x#.o/#x##x#.#/######.#/########/######.#/.#..#.##"],
  // Low drifting fog blob.
  ["fog", "......../......../++..+++./..+####+/.+#x##x#/+#######/++++####/+.++.+++"],
  // Banded stone.
  ["agate", "......../...###../.######./#x####x#/++++++++/########/++++++++/########"],
  // Arcade cabinet robot, screen face, buttons.
  ["arcade", "..####../########/#.e..e.#/#......#/########/#o####+#/.######./.##..##."],
  // Plump sea duck, side view.
  ["eider", "......../.###..../##x#..../+###...#/.###.###/########/########/.######."],
  // Crescent moon creature with a music note.
  ["nocturne", "..##..../.##..##./##...#.#/#x...#../##..##../##..##../.##...../..###..."],
  // Tangled thorny bush.
  ["bramble", "#.#..#.#/.##.###./#+####+#/##x##x##/+######+/#.####.#/.#+##+#./#..##..#"],
  // Rose bloom face on a thorny stem with a leaf.
  ["briar", "..####../.#+##+#./#x####x#/.######./..####../#..##.../##.##.##/...##..."],
  // Spiky tuft over a round bulb, spiky leaves.
  ["thistle", "#.#..#.#/.#.##.#./..####../+######+/.#x##x#./..####../#..##..#/.#.##.#."],
  // Long low weasel, side view, tail up.
  ["mink", "......../......../.......#/.##...##/#x#####./+######./..#####./.##...##"],
  // Upright weasel, tail with dark tip.
  ["stoat", ".#..#.../.####.../.x##x.../..##..++/..###.#./.####.#./.####.#./.#..###."],
  // Huge bright eyes in dark rings, on a branch.
  ["loris", ".#....#./########/#..##..#/#.e##e.#/#.e##e.#/.######./##.##.##/########"],
  // Long snout, tall ear, tail down.
  ["coyote", "...#..../..###.../###x#.../.####.../..######/..######/..#..#.+/..#..#.+"],
  // Salamander from above, legs out, tail.
  ["newt", "...##.../..x##x../##.##.##/..####../..####../##.##.##/....#.../.....#.."],
  // Big cat, side view, tail up.
  ["panther", "......../.#.#..../####...#/#x####.#/+#######/.#######/.##..##./.##..##."],
  // Masked cat-like, banded tail.
  ["civet", "......../......#./#....###/+...#x+#/#.######/+#######/.######./..#..#.."],
  // Power pylon, two crossarms, light on top.
  ["pylon", "...oo.../+######+/.#x##x#./..####../+######+/..#..#../.#.##.#./##....##"],
  // Rock columns of different heights.
  ["basalt", "...###../...###../++.###../++.x#x.#/++.###.#/++.###.#/++.###.#/++.###.#"],
  // Faceted gem: flat crown, pointed base.
  ["garnet", "......../.######./#o#++#+#/########/.#x##x#./..####../..+##+../...##..."],
  // Plush teddy, soft muzzle.
  ["velvet", ".##..##./########/########/##x##x##/###++###/.##++##./.######./.##..##."],
  // Sun half-sunk with a star.
  ["twilight", "......o./......../..####../.######./##x##x##/########/++++++++/.++..++."],
  // Record with label face and hole.
  ["vinyl", "..####../.#++++#./#+x##x+#/#+#..#+#/#+#..#+#/#+####+#/.#++++#./..####.."],
  // Small blob among sparkles.
  ["glimmer", "o....o../......../..####../.#x##x#o/.######./.######./o.####../..#..#.."],
  // Eyes peering out of murky water.
  ["murk", "......../...##.../..####../.#e##e#./.######./++++++++/.+.++.+./+.+..+.+"],
  // Heavy smog cloud, dripping.
  ["smog", "......../..##.##./.#######/########/#x##x###/+######+/.++++++./..+..+.."],
  // Small cloud dropping ice pellets.
  ["sleet", ".######./########/#x####x#/.######./..o..o../o...o.../...o...o/.o...o.."],
  // Cup with eyes in the dregs.
  ["dregs", "......../#......#/#......#/#......#/#+x++x+#/#++++++#/.######./..####.."],
  // Boxy mech: antennae, visor eyes, legs.
  ["mech", ".#....#./.######./##e##e##/########/.#++++#./.######./.##..##./##....##"],
  // Round little vole, tail behind.
  ["vole", "......../......../.##...../#x####../#######./.#######/..######/.+..+.++"],
  // Long-snouted shrew, bright nose.
  ["shrew", "......../......../....###./...#####/o#x#####/.#######/..######/..+..+.+"],
  // Candle whose wick is lit.
  ["wick", "...o..../..ooo.../...o..../...+..../.######./.#x##x#./.######./.######."],
  // Corn cob peeking out of its husk.
  ["husk", "+..##..+/+.####.+/.+#x#x+./.+####+./.+####+./..+##+../..+##+../...++..."],
  // Fizzy drop sending up bubbles.
  ["fizz", ".o...o../...o...o/o.o..o../.######./#x####x#/########/#++++++#/.######."],
  // Front-on rook, one bright lens eye, pale beak.
  ["rook", "..#..#../.######./#oeo##x#/##o#####/.##++##./.######./#.####.#/..#..#.."],
  // Hexagon with a glyph between its eyes.
  ["hex", "..####../.#....#./#.x..x.#/#......#/#.+##+.#/#......#/.#....#./..####.."],
  // Straw hat, sword at its side.
  ["ronin", "...##.../.######./########/..#x#x#./..####../.######o/.#.##.o./...##o.."],
  // Pale egret, plumes and a dark bill.
  ["egret", ".+....../..+ooo../...oxoo#/...oo.../..ooo.../.ooooo../..oooo../...o.o.."],
]
