import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Cpu,
  BadgeCheck,
  RefreshCw,
  Building2,
  UserCheck,
  UserX,
  HelpCircle,
  Save,
} from "lucide-react";
import {
  getCompanyTechStack,
  enrichTechUsage,
  annotateSavedTechStack,
} from "@/utils/sumble.functions";
import { mergeContactFields } from "@/utils/sheets.functions";
import type { SumbleTech } from "@/utils/sumble.server";
import { assessTechDecisionMaker } from "@/lib/tech-decision-maker";
import { parseTechStackField, serializeTechStackField } from "@/lib/tech-stack-storage";
import { toast } from "sonner";

interface TechStackSectionProps {
  /** Any of these is used to resolve the company domain (most specific first). */
  domain?: string;
  website?: string;
  email?: string;
  company?: string;
  /** Contact title — used to assess technology buying authority. */
  title?: string;
  /** Smaller header style for the contact sheet (vs. portfolio panel). */
  compact?: boolean;
  /**
   * Persisted Contacts "tech stack" cell (JSON v1 or legacy comma list).
   * When present, shown immediately and can be refreshed / usage-checked later.
   */
  savedTechStack?: string;
  /** Contact identity for sheet writes. Omit on PortCo panels (no persist). */
  contactEmail?: string;
  contactUrid?: string;
  /** Called after a successful sheet save so parent contact state stays in sync. */
  onTechStackSaved?: (serialized: string) => void;
}

function confidenceClass(c: number): string {
  if (c >= 66) return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (c >= 33) return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-muted text-muted-foreground border-border";
}

function decisionBannerClass(level: string): string {
  if (level === "primary") return "border-primary/30 bg-primary/5 text-foreground";
  if (level === "influencer") return "border-border bg-muted/40 text-foreground";
  if (level === "unlikely") return "border-border bg-card text-muted-foreground";
  return "border-border bg-muted/30 text-muted-foreground";
}

function sortTechs(list: SumbleTech[]): SumbleTech[] {
  return [...list].sort(
    (a, b) =>
      (b.portcoSimilarity?.length ?? 0) - (a.portcoSimilarity?.length ?? 0) ||
      (b.confidence ?? -1) - (a.confidence ?? -1) ||
      (b.jobsCount ?? 0) - (a.jobsCount ?? 0) ||
      (b.lastJobPost || "").localeCompare(a.lastJobPost || ""),
  );
}

/**
 * Tech Stack — technologies the COMPANY is using/hiring for (Sumble).
 * On contact sheets, loads persist to the Contacts "tech stack" column so they
 * can be shown and actioned later without re-spending Sumble credits.
 */
