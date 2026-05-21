export const NAME_ALIASES = new Map([
  ['HN', 'HaNoi'],
  ['HaNoi', 'HaNoi'],
  ['Hanoi', 'HaNoi'],
  ['DN', 'DaNang'],
  ['DaNang', 'DaNang'],
  ['HCM', 'HoChiMinh'],
  ['HoChiMinh', 'HoChiMinh'],
  ['HoChiMinhCity', 'HoChiMinh']
]);

const DEG_TO_RAD = Math.PI / 180;
const EARTH_RADIUS_KM = 6371;

export function toNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function canonicalNodeName(name) {
  const cleaned = String(name ?? '').trim();
  return NAME_ALIASES.get(cleaned) ?? cleaned;
}

export function isRouterName(name) {
  return canonicalNodeName(name).startsWith('Router_');
}

export function nodeTypeFromName(name) {
  return isRouterName(name) ? 'router' : 'gateway';
}

export function roleLabel(linkType, freqUlGhz, freqDlGhz) {
  const role = String(linkType ?? '').startsWith('UT') ? 'UT' : 'GW';
  if (freqUlGhz == null || freqDlGhz == null) return role;
  return `${role} (${formatNumber(freqUlGhz, 1)}GHz/${formatNumber(freqDlGhz, 1)}GHz)`;
}

export function qualityFromSinr(sinr) {
  if (sinr == null || Number.isNaN(sinr)) {
    return { label: 'Unknown', level: 'unknown', color: '#94a3b8', probability: 0 };
  }
  if (sinr > 15) {
    return { label: 'Good', level: 'good', color: '#22c55e', probability: 0.98 };
  }
  if (sinr >= 10) {
    return { label: 'Fair', level: 'fair', color: '#facc15', probability: 0.75 };
  }
  if (sinr >= 0) {
    return { label: 'Poor', level: 'poor', color: '#f97316', probability: 0.35 };
  }
  return { label: 'Critical', level: 'critical', color: '#ef4444', probability: 0.05 };
}

export function seededRandom(seed) {
  let hash = 2166136261;
  const source = String(seed);
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash += hash << 13;
  hash ^= hash >>> 7;
  hash += hash << 3;
  hash ^= hash >>> 17;
  hash += hash << 5;
  return (hash >>> 0) / 4294967296;
}

export function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

export function median(values) {
  const valid = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function formatNumber(value, digits = 2) {
  if (value == null || Number.isNaN(value)) return 'n/a';
  return Number(value).toFixed(digits);
}

export function round(value, digits = 2) {
  if (value == null || Number.isNaN(value)) return null;
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

export function normalizeLongitude(degrees) {
  let value = degrees;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

export function uniqBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

export function haversineDistanceKm(latA, lonA, latB, lonB) {
  if (![latA, lonA, latB, lonB].every(Number.isFinite)) return null;
  const dLat = (latB - latA) * DEG_TO_RAD;
  const dLon = (lonB - lonA) * DEG_TO_RAD;
  const aLat = latA * DEG_TO_RAD;
  const bLat = latB * DEG_TO_RAD;
  const hav =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat) * Math.cos(bLat) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(hav)));
}
