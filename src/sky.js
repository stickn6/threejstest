import * as THREE from 'three';

const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

// Smooth 3D value noise, sampled on the view direction so the sky has no seam.
function noise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const wx = fx * fx * (3 - 2 * fx), wy = fy * fy * (3 - 2 * fy), wz = fz * fz * (3 - 2 * fz);
  const lerp = (a, b, t) => a + (b - a) * t;
  return lerp(
    lerp(
      lerp(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), wx),
      lerp(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), wx),
      wy,
    ),
    lerp(
      lerp(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), wx),
      lerp(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), wx),
      wy,
    ),
    wz,
  );
}

function fbm(x, y, z) {
  let sum = 0, amp = 0.5;
  for (let i = 0; i < 4; i++) {
    sum += amp * noise3(x, y, z);
    x *= 2.03; y *= 2.03; z *= 2.03;
    amp *= 0.5;
  }
  return sum / 0.9375;
}

/**
 * Builds a procedural daylight sky (gradient, sun glow, soft clouds) as an
 * equirectangular texture suitable for `scene.background`.
 *
 * @param {object} [options]
 * @param {THREE.Vector3} [options.sunDirection] Direction towards the sun.
 * @param {THREE.ColorRepresentation} [options.zenith]
 * @param {THREE.ColorRepresentation} [options.horizon] Use the same colour for the scene fog.
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @returns {THREE.DataTexture}
 */
export function createSkyTexture({
  sunDirection = new THREE.Vector3(0.4, 0.7, 0.4),
  zenith = '#5a9bdc',
  horizon = '#dcebf2',
  width = 1024,
  height = 512,
} = {}) {
  const sun = sunDirection.clone().normalize();
  // Work directly in sRGB bytes: an sRGB background is not tone mapped, so
  // its horizon matches the fog colour exactly.
  const rgb = (c) => {
    const col = new THREE.Color(c).convertLinearToSRGB();
    return [col.r, col.g, col.b];
  };
  const top = rgb(zenith);
  const low = rgb(horizon);
  const glow = [1.0, 0.96, 0.84];
  const cloud = [1.0, 1.0, 1.0];

  const data = new Uint8Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    const lat = ((j + 0.5) / height - 0.5) * Math.PI;
    const dy = Math.sin(lat), cl = Math.cos(lat);
    for (let i = 0; i < width; i++) {
      const phi = ((i + 0.5) / width - 0.5) * Math.PI * 2;
      const dx = cl * Math.cos(phi), dz = cl * Math.sin(phi);

      const t = Math.pow(smoothstep(-0.02, 0.9, dy), 0.6);
      let r = low[0] + (top[0] - low[0]) * t;
      let g = low[1] + (top[1] - low[1]) * t;
      let b = low[2] + (top[2] - low[2]) * t;

      if (dy > 0) {
        // Clouds: noise on a flat layer overhead, fading out towards the horizon.
        const k = 1.6 / (dy + 0.35);
        const n = fbm(dx * k + 3.1, 1.7, dz * k - 0.4);
        const c = smoothstep(0.5, 0.74, n) * smoothstep(0.03, 0.3, dy) * 0.85;
        r += (cloud[0] - r) * c;
        g += (cloud[1] - g) * c;
        b += (cloud[2] - b) * c;
      }

      const d = Math.max(dx * sun.x + dy * sun.y + dz * sun.z, 0);
      const s = Math.min(Math.pow(d, 28) * 0.3 + Math.pow(d, 900) * 1.5, 1);
      r += (glow[0] - r) * s;
      g += (glow[1] - g) * s;
      b += (glow[2] - b) * s;

      // A little dither hides banding in the 8-bit gradient.
      const dither = (hash3(i, j, 0.5) - 0.5) / 255;
      const o = (j * width + i) * 4;
      data[o] = Math.min(Math.max(r + dither, 0), 1) * 255;
      data[o + 1] = Math.min(Math.max(g + dither, 0), 1) * 255;
      data[o + 2] = Math.min(Math.max(b + dither, 0), 1) * 255;
      data[o + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