export function TechStackSection({
  domain,
  website,
  email,
  company,
  title,
  compact,
  savedTechStack,
  contactEmail,
  contactUrid,
  onTechStackSaved,
}: TechStackSectionProps) {
  const canPersist = !!(contactEmail || contactUrid);
  const initial = useMemo(() => parseTechStackField(savedTechStack), [savedTechStack]);

  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [checked, setChecked] = useState(!!initial?.usageChecked);
  const [techs, setTechs] = useState<SumbleTech[] | null>(
    initial?.technologies?.length ? sortTechs(initial.technologies) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [resolvedDomain, setResolvedDomain] = useState<string | undefined>(initial?.domain);
  const [fetchedAt, setFetchedAt] = useState<string>(initial?.fetchedAt || "");
  const [dirty, setDirty] = useState(false); // local changes not yet saved

  const canResolve = !!(domain || website || email || company);
  const decision = useMemo(
    () => (title !== undefined ? assessTechDecisionMaker(title) : null),
    [title],
  );

  // Keep local state in sync when parent contact.techStack changes (e.g. after bulk load).
  useEffect(() => {
    const parsed = parseTechStackField(savedTechStack);
    if (!parsed?.technologies.length) return;
    setTechs(sortTechs(parsed.technologies));
    setResolvedDomain(parsed.domain);
    setFetchedAt(parsed.fetchedAt);
    setChecked(!!parsed.usageChecked);
    setDirty(false);
    setError(null);
  }, [savedTechStack]);

  // Refresh PortCo notes for a hydrated legacy/saved stack (no Sumble spend).
  useEffect(() => {
    if (!initial?.technologies.length) return;
    const needsNotes = initial.technologies.some((t) => !t.portcoSimilarity);
    if (!needsNotes) return;
    let cancelled = false;
    setAnnotating(true);
    annotateSavedTechStack({ data: { technologies: initial.technologies.map((t) => t.name) } })
      .then(async (res) => {
        if (cancelled) return;
        const byName = new Map(res.technologies.map((t) => [t.name.toLowerCase(), t]));
        const next = sortTechs(
          (initial.technologies || []).map((t) => {
            const a = byName.get(t.name.toLowerCase());
            return a ? { ...t, portcoSimilarity: a.portcoSimilarity } : t;
          }),
        );
        setTechs(next);
        if (canPersist) {
          const serialized = serializeTechStackField({
            domain: initial.domain,
            fetchedAt: initial.fetchedAt || new Date().toISOString(),
            usageChecked: !!initial.usageChecked,
            technologies: next,
          });
          try {
            const saveRes = await mergeContactFields({
              data: {
                email: contactEmail || "",
                urid: contactUrid,
                fields: { techStack: serialized },
                source: "user",
              },
            });
            if (!cancelled && saveRes.success && saveRes.written.length > 0) {
              setDirty(false);
              onTechStackSaved?.(serialized);
            } else if (!cancelled) {
              setDirty(true);
            }
          } catch {
            if (!cancelled) setDirty(true);
          }
        } else {
          setDirty(true);
        }
      })
      .catch((e) => console.error("TechStackSection: annotate saved failed", e))
      .finally(() => {
        if (!cancelled) setAnnotating(false);
      });
    return () => {
      cancelled = true;
    };
    // Hydrate annotations once per saved payload
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedTechStack]);

  const persist = async (
    nextTechs: SumbleTech[],
    opts: { domain?: string; usageChecked?: boolean; fetchedAt?: string },
  ) => {
    if (!canPersist) return false;
    const serialized = serializeTechStackField({
      domain: opts.domain ?? resolvedDomain,
      fetchedAt: opts.fetchedAt ?? (fetchedAt || new Date().toISOString()),
      usageChecked: opts.usageChecked ?? checked,
      technologies: nextTechs,
    });
    setSaving(true);
    try {
      const res = await mergeContactFields({
        data: {
          email: contactEmail || "",
          urid: contactUrid,
          fields: { techStack: serialized },
          source: "user",
        },
      });
      if (!res.success || res.written.length === 0) {
        toast.error("Couldn't save tech stack to the sheet.");
        return false;
      }
      setDirty(false);
      onTechStackSaved?.(serialized);
      return true;
    } catch (e) {
      console.error("TechStackSection: save failed", e);
      toast.error("Couldn't save tech stack to the sheet.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    setChecked(false);
    try {
      const res = await getCompanyTechStack({ data: { domain, website, email, company } });
      if (!res.found) {
        setTechs([]);
        setError(res.error || "No tech stack available.");
        return;
      }
      const sorted = sortTechs(res.technologies);
      const at = new Date().toISOString();
      setTechs(sorted);
      setResolvedDomain(res.domain);
      setFetchedAt(at);
      if (sorted.length === 0) {
        setError("No technologies detected in this company's recent job posts.");
        return;
      }
      if (canPersist) {
        const ok = await persist(sorted, {
          domain: res.domain,
          usageChecked: false,
          fetchedAt: at,
        });
        if (ok) toast.success(`Saved ${sorted.length} technologies to the sheet.`);
      }
    } catch (e) {
      console.error("TechStackSection: load failed", e);
      setError("Tech stack lookup failed — see console.");
    } finally {
      setLoading(false);
    }
  };

  const checkUsage = async () => {
    if (!resolvedDomain || !techs || techs.length === 0) return;
    setChecking(true);
    setError(null);
    try {
      const res = await enrichTechUsage({
        data: { domain: resolvedDomain, technologies: techs.map((t) => t.name) },
      });
      if (!res.found) {
        setError(res.error || "Usage check failed.");
        return;
      }
      const byName = new Map(res.technologies.map((t) => [t.name.toLowerCase(), t]));
      const merged = sortTechs(
        techs.map((t) => {
          const u = byName.get(t.name.toLowerCase());
          return u
            ? {
                ...t,
                mentionCount: u.mentionCount,
                usedCount: u.usedCount,
                confidence: u.confidence,
                portcoSimilarity: u.portcoSimilarity?.length
                  ? u.portcoSimilarity
                  : t.portcoSimilarity,
              }
            : t;
        }),
      );
      setTechs(merged);
      setChecked(true);
      if (canPersist) {
        const ok = await persist(merged, { usageChecked: true });
        if (ok) toast.success("Usage confirmation saved to the sheet.");
      }
    } catch (e) {
      console.error("TechStackSection: usage check failed", e);
      setError("Usage check failed — see console.");
    } finally {
      setChecking(false);
    }
  };

  const saveNow = async () => {
    if (!techs || techs.length === 0) return;
    const ok = await persist(techs, { usageChecked: checked });
    if (ok) toast.success("Tech stack saved to the sheet.");
  };

  const headerClass = compact
    ? "text-[10px] uppercase tracking-widest font-semibold text-muted-foreground"
    : "text-xs uppercase tracking-wider font-semibold text-muted-foreground";

  const DecisionIcon =
    decision?.level === "primary" || decision?.level === "influencer"
      ? UserCheck
      : decision?.level === "unknown"
        ? HelpCircle
        : UserX;

  const fetchedLabel = fetchedAt
    ? (() => {
        const d = Date.parse(fetchedAt);
        if (Number.isNaN(d)) return fetchedAt;
        return new Date(d).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
      })()
    : null;

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h3 className={`${headerClass} flex items-center gap-1.5`}>
          <Cpu className="h-3.5 w-3.5" /> Company Tech Stack
          {techs && techs.length > 0 && canPersist && !dirty && (
            <Badge variant="outline" className="text-[9px] font-normal normal-case tracking-normal">
              saved
            </Badge>
          )}
          {dirty && canPersist && (
            <Badge variant="outline" className="text-[9px] font-normal normal-case tracking-normal text-amber-700 border-amber-200">
              unsaved notes
            </Badge>
          )}
        </h3>
        {canResolve && (
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {canPersist && dirty && techs && techs.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                onClick={saveNow}
                disabled={saving || loading || checking}
              >
                {saving ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <Save className="h-3 w-3 mr-1" />
                )}
                Save
              </Button>
            )}
            {techs !== null && techs.length > 0 && !checked && resolvedDomain && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                onClick={checkUsage}
                disabled={checking || loading || saving}
                title="Confirm which technologies the company actively uses, then save"
              >
                {checking ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <BadgeCheck className="h-3 w-3 mr-1" />
                )}
                {checking ? "Checking…" : "Confirm usage"}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={load}
              disabled={loading || checking || saving}
            >
              {loading ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : techs === null ? (
                <Cpu className="h-3 w-3 mr-1" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              {loading
                ? "Loading…"
                : techs === null
                  ? "Load & save"
                  : canPersist
                    ? "Refresh & save"
                    : "Refresh"}
            </Button>
          </div>
        )}
      </div>

      {decision && (
        <div
          className={`mb-3 rounded-md border px-2.5 py-2 text-[11px] leading-snug flex gap-2 ${decisionBannerClass(decision.level)}`}
        >
          <DecisionIcon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-foreground">
              {decision.level === "primary"
                ? "Likely tech decision-maker"
                : decision.level === "influencer"
                  ? "May influence technology choices"
                  : decision.level === "unknown"
                    ? "Decision-maker status unknown"
                    : "Unlikely to choose the tech stack"}
            </p>
            <p className="text-muted-foreground mt-0.5">{decision.reason}</p>
          </div>
        </div>
      )}

      {!canResolve ? (
        <p className="text-xs text-muted-foreground">
          No company/domain on this record to look up technologies in use.
        </p>
      ) : techs === null ? (
        <p className="text-xs text-muted-foreground">
          Load technologies this <span className="font-medium text-foreground">company</span> is
          hiring for / using. Results are{" "}
          {canPersist ? (
            <span className="font-medium text-foreground">saved to the sheet</span>
          ) : (
            "shown here"
          )}{" "}
          so you can return later — confirm usage, review PortCo overlap, and act without re-pulling.
        </p>
      ) : error && techs.length === 0 ? (
        <p className="text-xs text-muted-foreground">{error}</p>
      ) : (
        <>
          <p className="text-[10px] text-muted-foreground mb-2">
            {resolvedDomain ? (
              <>
                Technologies at{" "}
                <span className="font-medium text-foreground">{resolvedDomain}</span>
              </>
            ) : (
              "Saved company technologies"
            )}
            {fetchedLabel ? ` · fetched ${fetchedLabel}` : ""}
            {checked ? " · usage confirmed" : " · hiring signals"}
            {annotating ? " · updating PortCo notes…" : ""}
            {canPersist ? " · stored on contact" : ""}
          </p>
          <div className="space-y-2">
            {techs.map((t) => {
              const evidence = t.mentionCount
                ? `used in ${t.usedCount ?? 0} of ${t.mentionCount} posts`
                : t.jobsCount
                  ? `${t.jobsCount} job${t.jobsCount !== 1 ? "s" : ""}`
                  : "";
              const portcoNotes = t.portcoSimilarity || [];
              return (
                <div
                  key={t.name}
                  className={`rounded-md border bg-card px-2.5 py-2 ${
                    portcoNotes.length > 0 ? "border-primary/25" : "border-border"
                  }`}
                >
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-medium">{t.name}</span>
                    {typeof t.confidence === "number" && (
                      <Badge
                        variant="outline"
                        className={`text-[9px] gap-0.5 ${confidenceClass(t.confidence)}`}
                      >
                        <BadgeCheck className="h-2.5 w-2.5" /> {t.confidence}% used
                      </Badge>
                    )}
                    {portcoNotes.length > 0 && (
                      <Badge
                        variant="outline"
                        className="text-[9px] gap-0.5 border-primary/30 text-primary"
                      >
                        <Building2 className="h-2.5 w-2.5" /> PortCo overlap
                      </Badge>
                    )}
                  </div>
                  <div className="text-[9px] text-muted-foreground mt-0.5">
                    {t.lastJobPost ? `Seen ${t.lastJobPost}` : "Detected at company"}
                    {evidence ? ` · ${evidence}` : ""}
                  </div>
                  {portcoNotes.length > 0 && (
                    <ul className="mt-1.5 space-y-1 border-t border-border pt-1.5">
                      {portcoNotes.map((n) => (
                        <li
                          key={`${t.name}-${n.portco}-${n.source}`}
                          className="text-[10px] text-foreground/90 leading-snug flex gap-1.5"
                        >
                          <Building2 className="h-3 w-3 shrink-0 mt-0.5 text-primary" />
                          <span>
                            <span className="font-medium">{n.portco}</span>
                            <span className="text-muted-foreground"> — {n.reason}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
