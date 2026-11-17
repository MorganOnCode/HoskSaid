import type { YearCoverage } from "@/lib/analytics/data";
import { PARAMS } from "@/lib/analytics/method";

export interface ChartSeries {
  index: number;
  label: string;
  by_year: YearCoverage[];
}

interface Props {
  years: number[];
  series: ChartSeries[];
  measure: "share" | "count";
  focus: number;
  selectedYear: number | null;
  /** Thin years (fewer than this many videos) are drawn hollow. */
  thinBelow: number;
  hrefFor: (seriesIndex: number, year: number) => string;
}

const COLORS = ["var(--s0)", "var(--s1)", "var(--s2)"];

function niceMax(v: number, share: boolean): number {
  if (share) return [0.1, 0.25, 0.5, 0.75, 1].find((s) => s >= v) ?? 1;
  const steps = [5, 10, 20, 25, 50, 75, 100, 150, 200, 250, 500];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 100) * 100;
}

function Marker({ shape, x, y, className, color }: { shape: number; x: number; y: number; className: string; color: string }) {
  const style = { fill: color, stroke: className.includes("thin") ? color : undefined };
  if (shape === 1) return <rect className={className} x={x - 4.5} y={y - 4.5} width={9} height={9} style={style} />;
  if (shape === 2) return <path className={className} d={`M${x} ${y - 6}L${x + 6} ${y}L${x} ${y + 6}L${x - 6} ${y}Z`} style={style} />;
  return <circle className={className} cx={x} cy={y} r={5} style={style} />;
}

/**
 * Per-year coverage lines, one per query. Every point is a link to that
 * query's sources for that year and carries its n/N as a <title>; the table
 * view shows the same numbers as text. Rendered twice (wide and narrow
 * geometry) so labels stay legible on phones without client JavaScript.
 */
export function CoverageChart(props: Props) {
  return (
    <>
      <Chart {...props} variant="wide" />
      <Chart {...props} variant="narrow" />
    </>
  );
}

function Chart({ years, series, measure, focus, selectedYear, thinBelow, hrefFor, variant }: Props & { variant: "wide" | "narrow" }) {
  if (!years.length || !series.length) return null;
  const wide = variant === "wide";
  const W = wide ? 760 : 360;
  const H = wide ? 280 : 250;
  const m = { l: wide ? 46 : 38, r: 14, t: 18, b: 34 };
  const share = measure === "share";
  const val = (y: YearCoverage) => (share ? (y.videos ? y.matched / y.videos : 0) : y.matched);
  const maxV = Math.max(0.0001, ...series.flatMap((s) => s.by_year.map(val)));
  const top = niceMax(maxV, share);
  const xs = (i: number) => (years.length === 1 ? (m.l + W - m.r) / 2 : m.l + (i * (W - m.l - m.r)) / (years.length - 1));
  const ys = (v: number) => m.t + (1 - v / top) * (H - m.t - m.b);
  const fmt = (v: number) => (share ? `${Math.round(v * 100)}%` : String(Math.round(v)));
  const every = wide ? (years.length > 16 ? 2 : 1) : years.length > 8 ? 2 : 1;
  const eraI = years.indexOf(PARAMS.eraStartYear);
  const showEra = eraI > 0 && years[eraI - 1] === PARAMS.eraStartYear - 1;
  const eraX = showEra ? (xs(eraI - 1) + xs(eraI)) / 2 : 0;

  return (
    <svg
      className={`an-chart ${variant}`}
      viewBox={`0 0 ${W} ${H}`}
      role="group"
      aria-label={`${share ? "Share" : "Number"} of videos matching each query, by year. Each point links to that year's sources; the table view lists every value.`}
    >
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line className="grid" x1={m.l} x2={W - m.r} y1={ys(top * f)} y2={ys(top * f)} />
          <text className="axis" x={m.l - 6} y={ys(top * f) + 4} textAnchor="end">{fmt(top * f)}</text>
        </g>
      ))}
      {years.map((y, i) =>
        i % every === 0 || i === years.length - 1 ? (
          <text key={y} className="axis" x={xs(i)} y={H - 12} textAnchor="middle">{wide ? y : `’${String(y).slice(2)}`}</text>
        ) : null
      )}
      {showEra && (
        <g>
          <line className="era" x1={eraX} x2={eraX} y1={m.t - 6} y2={H - m.b} />
          <text className="era-t" x={eraX + 5} y={m.t + 2}>{wide ? "2022: auto-captions improve" : "captions ↑"}</text>
        </g>
      )}
      {series.map((s) => {
        const color = COLORS[s.index % COLORS.length];
        const pts = years
          .map((y, i) => ({ y, i, c: s.by_year.find((b) => b.year === y) }))
          .filter((p): p is { y: number; i: number; c: YearCoverage } => !!p.c);
        const d = pts.map((p, k) => `${k ? "L" : "M"}${xs(p.i).toFixed(1)} ${ys(val(p.c)).toFixed(1)}`).join("");
        return (
          <g key={s.index}>
            <path className="ln" d={d} style={{ stroke: color }} />
            {pts.map((p) => {
              const thin = p.c.videos < thinBelow;
              const pct = p.c.videos ? Math.round((p.c.matched / p.c.videos) * 100) : 0;
              const sel = s.index === focus && selectedYear === p.y;
              return (
                <a key={p.y} href={hrefFor(s.index, p.y)} aria-label={`${s.label}, ${p.y}: ${p.c.matched} of ${p.c.videos} videos (${pct}%). Show sources.`}>
                  <title>{`${s.label} · ${p.y}: ${p.c.matched}/${p.c.videos} videos (${pct}%)${thin ? " · few videos this year" : ""}`}</title>
                  {sel && <circle className="sel" cx={xs(p.i)} cy={ys(val(p.c))} r={10} />}
                  <circle cx={xs(p.i)} cy={ys(val(p.c))} r={12} fill="transparent" />
                  <Marker shape={s.index} x={xs(p.i)} y={ys(val(p.c))} className={`pt${thin ? " thin" : ""}`} color={color} />
                </a>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

export const SERIES_COLORS = COLORS;
