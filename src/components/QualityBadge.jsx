import { cssQuality } from '../lib/api.js';

export default function QualityBadge({ quality, sinr }) {
  const label = quality?.label ?? 'Unknown';
  return (
    <span className={`quality-badge ${cssQuality(quality?.level)}`}>
      {label}
      {sinr != null ? ` ${Number(sinr).toFixed(2)} dB` : ''}
    </span>
  );
}
