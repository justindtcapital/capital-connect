import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Cpu, BadgeCheck, RefreshCw } from "lucide-react";
import { getCompanyTechStack, verifyCompanyTechStack } from "@/utils/sumble.functions";
import type { SumbleTech } from "@/utils/sumble.server";

interface TechStackSectionProps {
  /** Any of these is used to resolve the company domain (most specific first). */
  domain?: string;
  website?: string;
  email?: string;
  company?: string;
  /** Smaller header style for the contact sheet (vs. portfolio panel). */
  compact?: boolean;
}

function confidenceClass(c: number): string {
  if (c >= 80) return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (c >= 50) return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-muted text-muted-foreground border-border";
}

// Tech Stack — Sumble-detected technologies for a contact's company or a PortCo.
// Opt-in (button) because Sumble's enrich call costs ~5 credits per technology.
export function TechStackSection({ domain, website, email, company, compact }: TechStackSectionProps) {
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [techs, setTechs] = useState<SumbleTech[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolvedDomain, setResolvedDomain] = useState<string | undefined>(undefined);

  const canResolve = !!(domain || website || email || company);

  const load = async () => {
    setLoading(true);
    setError(null);
    setVerified(false);
    try {
      const res = await getCompanyTechStack({ data: { domain, website, email, company } });
      if (!res.found) {
        setTechs([]);
        setError(res.error || "No tech stack available.");
        return;
      }
      // Most-used first, then most recently corroborated.
      const sorted = [...res.technologies].sort(
        (a, b) => (b.jobsCount ?? 0) - (a.jobsCount ?? 0) || (b.lastJobPost || "").localeCompare(a.lastJobPost || ""),
      );
      setTechs(sorted);
      setResolvedDomain(res.domain);
      if (sorted.length === 0) setError("No technologies detected in this company's recent job posts.");
    } catch (e) {
      console.error("TechStackSection: load failed", e);
      setError("Tech stack lookup failed — see console.");
    } finally {
      setLoading(false);
    }
  };

  // Opt-in: confirm the detected technologies against Sumble's enrich checker to
  // attach confidence scores. Costs ~5 credits per technology, so it's gated.
  const verify = async () => {
    if (!resolvedDomain || !techs || techs.length === 0) return;
    setVerifying(true);
    setError(null);
    try {
      const res = await verifyCompanyTechStack({
        data: { domain: resolvedDomain, technologies: techs.map((t) => t.name) },
      });
      if (!res.found) {
        setError(res.error || "Confidence check failed.");
        return;
      }
      const conf = new Map(res.technologies.map((t) => [t.name.toLowerCase(), t]));
      setTechs((prev) =>
        prev
          ? prev
              .map((t) => {
                const v = conf.get(t.name.toLowerCase());
                return v
                  ? { ...t, confidence: v.confidence ?? t.confidence, peopleCount: v.peopleCount ?? t.peopleCount }
                  : t;
              })
              .sort(
                (a, b) =>
                  (b.confidence ?? -1) - (a.confidence ?? -1) || (b.jobsCount ?? 0) - (a.jobsCount ?? 0),
              )
          : prev,
      );
      setVerified(true);
    } catch (e) {
      console.error("TechStackSection: verify failed", e);
      setError("Confidence check failed — see console.");
    } finally {
      setVerifying(false);
    }
  };

  const headerClass = compact
    ? "text-[10px] uppercase tracking-widest font-semibold text-muted-foreground"
    : "text-xs uppercase tracking-wider font-semibold text-muted-foreground";

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className={`${headerClass} flex items-center gap-1.5`}>
          <Cpu className="h-3.5 w-3.5" /> Tech Stack
        </h3>
        {canResolve && (
          <div className="flex items-center gap-1.5">
            {techs !== null && techs.length > 0 && !verified && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                onClick={verify}
                disabled={verifying || loading}
                title="Confirm these technologies and add confidence scores (~5 Sumble credits per technology)"
              >
                {verifying ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <BadgeCheck className="h-3 w-3 mr-1" />}
                {verifying ? "Verifying…" : "Verify confidence"}
              </Button>
            )}
            <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={load} disabled={loading || verifying}>
              {loading ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : techs === null ? (
                <Cpu className="h-3 w-3 mr-1" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              {loading ? "Loading…" : techs === null ? "Load tech stack" : "Refresh"}
            </Button>
          </div>
        )}
      </div>

      {!canResolve ? (
        <p className="text-xs text-muted-foreground">No company/domain on this record to look up.</p>
      ) : techs === null ? (
        <p className="text-xs text-muted-foreground">
          Load technologies detected in this company's recent job posts (via Sumble). Optionally verify them
          afterward to add confidence scores.
        </p>
      ) : error && techs.length === 0 ? (
        <p className="text-xs text-muted-foreground">{error}</p>
      ) : (
        <>
          {resolvedDomain && (
            <p className="text-[10px] text-muted-foreground mb-2">
              Detected for <span className="font-medium text-foreground">{resolvedDomain}</span> · from recent job posts
              {verified ? " · confidence verified" : ""}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {techs.map((t) => {
              const evidence = [
                t.jobsCount ? `${t.jobsCount} job${t.jobsCount !== 1 ? "s" : ""}` : "",
                t.peopleCount ? `${t.peopleCount} ${t.peopleCount !== 1 ? "people" : "person"}` : "",
              ].filter(Boolean).join(" · ");
              return (
                <div
                  key={t.name}
                  className="rounded-md border border-border bg-card px-2 py-1.5"
                  title={evidence || undefined}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium">{t.name}</span>
                    {typeof t.confidence === "number" && (
                      <Badge variant="outline" className={`text-[9px] gap-0.5 ${confidenceClass(t.confidence)}`}>
                        <BadgeCheck className="h-2.5 w-2.5" /> {t.confidence}%
                      </Badge>
                    )}
                  </div>
                  <div className="text-[9px] text-muted-foreground mt-0.5">
                    {t.lastJobPost ? `Verified ${t.lastJobPost}` : "Detected"}
                    {evidence ? ` · ${evidence}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
