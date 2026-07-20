import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  CircleDashed,
} from "lucide-react";
import { checkApiHealth, type HealthStatus, type ServiceHealth } from "@/utils/health.functions";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function StatusIcon({ status }: { status: HealthStatus }) {
  if (status === "ok") {
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />;
  }
  if (status === "error") {
    return <XCircle className="h-4 w-4 shrink-0 text-red-500" />;
  }
  return <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground/50" />;
}

function summaryLabel(services: ServiceHealth[], isFetching: boolean, isError: boolean): {
  text: string;
  status: HealthStatus;
} {
  if (isError && services.length === 0) {
    return { text: "Health check failed", status: "error" };
  }
  if (services.length === 0 && isFetching) {
    return { text: "Checking connections…", status: "unconfigured" };
  }
  const errors = services.filter((s) => s.status === "error").length;
  const ok = services.filter((s) => s.status === "ok").length;
  if (errors > 0) {
    return {
      text: errors === 1 ? "1 connection failing" : `${errors} connections failing`,
      status: "error",
    };
  }
  if (ok > 0 && ok === services.length) {
    return { text: "All connections healthy", status: "ok" };
  }
  if (ok > 0) {
    return { text: `${ok} of ${services.length} connected`, status: "unconfigured" };
  }
  return { text: "No connections configured", status: "unconfigured" };
}

function formatLatency(ms?: number): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return `${Math.max(0, Math.round(ms))}ms`;
}

// Sidebar-footer status: collapsed summary ("All connections healthy"), click opens
// a popover listing each API with status detail + latency. Probes via react-query.
export function ApiHealthWidget({ collapsed }: { collapsed?: boolean }) {
  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: ["api-health"],
    queryFn: () => checkApiHealth(),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const services = data?.services ?? [];
  const summary = summaryLabel(services, isFetching, isError);

  const trigger = (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors",
        "hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring",
        collapsed && "justify-center px-0",
      )}
      title="API connections"
    >
      <span
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          summary.status === "ok" && "bg-primary",
          summary.status === "error" && "bg-destructive",
          summary.status === "unconfigured" && "bg-muted-foreground/40",
          isFetching && "animate-pulse",
        )}
      />
      {!collapsed && (
        <span className="truncate text-xs text-sidebar-foreground/80">{summary.text}</span>
      )}
    </button>
  );

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 p-0 shadow-lg"
      >
        <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">API connections</span>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              void refetch();
            }}
            disabled={isFetching}
            title="Re-check"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        <div className="max-h-72 overflow-y-auto px-1.5 py-1.5">
          {services.length === 0 && isFetching && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">Checking…</p>
          )}
          {services.length === 0 && isError && (
            <p className="px-2 py-4 text-center text-xs text-red-500">Health check failed.</p>
          )}
          <ul className="space-y-0.5">
            {services.map((s) => {
              const latency = formatLatency(s.latencyMs);
              return (
                <li
                  key={s.service}
                  className="flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-muted/40"
                  title={s.detail ? `${s.service}: ${s.detail}` : s.service}
                >
                  <StatusIcon status={s.status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {s.service}
                      </span>
                      {latency && (
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {latency}
                        </span>
                      )}
                    </div>
                    {s.detail && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{s.detail}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}
