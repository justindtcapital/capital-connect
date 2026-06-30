import { useState } from "react";
import type { PortfolioCompany, Contact, EmailActivityRecord } from "@/lib/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Building2,
  Mail,
  Phone,
  MapPin,
  Globe,
  Linkedin,
  Users,
  Calendar,
  RefreshCw,
  Pencil,
  Search,
  Link2,
  Sparkles,
  Loader2,
  ExternalLink,
  Briefcase,
  FileText,
  AlertTriangle,
} from "lucide-react";
import { ContactAvatar } from "@/components/crm/ContactAvatar";
import { getPortcoIntel, getPortcoBrief } from "@/utils/sumble.functions";
import { TechStackSection } from "@/components/crm/TechStackSection";
import { ActivitySection } from "@/components/crm/ActivitySection";
import { useAsanaActivities } from "@/lib/use-activities";
import { matchActivitiesToCompany } from "@/lib/activity-match";
import type { PortcoIntelResult, PortcoBriefResult } from "@/utils/sumble.server";
import { CustomerDiscoveryPanel } from "./CustomerDiscoveryPanel";
import { PortcoSignalsPanel } from "./PortcoSignalsPanel";
import { companyIntroInsights, type InsightNarrative } from "@/utils/insights.functions";
import { toast } from "sonner";

interface PortfolioDetailProps {
  company: PortfolioCompany | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  crmContacts?: Contact[];
  crmIntros?: Contact[];
  /** Outreach emails logged on behalf of this company (from Email Activity). */
  emails?: EmailActivityRecord[];
  onPersonClick?: (contact: Contact) => void;
}

// Approx row height (py-1.5 + 7 avatar + multi-line label) ≈ 56px. Cap visible at 4 rows ≈ 240px.
const KEY_PEOPLE_MAX_HEIGHT = "240px";

const actionBtnClass = "h-7 text-[11px] font-medium";

function getLogoUrl(website: string) {
  if (!website?.trim()) return null;
  const raw = website.trim();
  // Accept bare domains (e.g. "coactive.ai") by adding a protocol before parsing.
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withProtocol);
    return `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=128`;
  } catch {
    return null;
  }
}

