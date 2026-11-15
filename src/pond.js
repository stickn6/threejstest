import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// All shapes are authored in "pond units": the pond is 10 units across and
// everything is scaled by size / 10, so proportions hold at any size.
const POND_RADIUS = 5;
const WATER_LEVEL = 0.12;
const RIM_HEIGHT = 0.28;
const RIM_AT = 0.9; // distance from the shore to the top of the bank
const BANK_WIDTH = 3.6; // distance from the shore to where the bank meets the ground
const BANK_EDGE = 0.004; // the bank flattens out a hair above y = 0 to sit on a ground plane
const BED_LEVEL = 0.015;
const SHORE_FREQ = [2, 3, 5];
const TAU = Math.PI * 2;

const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise2D(seed) {
  const hash = (ix, iz) => {
    const s = Math.sin(ix * 127.1 + iz * 311.7 + seed * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  return (x, z) => {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const wx = fx * fx * (3 - 2 * fx), wz = fz * fz * (3 - 2 * fz);
    return lerp(
      lerp(hash(ix, iz), hash(ix + 1, iz), wx),
      lerp(hash(ix, iz + 1), hash(ix + 1, iz + 1), wx),
      wz,
    );
  };
}

function setVertexColors(geometry, colorAt) {
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    colorAt(p.fromBufferAttribute(pos, i), c);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

// ---------------------------------------------------------------------------
// Shoreline and terrain (pond units, y up, theta = atan2(z, x))
// ---------------------------------------------------------------------------

function makeShore(rand) {
  const amp = [0.1, 0.06, 0.035].map((a) => a * (0.6 + rand() * 0.6));
  const phase = [rand() * TAU, rand() * TAU, rand() * TAU];
  const radiusAt = (theta) => {
    let k = 1;
    for (let i = 0; i < 3; i++) k += amp[i] * Math.sin(SHORE_FREQ[i] * theta + phase[i]);
    return POND_RADIUS * k;
  };
  return { amp, phase, radiusAt };
}

function makeTerrain(shore, noise) {
  // s is the signed distance from the shoreline, negative under water.
  const heightAtShoreDistance = (s, x, z) => {
    if (s <= 0) return Math.max(BED_LEVEL, WATER_LEVEL + s * 0.45);
    const k = 1 - Math.min(s / RIM_AT, 1);
    const rise = 1 - k * k;
    const fall = smoothstep(RIM_AT, BANK_WIDTH, s);
    const bumps = smoothstep(0.15, 0.8, s) * (1 - smoothstep(BANK_WIDTH * 0.6, BANK_WIDTH, s));
    return (
      lerp(lerp(WATER_LEVEL, RIM_HEIGHT, rise), BANK_EDGE, fall) +
      (noise(x * 0.9, z * 0.9) - 0.5) * 0.09 * bumps
    );
  };
  const shoreDistance = (x, z) => Math.hypot(x, z) - shore.radiusAt(Math.atan2(z, x));
  const heightAt = (x, z) => heightAtShoreDistance(shoreDistance(x, z), x, z);
  return { heightAtShoreDistance, shoreDistance, heightAt };
}

function createBank(shore, terrain, noise, palette) {
  const segments = 128;
  const rings = [-0.9, -0.5, -0.25, -0.1, 0, 0.1, 0.22, 0.38, 0.55, 0.75, 0.95, 1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 3.0, 3.3, BANK_WIDTH];
  const positions = [];
  const colors = [];
  const indices = [];
  const sand = new THREE.Color(palette.sand);
  const wetSand = sand.clone().multiplyScalar(0.62);
  const grass = new THREE.Color(palette.grass);
  const c = new THREE.Color();

  for (let j = 0; j < segments; j++) {
    const theta = (j / segments) * TAU;
    const shoreRadius = shore.radiusAt(theta);
    for (let i = 0; i < rings.length; i++) {
      const s = rings[i];
      const x = Math.cos(theta) * (shoreRadius + s);
      const z = Math.sin(theta) * (shoreRadius + s);
      positions.push(x, terrain.heightAtShoreDistance(s, x, z), z);

      if (i === rings.length - 1) {
        c.copy(grass); // exact match with the surrounding ground
      } else if (s <= 0) {
        c.lerpColors(sand, wetSand, smoothstep(0, -0.3, s));
      } else {
        const n = noise(x * 1.6 + 9.2, z * 1.6 - 4.1);
        c.lerpColors(sand, grass, smoothstep(0.2, 0.95, s + (n - 0.5) * 0.45));
        c.multiplyScalar(0.94 + 0.12 * noise(x * 3.1, z * 3.1) * (1 - smoothstep(1.8, BANK_WIDTH, s)));
      }
      colors.push(c.r, c.g, c.b);
    }
  }
  for (let j = 0; j < segments; j++) {
    const a = j * rings.length;
    const b = ((j + 1) % segments) * rings.length;
    for (let i = 0; i < rings.length - 1; i++) {
      indices.push(a + i, b + i, b + i + 1, a + i, b + i + 1, a + i + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // Flat normals on the outer edge so the bank shades exactly like the ground it meets.
  for (let j = 0; j < segments; j++) geometry.attributes.normal.setXYZ(j * rings.length + rings.length - 1, 0, 1, 0);

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }),
  );
  mesh.name = 'bank';
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

const waterShader = {
  name: 'PondWaterShader',

  uniforms: {
    ...THREE.UniformsLib.fog,
    color: { value: null }, // set by Reflector, unused
    tDiffuse: { value: null }, // planar reflection, set by Reflector
    textureMatrix: { value: null }, // set by Reflector
    uTime: { value: 0 },
    uUnit: { value: 1 },
    uShoreAmp: { value: new THREE.Vector3() },
    uShorePhase: { value: new THREE.Vector3() },
    uShallowColor: { value: new THREE.Color() },
    uDeepColor: { value: new THREE.Color() },
    uFoamColor: { value: new THREE.Color() },
    uSunColor: { value: new THREE.Color() },
    uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    uReflectivity: { value: 1 },
  },

  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    uniform float uUnit;

    varying vec4 vReflectionUv;
    varying vec3 vWorldPosition;
    varying vec2 vPond;
    varying vec3 vAxisX;
    varying vec3 vAxisY;
    varying vec3 vAxisZ;

    #include <common>
    #include <fog_pars_vertex>
    #include <logdepthbuf_pars_vertex>

    void main() {
      vReflectionUv = textureMatrix * vec4( position, 1.0 );
      vPond = position.xy / uUnit;

      mat3 basis = mat3( modelMatrix );
      vAxisX = normalize( basis[ 0 ] );
      vAxisY = normalize( basis[ 1 ] );
      vAxisZ = normalize( basis[ 2 ] );

      vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
      vWorldPosition = worldPosition.xyz;
      vec4 mvPosition = viewMatrix * worldPosition;
      gl_Position = projectionMatrix * mvPosition;

      #include <logdepthbuf_vertex>
      #include <fog_vertex>
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec3 uShoreAmp;
    uniform vec3 uShorePhase;
    uniform vec3 uShallowColor;
    uniform vec3 uDeepColor;
    uniform vec3 uFoamColor;
    uniform vec3 uSunColor;
    uniform vec3 uSunDirection;
    uniform float uReflectivity;

    varying vec4 vReflectionUv;
    varying vec3 vWorldPosition;
    varying vec2 vPond;
    varying vec3 vAxisX;
    varying vec3 vAxisY;
    varying vec3 vAxisZ;

    #include <common>
    #include <fog_pars_fragment>
    #include <logdepthbuf_pars_fragment>

    const float POND_RADIUS = ${POND_RADIUS.toFixed(1)};
    const int RING_COUNT = 5;

    float hash11( float n ) { return fract( sin( n * 127.1 ) * 43758.5453 ); }
    vec2 hash21( float n ) { return fract( sin( vec2( n * 127.1, n * 269.5 + 183.3 ) ) * 43758.5453 ); }
    float hash12( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }

    float vnoise( vec2 p ) {
      vec2 i = floor( p );
      vec2 f = fract( p );
      vec2 w = f * f * ( 3.0 - 2.0 * f );
      return mix(
        mix( hash12( i ), hash12( i + vec2( 1.0, 0.0 ) ), w.x ),
        mix( hash12( i + vec2( 0.0, 1.0 ) ), hash12( i + vec2( 1.0, 1.0 ) ), w.x ),
        w.y
      );
    }

    // Expanding ring ripples, as if something touched the surface. Each
    // emitter picks a new random spot every time its ring has faded out.
    float rings( vec2 q, float t ) {
      float h = 0.0;
      for ( int i = 0; i < RING_COUNT; i ++ ) {
        float fi = float( i );
        float period = 4.0 + 2.5 * hash11( fi + 3.1 );
        float cycle = t / period + hash11( fi * 7.3 + 1.0 ) * 10.0;
        float id = floor( cycle );
        float f = cycle - id;
        vec2 rnd = hash21( id * 13.7 + fi * 91.3 );
        float angle = rnd.x * 6.2831853;
        vec2 center = vec2( cos( angle ), sin( angle ) ) * sqrt( rnd.y ) * POND_RADIUS * 0.55;
        float x = length( q - center ) - f * 3.4;
        float envelope = ( 1.0 - f ) * ( 1.0 - f ) * smoothstep( 0.0, 0.05, f );
        h += envelope * sin( x * 7.0 ) * exp( - x * x * 1.6 );
      }
      return h;
    }

    float waterHeight( vec2 q, float t ) {
      float h = 0.0;
      h += 0.30 * sin( dot( q, vec2( 0.92, 0.38 ) ) * 2.1 + t * 1.2 );
      h += 0.22 * sin( dot( q, vec2( - 0.45, 0.89 ) ) * 3.3 + t * 1.6 + 1.3 );
      h += 0.12 * sin( dot( q, vec2( 0.60, - 0.80 ) ) * 5.7 + t * 2.1 + 4.1 );
      h += 0.45 * vnoise( q * 1.7 + vec2( t * 0.25, - t * 0.18 ) );
      h += 0.16 * vnoise( q * 4.3 - vec2( t * 0.35, t * 0.22 ) );
      h += 0.42 * rings( q, t );
      return h;
    }

    void main() {
      #include <logdepthbuf_fragment>

      vec2 q = vPond;
      float t = uTime;

      // Distance to the shoreline in pond units, positive inside the pond.
      float theta = atan( - q.y, q.x );
      float shoreRadius = POND_RADIUS * ( 1.0 + dot( uShoreAmp, sin( vec3( 2.0, 3.0, 5.0 ) * theta + uShorePhase ) ) );
      float shore = shoreRadius - length( q );
      if ( shore < - 0.02 ) discard;

      // Surface normal from the animated height field.
      const float e = 0.04;
      float h0 = waterHeight( q, t );
      vec2 slope = vec2( waterHeight( q + vec2( e, 0.0 ), t ) - h0, waterHeight( q + vec2( 0.0, e ), t ) - h0 ) / e;
      slope *= 0.075 * smoothstep( 0.0, 0.5, shore );
      vec3 localNormal = normalize( vec3( - slope, 1.0 ) );
      vec3 normal = normalize( vAxisX * localNormal.x + vAxisY * localNormal.y + vAxisZ * localNormal.z );

      vec3 viewDir = normalize( cameraPosition - vWorldPosition );
      float nDotV = max( dot( normal, viewDir ), 0.0 );

      // Body colour: turquoise shallows fading to a deeper teal.
      float depth = smoothstep( 0.0, 1.9, shore );
      vec3 color = mix( uShallowColor, uDeepColor, depth );
      color *= 1.0 + 0.5 * ( slope.x + slope.y );

      // Planar reflection, wobbled by the ripples and weighted by fresnel.
      vec4 reflectionUv = vReflectionUv;
      reflectionUv.xy += localNormal.xy * 0.24 * mix( 0.35, 1.0, nDotV ) * reflectionUv.w;
      vec3 reflection = texture2DProj( tDiffuse, reflectionUv ).rgb;
      float fresnel = 0.22 + 0.78 * pow( 1.0 - nDotV, 2.5 );
      color = mix( color, reflection, clamp( fresnel * uReflectivity, 0.0, 1.0 ) );

      // Sun: a tight highlight plus twinkling flecks around it.
      vec3 halfDir = normalize( uSunDirection + viewDir );
      float nDotH = max( dot( normal, halfDir ), 0.0 );
      float sparkleNoise = vnoise( q * 13.0 + vec2( t * 0.9, t * 0.4 ) ) * vnoise( q * 17.0 - vec2( t * 0.6, t * 0.8 ) + 7.3 );
      float sparkle = smoothstep( 0.5, 0.64, sparkleNoise ) * ( 0.03 + pow( nDotH, 24.0 ) );
      float highlight = pow( nDotH, 260.0 ) * 1.4 + sparkle * 0.7;
      color += uSunColor * highlight;

      // Foam lapping at the shore, and a fainter line further in.
      float wobble = ( vnoise( q * 3.0 + t * 0.35 ) - 0.5 ) * 0.14 + 0.03 * sin( t * 1.3 + theta * 9.0 );
      float edge = shore + wobble;
      float foam = smoothstep( 0.02, 0.07, edge ) * ( 1.0 - smoothstep( 0.11, 0.2, edge ) );
      float inner = edge - 0.36 - 0.07 * sin( t * 0.8 + theta * 5.0 );
      foam += 0.3 * smoothstep( - 0.035, 0.0, inner ) * ( 1.0 - smoothstep( 0.0, 0.035, inner ) );
      foam = clamp( foam, 0.0, 1.0 );
      color = mix( color, uFoamColor, foam * 0.85 );

      // The water thins out to nothing at the shore so the sand shows through.
      float alpha = clamp( smoothstep( 0.0, 0.32, shore ) + foam * 0.6, 0.0, 1.0 );

      gl_FragColor = vec4( color, alpha );

      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }
  `,
};

function createWater(shore, unit, palette, sunDirection, timeUniform, reflectionSize) {
  // Flat fan in the XY plane (Reflector mirrors about local +Z), reaching
  // slightly under the bank so there is never a gap at the shoreline.
  const segments = 128;
  const positions = [0, 0, 0];
  const indices = [];
  for (let j = 0; j < segments; j++) {
    const theta = (j / segments) * TAU;
    const r = (shore.radiusAt(theta) + 0.3) * unit;
    positions.push(Math.cos(theta) * r, -Math.sin(theta) * r, 0);
    indices.push(0, 1 + ((j + 1) % segments), 1 + j);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const water = new Reflector(geometry, {
    shader: waterShader,
    textureWidth: reflectionSize,
    textureHeight: reflectionSize,
    clipBias: 0.003,
  });
  water.name = 'water';
  water.material.transparent = true;
  water.material.fog = true;

  const uniforms = water.material.uniforms;
  uniforms.uTime = timeUniform;
  uniforms.uUnit.value = unit;
  uniforms.uShoreAmp.value.fromArray(shore.amp);
  uniforms.uShorePhase.value.fromArray(shore.phase);
  uniforms.uShallowColor.value.set(palette.shallowWater);
  uniforms.uDeepColor.value.set(palette.deepWater);
  uniforms.uFoamColor.value.set(palette.foam);
  uniforms.uSunColor.value.set(palette.sun);
  uniforms.uSunDirection.value.copy(sunDirection).normalize();

  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_LEVEL * unit;
  return water;
}

// ---------------------------------------------------------------------------
// Rocks
// ---------------------------------------------------------------------------

function makeRockGeometry(rand, palette) {
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const pos = geometry.attributes.position;
  // The icosahedron is non-indexed, so shared corners are displaced by
  // looking them up by position to keep the surface closed.
  const offsets = new Map();
  const stretch = new THREE.Vector3(0.85 + rand() * 0.4, 0.55 + rand() * 0.3, 0.85 + rand() * 0.4);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const key = `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
    if (!offsets.has(key)) offsets.set(key, 0.78 + rand() * 0.42);
    p.multiplyScalar(offsets.get(key)).multiply(stretch);
    p.y = Math.max(p.y, -0.3);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  geometry.computeVertexNormals();

  // One colour per facet: grey stone with moss on the faces that look up.
  const normal = geometry.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const stone = new THREE.Color(palette.rock);
  const moss = new THREE.Color(palette.moss);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    c.copy(stone).multiplyScalar(0.88 + rand() * 0.24);
    const up = normal.getY(i);
    if (up > 0.55 && rand() < 0.6) c.lerp(moss, 0.35 + rand() * 0.45);
    for (let k = 0; k < 3; k++) c.toArray(colors, (i + k) * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function createRocks(count, shore, terrain, unit, rand, palette) {
  const group = new THREE.Group();
  group.name = 'rocks';
  const obstacles = []; // rocks standing in the water, for lily pad placement
  if (count <= 0) return { group, obstacles };

  const placements = [];
  const place = (theta, s, scale, sink) => {
    const r = shore.radiusAt(theta) + s;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const ground = Math.max(terrain.heightAt(x, z), s < 0 ? WATER_LEVEL - 0.06 : -1);
    placements.push({ x, y: ground + scale * sink, z, scale });
    if (s < -0.25) obstacles.push({ x, z, r: scale });
  };

  for (let i = 0; i < count; i++) {
    const theta = ((i + rand() * 0.8) / count) * TAU;
    const big = rand() < 0.18;
    const scale = (0.2 + rand() * rand() * 0.42) * (big ? 1.7 : 1);
    place(theta, (rand() - 0.3) * 0.55, scale, 0.12);
    // Pebbles scattered near each rock.
    const pebbles = Math.floor(rand() * 3);
    for (let k = 0; k < pebbles; k++) {
      place(theta + (rand() - 0.5) * 0.25, -0.05 + rand() * 0.9, 0.05 + rand() * 0.09, 0.15);
    }
  }
  // A few rocks standing in the shallows.
  const wading = Math.max(1, Math.round(count / 12));
  for (let i = 0; i < wading; i++) {
    place(rand() * TAU, -0.45 - rand() * 0.45, 0.22 + rand() * 0.2, 0.1);
  }

  const variants = 4;
  const buckets = Array.from({ length: variants }, () => []);
  placements.forEach((p, i) => buckets[i % variants].push(p));
  // Rocks are half buried, so their far sides are below the bank: shadows
  // have to come from the faces that look at the light.
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.95,
    metalness: 0,
    shadowSide: THREE.FrontSide,
  });
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  for (const bucket of buckets) {
    if (bucket.length === 0) continue;
    const mesh = new THREE.InstancedMesh(makeRockGeometry(rand, palette), material, bucket.length);
    bucket.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z).multiplyScalar(unit);
      dummy.rotation.set((rand() - 0.5) * 0.5, rand() * TAU, (rand() - 0.5) * 0.5);
      dummy.scale.setScalar(p.scale * unit);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, tint.setScalar(0.82 + rand() * 0.3));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, obstacles };
}

// ---------------------------------------------------------------------------
// Reeds and grass
// ---------------------------------------------------------------------------

// Bends plants in the wind. The offset is applied after the instance
// transform so every plant leans the same way, and is shared with the depth
// material so shadows follow.
function applySway(material, timeUniform, amount) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSwayTime = timeUniform;
    shader.uniforms.uSwayAmount = { value: amount };
    shader.vertexShader =
      'uniform float uSwayTime;\nuniform float uSwayAmount;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        /* glsl */ `
        vec4 mvPosition = vec4( transformed, 1.0 );
        vec3 swayRoot = vec3( 0.0 );
        float swayHeight = 1.0;
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          swayRoot = instanceMatrix[ 3 ].xyz;
          swayHeight = length( instanceMatrix[ 1 ].xyz );
        #endif
        float swayPhase = uSwayTime * 1.3 + swayRoot.x * 0.9 + swayRoot.z * 0.7;
        float swayBend = position.y * position.y * swayHeight * uSwayAmount;
        mvPosition.x += ( sin( swayPhase ) * 0.7 + sin( swayPhase * 2.3 + 1.7 ) * 0.3 ) * swayBend;
        mvPosition.z += cos( swayPhase * 0.8 + 0.6 ) * 0.5 * swayBend;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
        `,
      );
  };
  material.customProgramCacheKey = () => 'pond-sway';
  return material;
}

// A tapered, arching leaf one unit tall, rooted at the origin.
function makeBladeGeometry() {
  const segments = 6;
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  const base = new THREE.Color('#4f8a38');
  const tip = new THREE.Color('#bfdc6c');
  const c = new THREE.Color();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const halfWidth = 0.028 * (1 - t) ** 0.7 + 0.002;
    positions.push(-halfWidth, t, 0.5 * t * t, halfWidth, t, 0.5 * t * t);
    normals.push(-0.25, 0.9, 0.35, 0.25, 0.9, 0.35);
    c.lerpColors(base, tip, t);
    colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    if (i < segments) {
      const a = i * 2;
      // Both windings, sharing sky-facing normals: thin leaves then shade
      // the same from either side instead of going black when backlit.
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
      indices.push(a, a + 3, a + 1, a, a + 2, a + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.normalizeNormals();
  return geometry;
}

// A cattail one unit tall: a thin stalk with a brown seed head near the top.
function makeCattailGeometry() {
  const stalkLow = new THREE.Color('#5f9040');
  const stalkHigh = new THREE.Color('#9db35a');
  const head = new THREE.Color('#5b3a21');

  const stalk = new THREE.CylinderGeometry(0.004, 0.011, 1, 5, 4).translate(0, 0.5, 0);
  setVertexColors(stalk, (p, c) => c.lerpColors(stalkLow, stalkHigh, p.y));
  const seedHead = new THREE.CapsuleGeometry(0.027, 0.13, 3, 7).translate(0, 0.8, 0);
  setVertexColors(seedHead, (p, c) => c.copy(head));

  const merged = mergeGeometries([stalk, seedHead]);
  stalk.dispose();
  seedHead.dispose();
  return merged;
}

function createReeds(count, reedAngle, shore, terrain, unit, rand, timeUniform) {
  const group = new THREE.Group();
  group.name = 'reeds';
  if (count <= 0) return group;

  const arc = 0.62; // half-width of the reed bed, in radians
  const blades = [];
  const cattails = [];
  const rootAt = (theta, s) => {
    const r = shore.radiusAt(theta) + s;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    return { x, y: terrain.heightAt(x, z) - 0.02, z };
  };
  const addBlades = (root, n, minHeight, maxHeight) => {
    for (let k = 0; k < n; k++) {
      blades.push({
        x: root.x + (rand() - 0.5) * 0.14,
        y: root.y,
        z: root.z + (rand() - 0.5) * 0.14,
        height: lerp(minHeight, maxHeight, rand()),
        width: 0.9 + rand() * 0.7,
        bend: 0.15 + rand() * 0.45,
        lean: (rand() - 0.3) * 0.3,
        yaw: rand() * TAU,
        shade: 0.8 + rand() * 0.35,
      });
    }
  };

  // Reed clumps straddling the shoreline: a cattail or two ringed by leaves.
  for (let i = 0; i < count; i++) {
    const theta = reedAngle + ((rand() + rand() + rand()) / 1.5 - 1) * arc;
    const root = rootAt(theta, lerp(-0.8, 0.5, rand()));
    addBlades(root, 3 + Math.floor(rand() * 3), 0.9, 2.0);
    const stems = rand() < 0.75 ? 1 + Math.floor(rand() * 2) : 0;
    for (let k = 0; k < stems; k++) {
      cattails.push({
        x: root.x + (rand() - 0.5) * 0.1,
        y: root.y,
        z: root.z + (rand() - 0.5) * 0.1,
        height: 1.5 + rand() * 1.0,
        lean: (rand() - 0.5) * 0.12,
        yaw: rand() * TAU,
        shade: 0.85 + rand() * 0.3,
      });
    }
  }
  // Shorter grass tufts spreading up the bank behind the reeds.
  for (let i = 0; i < count * 2; i++) {
    const theta = reedAngle + (rand() + rand() - 1) * arc * 1.5;
    addBlades(rootAt(theta, lerp(0.35, 2.0, rand() * rand())), 3 + Math.floor(rand() * 3), 0.25, 0.7);
  }

  const dummy = new THREE.Object3D();
  dummy.rotation.order = 'YXZ';
  const tint = new THREE.Color();
  const build = (items, geometry, material, scaleOf) => {
    if (items.length === 0) {
      geometry.dispose();
      material.dispose();
      return;
    }
    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    items.forEach((item, i) => {
      dummy.position.set(item.x, item.y, item.z).multiplyScalar(unit);
      dummy.rotation.set(item.lean, item.yaw, 0);
      scaleOf(item, dummy.scale).multiplyScalar(unit);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, tint.setScalar(item.shade));
    });
    mesh.customDepthMaterial = applySway(new THREE.MeshDepthMaterial(), timeUniform, 0.07);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Swaying moves vertices outside the static bounds; skip culling.
    mesh.frustumCulled = false;
    group.add(mesh);
  };

  build(
    blades,
    makeBladeGeometry(),
    applySway(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }),
      timeUniform,
      0.07,
    ),
    (b, scale) => scale.set(b.width, b.height, b.height * b.bend),
  );
  build(
    cattails,
    makeCattailGeometry(),
    applySway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), timeUniform, 0.07),
    (c, scale) => scale.set(1.3, c.height, 1.3),
  );
  return group;
}

// ---------------------------------------------------------------------------
// Lily pads
// ---------------------------------------------------------------------------

// A unit-radius leaf lying in the XZ plane with a notch cut towards +X.
function makeLilyPadGeometry() {
  const segments = 28;
  const notch = 0.42;
  const rings = [0.5, 0.86, 1.0];
  const positions = [0.03, 0.012, 0];
  const indices = [];
  for (let j = 0; j <= segments; j++) {
    const a = notch / 2 + (j / segments) * (TAU - notch);
    for (const ring of rings) {
      const r = ring * (1 + 0.035 * Math.sin(a * 6) * ring);
      positions.push(Math.cos(a) * r, 0.045 * r * r, Math.sin(a) * r);
    }
  }
  const n = rings.length;
  for (let j = 0; j < segments; j++) {
    const a = 1 + j * n;
    const b = a + n;
    indices.push(0, b, a);
    for (let i = 0; i < n - 1; i++) indices.push(a + i, b + i, b + i + 1, a + i, b + i + 1, a + i + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const center = new THREE.Color('#9cc864');
  const mid = new THREE.Color('#4f9c46');
  const rim = new THREE.Color('#2f7a3d');
  return setVertexColors(geometry, (p, c) => {
    const r = Math.hypot(p.x, p.z);
    if (r < 0.5) c.lerpColors(center, mid, r / 0.5);
    else c.lerpColors(mid, rim, (r - 0.5) / 0.5);
  });
}

// A unit-radius water lily: three rings of petals around a yellow heart.
function makeLilyFlowerGeometry(tipColor) {
  const white = new THREE.Color('#fffaf0');
  const tip = new THREE.Color(tipColor);
  const parts = [];

  const petal = new THREE.SphereGeometry(0.5, 6, 4).scale(0.34, 0.1, 1).translate(0, 0, 0.5);
  const pos = petal.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    pos.setY(i, pos.getY(i) + 0.22 * z * z); // curl the tip upwards
  }
  setVertexColors(petal, (p, c) => c.lerpColors(white, tip, smoothstep(0.25, 1, p.z)));

  const layers = [
    { count: 9, tilt: 0.3, length: 1.0 },
    { count: 7, tilt: 0.72, length: 0.82 },
    { count: 5, tilt: 1.12, length: 0.6 },
  ];
  layers.forEach((layer, l) => {
    for (let k = 0; k < layer.count; k++) {
      parts.push(
        petal
          .clone()
          .scale(layer.length, layer.length, layer.length)
          .rotateX(-layer.tilt)
          .rotateY(((k + l * 0.5) / layer.count) * TAU),
      );
    }
  });

  const heart = new THREE.SphereGeometry(0.17, 8, 5).scale(1, 0.75, 1).translate(0, 0.14, 0);
  const yellow = new THREE.Color('#f4c542');
  setVertexColors(heart, (p, c) => c.copy(yellow));
  parts.push(heart);

  const merged = mergeGeometries(parts);
  petal.dispose();
  parts.forEach((part) => part.dispose());
  merged.computeVertexNormals();
  return merged;
}

function createLilyPads(count, reedAngle, shore, obstacles, unit, rand) {
  const group = new THREE.Group();
  group.name = 'lilyPads';
  const pads = [];
  if (count <= 0) return { group, pads };

  const taken = obstacles.map((o) => ({ ...o }));
  const fits = (x, z, radius) => {
    const theta = Math.atan2(z, x);
    const dist = Math.hypot(x, z);
    const shoreRadius = shore.radiusAt(theta);
    if (dist + radius + 0.5 > shoreRadius) return false;
    // Keep clear of the reed bed.
    const offAxis = Math.abs(Math.atan2(Math.sin(theta - reedAngle), Math.cos(theta - reedAngle)));
    if (offAxis < 0.85 && dist + radius + 1.25 > shoreRadius) return false;
    return taken.every((o) => Math.hypot(x - o.x, z - o.z) > o.r + radius + 0.06);
  };

  const placed = [];
  const maxAttempts = count * 80;
  for (let attempt = 0; placed.length < count && attempt < maxAttempts; attempt++) {
    // Shrink the pads if the pond is getting crowded.
    const crowding = attempt > maxAttempts / 2 ? 0.6 : 1;
    const radius = lerp(0.3, 0.62, rand()) * crowding;
    let x, z;
    if (placed.length > 0 && rand() < 0.65) {
      // Pads grow in loose clusters: drop this one next to an existing pad.
      const near = placed[Math.floor(rand() * placed.length)];
      const angle = rand() * TAU;
      const d = near.radius + radius + 0.07 + rand() * 0.4;
      x = near.x + Math.cos(angle) * d;
      z = near.z + Math.sin(angle) * d;
    } else {
      const theta = rand() * TAU;
      const r = Math.sqrt(rand()) * (shore.radiusAt(theta) - radius - 0.5);
      x = Math.cos(theta) * r;
      z = Math.sin(theta) * r;
    }
    if (!fits(x, z, radius)) continue;
    placed.push({ x, z, radius });
    taken.push({ x, z, r: radius });
  }

  const padGeometry = makeLilyPadGeometry();
  const padMaterials = ['#ffffff', '#e4f2d2', '#f4f0c8'].map(
    (tint) =>
      new THREE.MeshStandardMaterial({
        color: tint,
        vertexColors: true,
        roughness: 0.85,
        metalness: 0,
      }),
  );
  const flowerGeometries = [makeLilyFlowerGeometry('#f39bbd'), makeLilyFlowerGeometry('#fff3d6')];
  const flowerMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.6,
    metalness: 0,
    shadowSide: THREE.FrontSide,
  });

  placed.forEach((p, i) => {
    const pad = new THREE.Group();
    pad.position.set(p.x * unit, (WATER_LEVEL + 0.014) * unit, p.z * unit);
    pad.rotation.y = rand() * TAU;

    const leaf = new THREE.Mesh(padGeometry, padMaterials[i % padMaterials.length]);
    leaf.scale.setScalar(p.radius * unit);
    leaf.receiveShadow = true;
    pad.add(leaf);

    // Every third pad or so carries a flower (and the first one always does).
    if (p.radius > 0.34 && (i === 0 || rand() < 0.35)) {
      const flower = new THREE.Mesh(flowerGeometries[Math.floor(rand() * 2)], flowerMaterial);
      flower.scale.setScalar(p.radius * (0.4 + rand() * 0.12) * unit);
      flower.position.set(-0.12 * p.radius * unit, 0.03 * p.radius * unit, 0);
      flower.rotation.y = rand() * TAU;
      flower.castShadow = true;
      pad.add(flower);
    }

    group.add(pad);
    pads.push({ object: pad, baseY: pad.position.y, phase: rand() * TAU, speed: 0.8 + rand() * 0.5 });
  });
  return { group, pads };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds a self-contained, fully procedural pond: a banked shoreline, water
 * with a custom ripple/reflection shader, rocks, lily pads and a reed bed.
 *
 * The group's origin is the pond centre at ground level (y = 0); the bank
 * rises slightly above that and tucks into any flat ground at y = 0.
 *
 * Call `pond.userData.update(elapsedSeconds)` once per frame to animate it,
 * and `pond.userData.dispose()` when it is removed for good.
 *
 * @param {object} [options]
 * @param {number} [options.size=10] Approximate diameter of the water, in world units.
 * @param {number} [options.lilyPads=7] Number of lily pads (fewer are placed if they cannot all fit).
 * @param {number} [options.rocks=26] Number of rocks around the shore.
 * @param {number} [options.reeds=45] Number of reed clumps (0 for none).
 * @param {number} [options.reedAngle] Direction of the reed bed from the pond centre, in radians in the XZ plane.
 * @param {number} [options.seed=1] Changes the layout; the same seed always gives the same pond.
 * @param {THREE.Vector3} [options.sunDirection] Direction towards the sun, for the water highlights.
 * @param {THREE.ColorRepresentation} [options.grassColor] Colour of the outer bank; match it to your ground.
 * @param {number} [options.reflectionResolution=1024] Size of the water reflection texture.
 * @returns {THREE.Group}
 */
export function createPond({
  size = 10,
  lilyPads = 7,
  rocks = 26,
  reeds = 45,
  reedAngle = Math.PI * 0.8,
  seed = 1,
  sunDirection = new THREE.Vector3(-0.5, 0.75, -0.45),
  grassColor = '#86b35a',
  reflectionResolution = 1024,
} = {}) {
  const unit = size / 10;
  const rand = mulberry32(seed);
  const noise = makeNoise2D(seed);
  const timeUniform = { value: 0 };
  const palette = {
    grass: grassColor,
    sand: '#d6c08f',
    rock: '#a6a69e',
    moss: '#6f9a4c',
    shallowWater: '#7fd1b9',
    deepWater: '#1f6f78',
    foam: '#f4fbf8',
    sun: '#fff4d6',
  };

  const shore = makeShore(rand);
  const terrain = makeTerrain(shore, noise);

  const pond = new THREE.Group();
  pond.name = 'pond';

  const bank = createBank(shore, terrain, noise, palette);
  bank.scale.setScalar(unit);
  pond.add(bank);

  const water = createWater(shore, unit, palette, sunDirection, timeUniform, reflectionResolution);
  pond.add(water);

  const rockSet = createRocks(Math.max(0, Math.floor(rocks)), shore, terrain, unit, rand, palette);
  pond.add(rockSet.group);

  pond.add(createReeds(Math.max(0, Math.floor(reeds)), reedAngle, shore, terrain, unit, rand, timeUniform));

  const lilies = createLilyPads(Math.max(0, Math.floor(lilyPads)), reedAngle, shore, rockSet.obstacles, unit, rand);
  pond.add(lilies.group);

  pond.userData.size = size;
  pond.userData.waterLevel = WATER_LEVEL * unit;
  pond.userData.outerRadius = (POND_RADIUS * 1.25 + BANK_WIDTH) * unit;

  /** Advances the animation; pass the elapsed time in seconds. */
  pond.userData.update = (time) => {
    timeUniform.value = time;
    for (const pad of lilies.pads) {
      const t = time * pad.speed + pad.phase;
      pad.object.position.y = pad.baseY + Math.sin(t) * 0.006 * unit;
      pad.object.rotation.x = Math.sin(t * 0.9 + 1.3) * 0.035;
      pad.object.rotation.z = Math.cos(t * 0.7) * 0.035;
    }
  };

  /** Frees GPU resources owned by the pond. */
  pond.userData.dispose = () => {
    pond.traverse((object) => {
      if (object.isReflector) {
        object.dispose();
      } else if (object.material) {
        for (const material of [].concat(object.material)) material.dispose();
      }
      if (object.customDepthMaterial) object.customDepthMaterial.dispose();
      if (object.isInstancedMesh) object.dispose();
      if (object.geometry) object.geometry.dispose();
    });
  };

  return pond;
}
