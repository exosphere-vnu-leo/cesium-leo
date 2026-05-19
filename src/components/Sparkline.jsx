export default function Sparkline({ series, keys, labels }) {
  const values = series.flatMap((point) => keys.map((key) => point[key]).filter(Number.isFinite));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = 320;
  const height = 112;
  const pad = 10;

  if (!series.length || !Number.isFinite(min) || !Number.isFinite(max)) {
    return <div className="empty-chart">No data</div>;
  }

  const span = max - min || 1;
  const x = (index) => pad + (index / Math.max(1, series.length - 1)) * (width - pad * 2);
  const y = (value) => height - pad - ((value - min) / span) * (height - pad * 2);
  const colors = ['#38bdf8', '#f59e0b', '#22c55e'];

  return (
    <div className="sparkline-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="loss chart">
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} />
        {keys.map((key, keyIndex) => {
          const points = series
            .map((point, index) =>
              Number.isFinite(point[key]) ? `${x(index)},${y(point[key])}` : null
            )
            .filter(Boolean)
            .join(' ');
          return (
            <polyline
              key={key}
              points={points}
              fill="none"
              stroke={colors[keyIndex % colors.length]}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
      </svg>
      <div className="chart-legend">
        {keys.map((key, index) => (
          <span key={key}>
            <i style={{ background: colors[index % colors.length] }} />
            {labels?.[key] ?? key}
          </span>
        ))}
      </div>
    </div>
  );
}
