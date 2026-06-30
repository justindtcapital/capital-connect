import { useMemo } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { X } from "lucide-react";
import type { Dimension } from "@/lib/use-chart-drill";
import { aggregate, chartTitle, type ChartSpec, type Metric } from "@/lib/chart-spec";

const PALETTE = [
  "oklch(0.546 0.162 241)",
  "oklch(0.637 0.135 163)",
  "oklch(0.735 0.145 85)",
  "oklch(0.598 0.2 295)",
  "oklch(0.645 0.246 16)",
  "oklch(0.6 0.18 200)",
  "oklch(0.7 0.15 130)",
  "oklch(0.55 0.19 310)",
];

interface Props<T> {
  spec: ChartSpec;
  dims: Dimension<T>[];
  metrics: Metric<T>[];
  items: T[];
  /** Cross-filter on click — same model as the curated charts. */
  focus: (dim: string, value: string | number | null | undefined) => void;
  onRemove?: () => void;
}

// Renders a single ChartSpec with recharts. Clicking a bar/slice/point focuses
// the grouped value, so user-built charts cross-filter the page exactly like the
// curated ones. `stacked` when a splitBy is set; grouped when comparing measures.
export function ConfiguredChart<T>({ spec, dims, metrics, items, focus, onRemove }: Props<T>) {
  const groupDim = dims.find((d) => d.dim === spec.groupBy);
  const { data, series } = useMemo(
    () => aggregate(items, spec, dims, metrics),
    [items, spec, dims, metrics],
  );
  const title = chartTitle(spec, dims, metrics);
  const click = (label: string | number | null | undefined) => {
    if (groupDim) focus(groupDim.dim, label);
  };
  const stacked = spec.style !== "pie" && !!spec.splitBy;
  const showLegend = series.length > 1;

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="text-xs font-semibold leading-tight">{title}</div>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove chart"
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {data.length === 0 ? (
        <p className="text-xs text-muted-foreground py-10 text-center">
          No data for this configuration.
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          {spec.style === "pie" ? (
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={70}
                className="cursor-pointer"
                onClick={(d: { name?: string }) => click(d?.name)}
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ fontSize: 12 }} />
              {showLegend && <Legend wrapperStyle={{ fontSize: 11 }} />}
            </PieChart>
          ) : spec.style === "line" ? (
            <LineChart
              data={data}
              onClick={(s: { activeLabel?: string | number }) => click(s?.activeLabel)}
              className="cursor-pointer"
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              {showLegend && <Legend wrapperStyle={{ fontSize: 11 }} />}
              {series.map((s, i) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={PALETTE[i % PALETTE.length]}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                />
              ))}
            </LineChart>
          ) : spec.style === "hbar" ? (
            <BarChart
              data={data}
              layout="vertical"
              onClick={(s: { activeLabel?: string | number }) => click(s?.activeLabel)}
              className="cursor-pointer"
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
              <YAxis dataKey="name" type="category" width={120} tick={{ fontSize: 10 }} />
              <Tooltip
                contentStyle={{ fontSize: 12 }}
                cursor={{ fill: "var(--color-accent)", opacity: 0.4 }}
              />
              {showLegend && <Legend wrapperStyle={{ fontSize: 11 }} />}
              {series.map((s, i) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stackId={stacked ? "a" : undefined}
                  fill={PALETTE[i % PALETTE.length]}
                  radius={stacked ? undefined : [0, 4, 4, 0]}
                />
              ))}
            </BarChart>
          ) : (
            <BarChart
              data={data}
              onClick={(s: { activeLabel?: string | number }) => click(s?.activeLabel)}
              className="cursor-pointer"
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 10 }}
                angle={-15}
                textAnchor="end"
                height={50}
              />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip
                contentStyle={{ fontSize: 12 }}
                cursor={{ fill: "var(--color-accent)", opacity: 0.4 }}
              />
              {showLegend && <Legend wrapperStyle={{ fontSize: 11 }} />}
              {series.map((s, i) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stackId={stacked ? "a" : undefined}
                  fill={PALETTE[i % PALETTE.length]}
                  radius={stacked ? undefined : [4, 4, 0, 0]}
                />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      )}
    </div>
  );
}
