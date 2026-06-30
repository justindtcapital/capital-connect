import { useEffect, useState } from "react";
import { scanSignals, fetchSignals } from "@/utils/gemini.functions";
import type { SignalScanResult, SignalRecommendation } from "@/utils/gemini.server";
import type { Contact, PortfolioCompany } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Radar, Loader2, ExternalLink, Sparkles, Mail } from "lucide-react";
import { EmailDraftDialog } from "@/components/crm/EmailDraftDialog";
import { toast } from "sonner";

// Loose company match (signals carry a free-text company string from Gemini).
function matchCompany(co: string | undefined, target: string): boolean {
  const c = (co || "").trim().toLowerCase();
  const t = target.trim().toLowerCase();
  if (!c || !t) return false;
  return c === t || c.includes(t) || (t.includes(c) && c.length > 2);
}

function urgencyClass(u?: string): string {
  const s = (u || "").toLowerCase();
  if (s.includes("high")) return "bg-red-50 text-red-700 border-red-200";
  if (s.includes("med")) return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-muted text-muted-foreground border-border";
}

// The Signals feature, scoped to a single portfolio company. Loads any signals
// already stored for this company (cheap), and can run a fresh company-scoped scan
// (Gemini + news) on demand. Mirrors the /signals page but for one PortCo.
export function PortcoSignalsPanel({ company }: { company: PortfolioCompany }) {
  const [windowDays, setWindowDays] = useState("30");
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<SignalScanResult | null>(null);
  const [draftContact, setDraftContact] = useState<Contact | null>(null);
  const [draftSeed, setDraftSeed] = useState({ purpose: "", notes: "" });
  const [draftOpen, setDraftOpen] = useState(false);

  // Show already-stored signals for this company without spending a Gemini call.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSignals()
      .then((all) => {
        if (cancelled) return;
        setResult({
          ...all,
          recommendations: all.recommendations.filter((r) => matchCompany(r.company, company.name)),
          otherSignals: all.otherSignals.filter((s) => matchCompany(s.company, company.name)),
        });
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [company.name]);

  const runScan = async () => {
    setScanning(true);
    try {
      const res = await scanSignals({ data: { windowDays: Number(windowDays), companyName: company.name } });
      if (!res.found && res.error) {
        toast.error(res.error);
      } else {
        const total = res.recommendations.length + res.otherSignals.length;
        toast.success(total > 0 ? `${total} signal${total !== 1 ? "s" : ""} for ${company.name}` : `No recent signals found for ${company.name}.`);
        setResult(res);
      }
    } catch (e) {
      console.error("PortcoSignalsPanel: scan failed", e);
      toast.error("Signal scan failed — see console.");
    } finally {
      setScanning(false);
    }
  };

  const draftFromRec = (r: SignalRecommendation) => {
    setDraftContact({
      id: `signal-${r.email}`, name: r.person, title: "", company: r.company, email: r.email,
      phone: "", address: "", prime: "", sector: "", areasOfInterest: [], temperature: "Warm",
      portCoIntros: [], eventsAttended: [], eventsInvited: [], interactions: [],
    });
    setDraftSeed({ purpose: `${r.company}: ${r.signal}`, notes: r.sourceUrl ? `Reference: ${r.sourceUrl}` : "" });
    setDraftOpen(true);
  };

  const recs = result?.recommendations ?? [];
  const others = result?.otherSignals ?? [];
  const hasAny = recs.length + others.length > 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-2">
        <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground flex items-center gap-1.5">
          <Radar className="h-3.5 w-3.5" /> Signals
        </h3>
        <div className="flex items-center gap-1.5">
          <Select value={windowDays} onValueChange={setWindowDays}>
            <SelectTrigger className="h-7 w-[88px] text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="14">14 days</SelectItem>
              <SelectItem value="30">30 days</SelectItem>
              <SelectItem value="90">90 days</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={runScan} disabled={scanning}>
            {scanning ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
            {scanning ? "Scanning…" : "Scan"}
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading signals…</p>
      ) : !hasAny ? (
        <p className="text-xs text-muted-foreground">
          No signals for {company.name} yet. Run a scan to surface recent news, funding, hiring, product, and partnership activity.
        </p>
      ) : (
        <div className="space-y-4">
          {recs.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Outreach signals ({recs.length})</p>
              {recs.map((r, i) => (
                <div key={`r-${i}`} className="rounded-md border border-border bg-card px-2.5 py-2 overflow-hidden">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                      <Badge variant="outline" className="text-[9px] shrink-0">{r.category}</Badge>
                      {r.urgency && <Badge variant="outline" className={`text-[9px] shrink-0 ${urgencyClass(r.urgency)}`}>{r.urgency}</Badge>}
                    </div>
                    {r.sourceUrl && (
                      <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer" title="Open source" className="text-muted-foreground hover:text-foreground shrink-0">
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <p className="text-xs mt-1 wrap-break-word">{r.signal}</p>
                  <div className="flex items-center justify-between gap-2 mt-1.5">
                    <span className="text-[10px] text-muted-foreground truncate">
                      {r.person}{r.timing ? ` · ${r.timing}` : ""}
                    </span>
                    {r.email && (
                      <Button variant="ghost" size="sm" className="h-6 text-[10px] shrink-0" onClick={() => draftFromRec(r)}>
                        <Mail className="h-3 w-3 mr-1" /> Draft
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {others.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Other signals ({others.length})</p>
              {others.map((s, i) => (
                <div key={`o-${i}`} className="rounded-md border border-border bg-card px-2.5 py-2 overflow-hidden">
                  <div className="flex items-start justify-between gap-2">
                    <Badge variant="outline" className="text-[9px] shrink-0">{s.category}</Badge>
                    {s.sourceUrl && (
                      <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer" title="Open source" className="text-muted-foreground hover:text-foreground shrink-0">
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <p className="text-xs mt-1 wrap-break-word">{s.summary}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <EmailDraftDialog
        open={draftOpen}
        onOpenChange={setDraftOpen}
        contact={draftContact}
        initialPurpose={draftSeed.purpose}
        initialNotes={draftSeed.notes}
      />
    </div>
  );
}
