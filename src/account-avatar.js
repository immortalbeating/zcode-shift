import { toSvg } from "jdenticon";

const CACHE_LIMIT = 256;
const cache = new Map();
const config = {
  padding: 0.13,
  saturation: { color: 0.65, grayscale: 0.15 },
  lightness: { color: [0.48, 0.76], grayscale: [0.58, 0.82] },
};

// Account identity is the only seed; display names and credentials never enter here.
export function avatarSvg(id) {
  if (typeof id !== "string" || !id) {
    throw new TypeError("Account ID must be a non-empty string");
  }
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const svg = toSvg(`zcode-shift:account:${id}`, 48, config);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(id, svg);
  return svg;
}
