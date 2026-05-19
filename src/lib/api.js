export async function getJson(path, signal) {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.json();
}

export function formatBytes(bytes) {
  if (bytes == null) return '0 B';
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export function formatTime(seconds) {
  const value = Number(seconds ?? 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const sec = value % 60;
  return [hours, minutes, sec].map((part) => String(part).padStart(2, '0')).join(':');
}

export function cssQuality(level) {
  return `quality-${level ?? 'unknown'}`;
}
