import { useId } from 'react';
import { number } from './data';

export function Chart({
  values,
  labels,
  label,
  price = false,
  compact = false,
}: {
  values: number[];
  labels?: string[];
  label: string;
  price?: boolean;
  compact?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  const low = Math.min(...values);
  const high = Math.max(...values);
  const margin = (high - low || high * 0.01 || 1) * 0.15;
  const min = low - margin;
  const max = high + margin;
  const height = compact ? 54 : 240;
  const width = compact ? 150 : 900;
  const points = values
    .map(
      (v, i) =>
        `${(i / (values.length - 1)) * width},${height - ((v - min) / (max - min)) * height}`,
    )
    .join(' ');
  if (compact)
    return (
      <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  return (
    <figure className="chart" aria-label={label}>
      <div className="chart-body">
        <div className="chart-axis" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i}>{number(max - ((max - min) * i) / 4, price ? 4 : 0)}</span>
          ))}
        </div>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${label}. Starts at ${number(values[0], 4)}, ends at ${number(values.at(-1)!, 4)}. Sample data.`}
        >
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: 'var(--net)' }} stopOpacity="0.14" />
              <stop offset="100%" style={{ stopColor: 'var(--net)' }} stopOpacity="0.005" />
            </linearGradient>
          </defs>
          {Array.from({ length: 5 }, (_, i) => (
            <line
              key={`h${i}`}
              x1="0"
              x2={width}
              y1={(i * height) / 4}
              y2={(i * height) / 4}
              className="grid-line"
            />
          ))}
          {Array.from({ length: 9 }, (_, i) => (
            <line
              key={`v${i}`}
              y1="0"
              y2={height}
              x1={(i * width) / 8}
              x2={(i * width) / 8}
              className="grid-line vertical"
            />
          ))}
          <polygon points={`0,${height} ${points} ${width},${height}`} fill={`url(#${id})`} />
          <polyline
            points={points}
            fill="none"
            style={{ stroke: 'var(--net)' }}
            strokeWidth="1.8"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="chart-labels" aria-hidden="true">
        {labels?.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
      <figcaption className="sr-only">
        Illustrative history. This chart is not a live market feed.
      </figcaption>
    </figure>
  );
}
