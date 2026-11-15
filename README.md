# threejstest

A stylized, fully procedural pond scene built with [three.js](https://threejs.org/) and Vite.
No textures, models or CDN links: every shape, colour and the sky are generated in code.

```bash
npm install
npm run dev      # start the dev server
npm run build    # production build into dist/
```

Drag to orbit, scroll to zoom, right-drag to pan.

## Reusing the pond

`src/pond.js` exports `createPond(options)`, which returns a `THREE.Group` centred on the
pond at ground level (y = 0).

```js
import { createPond } from './pond.js';

const pond = createPond({ size: 10, lilyPads: 8 });
scene.add(pond);

// once per frame, with the elapsed time in seconds
pond.userData.update(elapsed);

// when removing it for good
pond.userData.dispose();
```

| Option | Default | Description |
| --- | --- | --- |
| `size` | `10` | Approximate diameter of the water, in world units. Everything scales with it. |
| `lilyPads` | `7` | Number of lily pads (fewer are placed if they cannot all fit). |
| `rocks` | `26` | Number of rocks around the shore. |
| `reeds` | `45` | Number of reed clumps; `0` for none. |
| `reedAngle` | `0.8π` | Direction of the reed bed from the pond centre, in radians in the XZ plane. |
| `seed` | `1` | Layout seed; the same seed always gives the same pond. |
| `sunDirection` | up and behind | `THREE.Vector3` pointing towards the sun, used for the water highlights. |
| `grassColor` | `#86b35a` | Colour of the outer bank; match it to your ground. |
| `reflectionResolution` | `1024` | Size of the water's reflection texture. |

The water uses a custom shader (animated ripples, shoreline foam, sun glints) on top of a
planar reflection, so it mirrors whatever else is in your scene. It respects `scene.fog`.

`src/sky.js` exports `createSkyTexture(options)`, a procedural equirectangular sky for
`scene.background`.
