import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { formatKpiValue, formatPeriod } from "@/lib/platform-kpi";

// Chronological single-metric trend. Deliberately NOT chart-spec's aggregate()
// (it orders groups by total, which scrambles a time axis) — periods arrive
// pre-sorted from seriesFor(). Styling matches ConfiguredChart's line branch.
const LINE_COLOR = "oklch(0.546 0.162 241)";

export function KpiTrendChart({
  series,
  unit,
}: {
  series: { period: string; value: number }[];
  unit: string;
}) {
  const data = series.map((p) => ({ name: formatPeriod(p.period), value: p.value }));
  return (
    <ResponsiveContainer width="100%" height={120}>
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis dataKey="name" tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 10 }} width={44} />
        <Tooltip
          contentStyle={{ fontSize: 12 }}
          formatter={(v) => [formatKpiValue(Number(v), unit), ""]}
        />
        <Line type="monotone" dataKey="value" stroke={LINE_COLOR} strokeWidth={2} dot={{ r: 2.5 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