export function PortfolioDetail({ company, open, onOpenChange, crmContacts = [], crmIntros = [], emails = [], onPersonClick }: PortfolioDetailProps) {
  const [syncing, setSyncing] = useState(false);
  const [fetchingPeople, setFetchingPeople] = useState(false);
  const [insight, setInsight] = useState<InsightNarrative | null>(null);
  const [insightLoading, setInsightLoading] = useState(false);
  const { activities, loading: activitiesLoading } = useAsanaActivities();

  if (!company) return null;

  const companyActivities = matchActivitiesToCompany(activities, company.name);

  // #5 — AI commonality narrative. Sends ONLY Sheets-native network data
  // (titles/sectors/types/engagement source) — never Asana intro records.
  const genCompanyInsights = async () => {
    const engagements = crmIntros.map((c) => ({
      title: c.title || "",
      sector: c.sector || "",
      type: c.contactType || "",
      source: (c.portCoEngagements || []).find((e) => e.portco === company.name)?.source || "",
    }));
    setInsightLoading(true);
    setInsight(null);
    try {
      const res = await companyIntroInsights({ data: { company: company.name, engagements } });
      setInsight(res);
      if (!res.ok && res.error) toast.error(res.error);
    } catch (e) {
      console.error("companyIntroInsights failed", e);
      toast.error("Insight generation failed — see console.");
    } finally {
      setInsightLoading(false);
    }
  };

  const handleLinkedInSync = () => {
    setSyncing(true);
    setTimeout(() => setSyncing(false), 2000);
  };

  const handleFetchPeople = () => {
    setFetchingPeople(true);
    setTimeout(() => setFetchingPeople(false), 2000);
  };

  const todayStr = new Date().toISOString().split("T")[0];
  const eventStatus = (e: typeof company.events[number]): "planned" | "completed" =>
    e.status ?? (e.date >= todayStr ? "planned" : "completed");
  const plannedEvents = company.events
    .filter((e) => eventStatus(e) === "planned")
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const completedEvents = company.events
    .filter((e) => eventStatus(e) === "completed")
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Build a unified intro feed: company-defined intros + intros logged via CRM contacts
  // (any contact whose portCoIntros includes this company's name).
  type UnifiedIntro = {
    id: string;
    date: string;
    label: string; // primary line (e.g. target name or contact name)
    sublabel: string; // company / source line
    detail: string; // outcome / note
    source: "company" | "crm";
    contact?: Contact;
    engagement?: string; // engagement-source category for CRM-logged intros
  };

  const companyIntros: UnifiedIntro[] = company.introductions.map((i) => ({
    id: `co-${i.id}`,
    date: i.date,
    label: i.targetName,
    sublabel: i.targetCompany,
    detail: `${i.outcome} · Introduced by ${i.introducedBy}`,
    source: "company",
  }));

  const crmDerivedIntros: UnifiedIntro[] = crmIntros.map((c) => {
    const introNote = (c.interactions || [])
      .filter((it) => it.type === "intro")
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
    const engagement = (c.portCoEngagements || []).find((e) => e.portco === company.name)?.source;
    return {
      id: `crm-${c.id}`,
      date: introNote?.date || c.lastContact || new Date().toISOString().split("T")[0],
      label: c.name,
      sublabel: c.company || c.title || "CRM contact",
      detail: introNote?.summary || `Intro logged in CRM to ${company.name}`,
      source: "crm",
      contact: c,
      engagement,
    };
  });

  const sortedIntros = [...companyIntros, ...crmDerivedIntros].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  // Deterministic intro stat: the most-engaged network title for this company.
  const topTitle = (() => {
    const counts = new Map<string, number>();
    for (const c of crmIntros) {
      const t = (c.title || "").trim();
      if (t) counts.set(t, (counts.get(t) || 0) + 1);
    }
    let best = "";
    let n = 0;
    for (const [t, c] of counts) if (c > n) { best = t; n = c; }
    return best;
  })();

  const logoUrl = getLogoUrl(company.website);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-hidden flex flex-col">
        <SheetHeader className="pb-4 border-b border-border shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
                {logoUrl ? (
                  <img
                    src={logoUrl}
                    alt={company.name}
                    className="h-9 w-9 object-contain"
                    onError={(e) => {
                      const target = e.currentTarget;
                      target.style.display = "none";
                      if (target.nextElementSibling) (target.nextElementSibling as HTMLElement).style.display = "";
                    }}
                  />
                ) : null}
                <span
                  className="text-lg font-bold text-primary"
                  style={logoUrl ? { display: "none" } : {}}
                >
                  {company.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                </span>
              </div>
              <div>
                <SheetTitle className="text-base">{company.name}</SheetTitle>
                <SheetDescription className="flex items-center gap-1">
                  <Building2 className="h-3 w-3" />
                  {company.sector} · {company.location}
                </SheetDescription>
              </div>
            </div>
            <Badge variant="outline" className="text-xs shrink-0">{company.domain}</Badge>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="py-5 space-y-6">
            {/* Description */}
            <section className="border-b border-border pb-4">
              <p className="text-sm text-muted-foreground">{company.description}</p>
            </section>

            {/* Company Info */}
            <section className="border-b border-border pb-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 sm:divide-x sm:divide-border">
                {/* Left column: company info */}
                <div className="min-w-0">
                  <div className="flex items-start justify-between mb-3 gap-2">
                    <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
                      Company Information
                    </h3>
                    <div className="flex flex-col items-end gap-1">
                      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px] font-medium">
                        <Pencil className="h-3 w-3 mr-1" />
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[10px] font-medium"
                        onClick={handleLinkedInSync}
                        disabled={syncing}
                      >
                        <RefreshCw className={`h-3 w-3 mr-1 ${syncing ? "animate-spin" : ""}`} />
                        {syncing ? "Syncing" : "Web Sync"}
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1.5 text-sm min-w-0">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <MapPin className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{company.location}</span>
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground min-w-0">
                      <Globe className="h-3.5 w-3.5 shrink-0" />
                      <a href={company.website} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline truncate">
                        {company.website}
                      </a>
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Linkedin className="h-3.5 w-3.5 shrink-0" />
                      <a href={company.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        LinkedIn Profile
                      </a>
                    </div>
                  </div>
                </div>

                {/* Right column: DTC Investment Profile */}
                <div className="min-w-0 sm:pl-6">
                  <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground mb-3">
                    DTC Investment Profile
                  </h3>
                  {(() => {
                    const fields = company.asanaFields || {};
                    const lowered = Object.keys(fields).reduce<Record<string, string>>((acc, k) => {
                      acc[k.toLowerCase().trim()] = fields[k];
                      return acc;
                    }, {});
                    const lookup = (aliases: string[]): string | undefined => {
                      for (const a of aliases) {
                        const v = lowered[a.toLowerCase().trim()];
                        if (v) return v;
                      }
                      return undefined;
                    };
                    const profile: { label: string; value?: string }[] = [
                      { label: "DTC Priority", value: lookup(["DTC Priority"]) },
                      { label: "Product/Market Fit", value: lookup(["GTM Marketing/PMF", "PMF", "Product Market Fit"]) },
                      { label: "DTC Investment", value: (() => {
                        const v = lookup(["DTC Investment ($M)", "DTC Investment"]);
                        return v ? `$${v}M` : undefined;
                      })() },
                      { label: "DTC Ownership", value: (() => {
                        const v = lookup(["DTC Ownership"]);
                        if (!v) return undefined;
                        const num = parseFloat(v.replace(/[%,\s]/g, ""));
                        if (isNaN(num)) return v;
                        // If value is a decimal (≤1), treat as fraction; otherwise it's already a percent.
                        const pct = num <= 1 ? num * 100 : num;
                        // Trim trailing zeros, max 2 decimals.
                        return `${parseFloat(pct.toFixed(2))}%`;
                      })() },
                      { label: "Company Stage", value: lookup(["Company Stage", "Stage"]) },
                      { label: "Lead Investor", value: lookup(["Lead Investor"]) },
                    ];
                    const hasAny = profile.some((p) => p.value);
                    return hasAny ? (
                      <dl className="space-y-1.5">
                        {profile.map((p) => (
                          <div key={p.label} className="flex justify-between gap-2 text-xs">
                            <dt className="text-muted-foreground">{p.label}</dt>
                            <dd className="text-foreground font-medium text-right truncate">{p.value || "—"}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="text-[11px] text-muted-foreground italic">
                        No Asana data available for this company.
                      </p>
                    );
                  })()}
                </div>
              </div>
            </section>

            {/* BD / GTM activity from Asana, matched to this company */}
            {(activitiesLoading || companyActivities.length > 0) && (
              <section className="border-b border-border pb-6">
                <ActivitySection activities={companyActivities} loading={activitiesLoading} enableSourcing defaultCompany={company.name} />
              </section>
            )}

            {/* Signals — recent news/activity for this PortCo (scoped scan) */}
            <section className="border-b border-border pb-6">
              <PortcoSignalsPanel company={company} />
            </section>

            {/* Sumble Intelligence */}
            <section className="border-b border-border pb-6">
              <PortcoIntelPanel company={company} />
            </section>

            {/* Customer Discovery — likely customers for this portfolio company */}
            <section className="border-b border-border pb-6">
              <CustomerDiscoveryPanel company={company} />
            </section>

            {/* Key People — pulled from CRM contacts whose email domain matches the company website */}
            <section className="border-b border-border pb-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
                  Key People ({crmContacts.length + company.employees.length})
                </h3>
                <Button
                  variant="outline"
                  size="sm"
                  className={actionBtnClass}
                  onClick={handleFetchPeople}
                  disabled={fetchingPeople}
                >
                  <Linkedin className={`h-3 w-3 mr-1 ${fetchingPeople ? "animate-pulse" : ""}`} />
                  {fetchingPeople ? "Fetching..." : "Get more from LinkedIn"}
                </Button>
              </div>
              {crmContacts.length === 0 && company.employees.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No CRM contacts matched this company's domain yet. Tag contacts with sector "Portfolio" and use a matching email domain to surface them here.
                </p>
              ) : (
                <div
                  className="space-y-1 overflow-y-auto pr-1 border-t border-border/50"
                  style={{ maxHeight: KEY_PEOPLE_MAX_HEIGHT }}
                >
                  {crmContacts.map((contact) => (
                    <button
                      key={contact.id}
                      type="button"
                      onClick={() => onPersonClick?.(contact)}
                      className="w-full flex items-center justify-between gap-2 py-1.5 px-2 -mx-2 rounded-md hover:bg-accent/50 transition-colors text-left border-b border-border/30 last:border-b-0"
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <ContactAvatar contact={contact} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-foreground truncate">{contact.name}</p>
                          <p className="text-[10px] text-muted-foreground truncate">
                            {contact.title || "—"}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5">
                            {contact.email && (
                              <span className="text-[10px] text-muted-foreground truncate flex items-center gap-1 min-w-0">
                                <Mail className="h-2.5 w-2.5 shrink-0" />
                                <span className="truncate">{contact.email}</span>
                              </span>
                            )}
                            {contact.phone && (
                              <span className="text-[10px] text-muted-foreground flex items-center gap-1 shrink-0">
                                <Phone className="h-2.5 w-2.5" />
                                {contact.phone}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div
                        className="flex items-center gap-1.5 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {contact.email && (
                          <a
                            href={`mailto:${contact.email}`}
                            className="text-muted-foreground hover:text-foreground p-1"
                            title={`Email ${contact.email}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Mail className="h-3.5 w-3.5" />
                          </a>
                        )}
                        {contact.phone && (
                          <a
                            href={`tel:${contact.phone}`}
                            className="text-muted-foreground hover:text-foreground p-1"
                            title={`Call ${contact.phone}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Phone className="h-3.5 w-3.5" />
                          </a>
                        )}
                        {contact.linkedinUrl && (
                          <a
                            href={contact.linkedinUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-primary p-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Linkedin className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                    </button>
                  ))}
                  {company.employees.map((emp) => (
                    <div key={emp.id} className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-b-0">
                      <div className="flex items-center gap-2">
                        <div className="h-7 w-7 rounded-full bg-accent flex items-center justify-center">
                          <span className="text-[10px] font-semibold text-foreground">
                            {emp.name.split(" ").map((n) => n[0]).join("")}
                          </span>
                        </div>
                        <div>
                          <p className="text-xs font-medium text-foreground">{emp.name}</p>
                          <p className="text-[10px] text-muted-foreground">{emp.title}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <a href={`mailto:${emp.email}`} className="text-muted-foreground hover:text-foreground">
                          <Mail className="h-3.5 w-3.5" />
                        </a>
                        <a href={emp.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary">
                          <Linkedin className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Events Timeline */}
            <section className="border-b border-border pb-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
                  Events Timeline
                </h3>
                <Button variant="outline" size="sm" className={actionBtnClass}>
                  <RefreshCw className="h-3 w-3 mr-1" />
                  Sync with Asana
                </Button>
              </div>
              {plannedEvents.length === 0 && completedEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground">No events recorded</p>
              ) : (
                <div className="max-h-72 overflow-y-auto pr-1 space-y-4">
                  {plannedEvents.length > 0 && (
                    <div>
                      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                        Planned ({plannedEvents.length})
                      </h4>
                      <div className="space-y-0">
                        {plannedEvents.map((event, idx) => (
                          <div key={event.id} className="flex gap-3 relative">
                            <div className="flex flex-col items-center">
                              <div className="h-2 w-2 rounded-full bg-primary shrink-0 mt-1.5" />
                              {idx < plannedEvents.length - 1 && <div className="w-px flex-1 bg-border" />}
                            </div>
                            <div className="pb-3 flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <Badge variant="outline" className="text-[10px] shrink-0">Planned</Badge>
                                {event.eventRole && (
                                  <Badge variant="secondary" className="text-[10px] capitalize shrink-0">{event.eventRole}</Badge>
                                )}
                                <span className="text-xs font-medium text-foreground truncate">{event.name}</span>
                              </div>
                              <span className="text-[10px] text-muted-foreground">{event.date}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {completedEvents.length > 0 && (
                    <div>
                      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                        Completed ({completedEvents.length})
                      </h4>
                      <div className="space-y-0">
                        {completedEvents.map((event, idx) => (
                          <div key={event.id} className="flex gap-3 relative">
                            <div className="flex flex-col items-center">
                              <div className="h-2 w-2 rounded-full bg-muted-foreground/60 shrink-0 mt-1.5" />
                              {idx < completedEvents.length - 1 && <div className="w-px flex-1 bg-border" />}
                            </div>
                            <div className="pb-3 flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <Badge variant="outline" className="text-[10px] shrink-0">Completed</Badge>
                                {event.eventRole && (
                                  <Badge variant="secondary" className="text-[10px] capitalize shrink-0">{event.eventRole}</Badge>
                                )}
                                <span className="text-xs font-medium text-foreground truncate">{event.name}</span>
                              </div>
                              <span className="text-[10px] text-muted-foreground">{event.date}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
            <section>
              <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground mb-3">
                Introductions ({sortedIntros.length})
              </h3>

              {/* #5 — intro insights: deterministic stats always; Claude on demand */}
              {sortedIntros.length > 0 && (
                <div className="mb-3 rounded-md border border-border bg-muted/20 p-2.5 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] text-muted-foreground">
                      <span className="font-semibold text-foreground">{sortedIntros.length}</span> total ·{" "}
                      <span className="font-semibold text-foreground">{crmIntros.length}</span> from network
                      {topTitle && <> · most engaged: <span className="text-foreground">{topTitle}</span></>}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className={actionBtnClass}
                      onClick={genCompanyInsights}
                      disabled={insightLoading || crmIntros.length === 0}
                      title={crmIntros.length === 0 ? "Needs network contacts engaged with this company" : "AI commonality insights (network data only)"}
                    >
                      {insightLoading ? (
                        <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Thinking…</>
                      ) : (
                        <><Sparkles className="h-3 w-3 mr-1" /> Generate insights</>
                      )}
                    </Button>
                  </div>
                  {insight?.ok && (
                    <div className="space-y-1.5 border-t border-border pt-2">
                      {insight.summary && <p className="text-[11px] text-foreground">{insight.summary}</p>}
                      {insight.commonalities && insight.commonalities.length > 0 && (
                        <div>
                          <span className="text-[9px] uppercase tracking-wider font-semibold text-muted-foreground">Commonalities</span>
                          <ul className="list-disc pl-4 text-[11px] text-muted-foreground">
                            {insight.commonalities.map((c, i) => <li key={i}>{c}</li>)}
                          </ul>
                        </div>
                      )}
                      {insight.suggestions && insight.suggestions.length > 0 && (
                        <div>
                          <span className="text-[9px] uppercase tracking-wider font-semibold text-muted-foreground">Suggested next intros</span>
                          <ul className="list-disc pl-4 text-[11px] text-muted-foreground">
                            {insight.suggestions.map((c, i) => <li key={i}>{c}</li>)}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {sortedIntros.length > 0 ? (
                <div className="max-h-64 overflow-y-auto pr-1 space-y-0">
                  {sortedIntros.map((intro, idx) => {
                    const clickable = intro.source === "crm" && intro.contact;
                    return (
                      <div
                        key={intro.id}
                        className={`flex gap-3 relative ${clickable ? "cursor-pointer hover:bg-accent/40 rounded-md -mx-1 px-1" : ""}`}
                        onClick={() => clickable && intro.contact && onPersonClick?.(intro.contact)}
                      >
                        <div className="flex flex-col items-center">
                          <div className={`h-2 w-2 rounded-full shrink-0 mt-1.5 ${intro.source === "crm" ? "bg-accent-foreground" : "bg-primary"}`} />
                          {idx < sortedIntros.length - 1 && (
                            <div className="w-px flex-1 bg-border" />
                          )}
                        </div>
                        <div className="pb-4 flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="text-[10px] shrink-0">
                              {intro.sublabel}
                            </Badge>
                            <span className="text-xs font-medium text-foreground truncate">{intro.label}</span>
                          </div>
                          <span className="text-[10px] text-muted-foreground">{intro.date}</span>
                          {intro.source !== "crm" ? (
                            <p className="text-[10px] text-muted-foreground/80 mt-0.5">{intro.detail}</p>
                          ) : (
                            intro.engagement && (
                              <p className="text-[10px] text-muted-foreground/80 mt-0.5 capitalize">
                                {intro.engagement}
                              </p>
                            )
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No introductions logged yet</p>
              )}
            </section>

            <section>
              <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground mb-3">
                Outreach ({emails.length})
              </h3>
              {emails.length > 0 ? (
                <div className="max-h-48 overflow-y-auto pr-1 space-y-1.5">
                  {emails.map((e, i) => (
                    <div key={`${e.contactEmail}-${i}`} className="border border-border rounded px-2 py-1.5">
                      <div className="text-xs font-medium text-foreground truncate">
                        {e.subject || "(no subject)"}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {e.contactEmail}
                        {e.timestamp ? ` · ${e.timestamp.slice(0, 10)}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No outreach emails logged for this company yet</p>
              )}
            </section>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

// ─── Sumble PortCo Intelligence ─────────────────────────────────
function PortcoIntelPanel({ company }: { company: PortfolioCompany }) {
  const [loading, setLoading] = useState(false);
  const [intel, setIntel] = useState<PortcoIntelResult | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [brief, setBrief] = useState<PortcoBriefResult | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);

  const load = async (force = false) => {
    setLoading(true);
    setBrief(null);
    try {
      const res = await getPortcoIntel({
        data: { name: company.name, website: company.website, location: company.location, force },
      });
      if (res.errorCode === "no_key") {
        setNotConfigured(true);
        return;
      }
      if (!res.found && res.error) {
        toast.error(res.error);
        return;
      }
      setIntel(res);
      // Show a previously-saved brief immediately (no re-purchase).
      if (res.brief?.body) setBrief({ found: true, brief: res.brief });
      if (res.notFound) toast.info(`${company.name} wasn't found in Sumble's database.`);
      else if (force) toast.success("Refreshed from Sumble");
    } catch (e) {
      console.error("getPortcoIntel failed", e);
      toast.error("Sumble request failed — see console.");
    } finally {
      setLoading(false);
    }
  };

  const loadBrief = async () => {
    if (!intel?.org) return;
    setBriefLoading(true);
    try {
      const res = await getPortcoBrief({ data: { organizationId: intel.org.id, companyName: company.name } });
      if (!res.found && res.error) {
        toast.error(res.error);
        return;
      }
      setBrief(res);
      if (res.pending) toast.info("Sumble is generating the brief — retry in a few seconds.");
    } catch (e) {
      console.error("getPortcoBrief failed", e);
      toast.error("Brief request failed — see console.");
    } finally {
      setBriefLoading(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground flex items-center gap-1.5">
          <Sparkles className="h-3 w-3 text-primary" /> Sumble Intelligence
        </h3>
        {intel && !intel.notFound && (
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={() => load(true)} disabled={loading}>
            <RefreshCw className={`h-3 w-3 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        )}
      </div>

      {notConfigured ? (
        <div className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
          Sumble isn't connected. Add <span className="font-mono">SUMBLE_API_KEY</span> to your{" "}
          <span className="font-mono">.env</span> to enable company intelligence.
        </div>
      ) : !intel ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Pull hiring signals and an AI brief for {company.name} from Sumble.
          </p>
          <Button size="sm" className="h-7 text-[11px] shrink-0" onClick={() => load()} disabled={loading}>
            {loading ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Loading…</> : <><Sparkles className="h-3 w-3 mr-1" /> Load intel</>}
          </Button>
        </div>
      ) : intel.notFound ? (
        <p className="text-xs text-muted-foreground">
          {company.name} wasn't found in Sumble's database. Try refreshing, or check the company's website is correct.
        </p>
      ) : (
        <div className="space-y-4">
          {/* Matched org + cache/credits */}
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">
              Matched: <span className="text-foreground font-medium">{intel.org?.name}</span>
              {intel.org?.domain && <span className="text-muted-foreground"> · {intel.org.domain}</span>}
            </span>
            <span className="text-muted-foreground flex items-center gap-1.5">
              {intel.fetchedAt && (
                <span title={intel.cached ? "Loaded from saved cache — no credits spent" : "Freshly fetched from Sumble"}>
                  {intel.cached ? "Saved" : "Fetched"} {intel.fetchedAt}
                </span>
              )}
              {intel.credits?.remaining != null && (
                <span>· {intel.credits.remaining.toLocaleString()} credits</span>
              )}
            </span>
          </div>

          {/* Hiring signals */}
          <div>
            <h4 className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5 flex items-center gap-1">
              <Briefcase className="h-3 w-3" /> Hiring signals ({intel.jobs.length})
            </h4>
            {intel.jobs.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No recent job postings found.</p>
            ) : (
              <div className="space-y-1.5">
                {intel.jobs.map((j) => (
                  <div key={j.id} className="border border-border rounded px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium truncate">{j.title}</span>
                      {j.url && (
                        <a href={j.url} target="_blank" rel="noopener noreferrer" className="text-primary shrink-0" title="View posting">
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground mt-0.5">
                      {j.jobFunction && <span>{j.jobFunction}</span>}
                      {j.teams && <span>· {j.teams}</span>}
                      {j.location && <span>· {j.location}</span>}
                      {j.date && <span>· {j.date.split("T")[0]}</span>}
                    </div>
                    {j.technologies && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {j.technologies.split(/,\s*/).slice(0, 6).map((t) => (
                          <Badge key={t} variant="secondary" className="text-[9px] px-1 py-0">{t}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Intelligence brief */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <h4 className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground flex items-center gap-1">
                <FileText className="h-3 w-3" /> Intelligence brief
              </h4>
              {!brief?.brief && (
                <Button variant="outline" size="sm" className="h-6 px-1.5 text-[10px]" onClick={loadBrief} disabled={briefLoading}>
                  {briefLoading ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> …</> : (brief?.pending ? "Retry" : "Generate (~50 cr)")}
                </Button>
              )}
            </div>
            {brief?.pending && (
              <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Sumble is generating the brief — click Retry shortly.
              </p>
            )}
            {brief?.brief?.body && (
              <div className="rounded border border-border bg-muted/30 p-2.5">
                {brief.brief.title && <div className="text-xs font-semibold mb-1">{brief.brief.title}</div>}
                <p className="text-[11px] text-muted-foreground whitespace-pre-wrap">{brief.brief.body}</p>
                {brief.brief.url && (
                  <a href={brief.brief.url} target="_blank" rel="noopener noreferrer" className="text-primary text-[10px] hover:underline inline-flex items-center gap-0.5 mt-1.5">
                    Open in Sumble <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </div>
            )}
            {!brief && (
              <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> The brief is a paid call (~50 credits) — generated on demand.
              </p>
            )}
          </div>

          {/* Tech Stack (Sumble enrich) */}
          <TechStackSection domain={intel.org?.domain} website={company.website} company={company.name} compact />
        </div>
      )}
    </div>
  );
}
