import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { BriefingData, BriefingAction, BriefingActionKind } from "@/lib/briefing";
import type { Contact } from "@/lib/types";
import { relativeTime } from "@/lib/signal-feed";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmailDraftDialog } from "@/components/crm/EmailDraftDialog";
import {
  Sparkles,
  Loader2,
  Flame,
  Radar,
  Bell,
  TrendingUp,
  ArrowRight,
  ExternalLink,
  Megaphone,
  Mail,
  Building2,
  Swords,
} from "lucide-react";

const CAT_CLASS: Record<string, string> = {
  "Funding/M&A": "bg-emerald-50 text-emerald-700 border-emerald-200",
  "Product/Milestone": "bg-blue-50 text-blue-700 border-blue-200",
  "Partnership/Customer Win": "bg-cyan-50 text-cyan-700 border-cyan-200",
  "Executive Movement": "bg-amber-50 text-amber-700 border-amber-200",
  "Crisis/Regulatory": "bg-red-50 text-red-700 border-red-200",
};

const ACTION_ICON: Record<BriefingActionKind, { icon: typeof Mail; cls: string }> = {
  "follow-up": { icon: Bell, cls: "text-red-600" },
  email: { icon: Mail, cls: "text-primary" },
  broadcast: { icon: Megaphone, cls: "text-primary" },
  intro: { icon: Swords, cls: "text-violet-600" },
};

// Build a minimal Contact so we can reuse the CRM email-draft dialog.
function personToContact(name: string, email: string, company: string): Contact {
  return {
    id: `brief-${email || name}`,
    name,
    title: "",
    company,
    email,
    phone: "",
    address: "",
    prime: "",
    sector: "",
    areasOfInterest: [],
    temperature: "Warm",
    portCoIntros: [],
    eventsAttended: [],
    eventsInvited: [],
    interactions: [],
  };
}

function ActionRow({ a, onEmail }: { a: BriefingAction; onEmail: (a: BriefingAction) => void }) {
  const meta = ACTION_ICON[a.kind];
  const Icon = meta.icon;
  const inner = (
    <>
      <div className="h-7 w-7 rounded-lg bg-muted flex items-center justify-center shrink-0">
        <Icon className={`h-3.5 w-3.5 ${meta.cls}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground truncate">{a.label}</p>
        {a.detail && <p className="text-[11px] text-muted-foreground truncate">{a.detail}</p>}
      </div>
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    </>
  );
  const cls =
    "w-full text-left flex items-center gap-3 py-2.5 -mx-1 px-1 rounded-md hover:bg-accent transition-colors";

  // Email an attributed person → open the draft dialog right here.
  if (a.kind === "email" && a.email) {
    return (
      <button type="button" onClick={() => onEmail(a)} className={cls}>
        {inner}
      </button>
    );
  }
  // Follow up → open that exact contact in Network.
  if (a.kind === "follow-up") {
    return (
      <Link
        to="/crm"
        search={(a.email ? { contact: a.email } : undefined) as never}
        className={cls}
      >
        {inner}
      </Link>
    );
  }
  // Broadcast → Signals; everything else → the company brief.
  if (a.kind === "broadcast") {
    return (
      <Link to="/signals" className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <Link
      to="/companies"
      search={(a.company ? { c: a.company } : undefined) as never}
      className={cls}
    >
      {inner}
    </Link>
  );
}

// The Daily Briefing surface, reusable on Home. Greeting/date are owned by the
// host page; this renders the briefing itself (summary, priorities, buying
// windows, actions) plus its own generate/regenerate control.
export function DailyBriefing({
  briefing,
  busy,
  onGenerate,
}: {
  briefing: BriefingData | null;
  busy: boolean;
  onGenerate: () => void;
}) {
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftContact, setDraftContact] = useState<Contact | null>(null);
  const [draftSeed, setDraftSeed] = useState<{ purpose: string; notes: string }>({
    purpose: "",
    notes: "",
  });

  const emailAction = (a: BriefingAction) => {
    setDraftContact(personToContact(a.name || "", a.email || "", a.company || ""));
    setDraftSeed({
      purpose: a.detail || (a.company ? `Outreach to ${a.company}` : "Outreach"),
      notes: a.sourceUrl ? `Reference: ${a.sourceUrl}` : "",
    });
    setDraftOpen(true);
  };

  if (!briefing) {
    return (
      <Card className="ai-presence border-border">
        <CardContent className="p-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Sparkles className="h-4 w-4 text-primary shrink-0" />
            Generate today's briefing for your prioritized signals, buying windows, and recommended
            actions.
          </div>
          <Button onClick={onGenerate} disabled={busy} size="sm" className="text-xs">
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            )}
            {busy ? "Generating…" : "Generate briefing"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const stats = [
    { label: "New (24h)", value: briefing.newSignals, icon: Radar },
    { label: "High-impact", value: briefing.highImpact, icon: Flame },
    { label: "Tracked", value: briefing.totalSignals, icon: TrendingUp },
    { label: "Follow-ups", value: briefing.followUps, icon: Bell },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <span className="inline-block w-0.5 h-3.5 bg-primary rounded-full" aria-hidden />
          Your daily briefing
          <span className="text-[11px] font-normal text-muted-foreground">
            · {relativeTime(Date.parse(briefing.generatedAt))}
          </span>
          {briefing.aiUsed && (
            <Badge variant="outline" className="text-[9px] text-primary border-primary/25">
              AI
            </Badge>
          )}
        </h2>
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          onClick={onGenerate}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
          )}
          {busy ? "Generating…" : "Regenerate"}
        </Button>
      </div>

      {/* Executive summary — editorial, not gradient theatre */}
      <Card className="ai-presence border-border">
        <CardContent className="p-5">
          <p className="text-base leading-relaxed text-foreground font-medium">{briefing.summary}</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-4 border-t border-border">
            {stats.map((s) => (
              <div key={s.label} className="px-1 py-1">
                <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground tracking-wide">
                  <s.icon className="h-3 w-3" />
                  {s.label}
                </div>
                <div className="text-xl font-semibold tabular-nums leading-none mt-1.5 text-foreground">
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Priorities + buying windows */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardContent className="p-5">
              <h2 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
                <Flame className="h-4 w-4 text-primary" /> Today's priorities
              </h2>
              {briefing.priorities.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No scored signals yet — run a scan from Signals.
                </p>
              ) : (
                <div className="space-y-3">
                  {briefing.priorities.map((p, i) => (
                    <div key={i} className="flex gap-3">
                      <div className="h-6 w-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold shrink-0">
                        {i + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link
                            to="/companies"
                            search={{ c: p.company }}
                            className="text-sm font-semibold text-foreground hover:text-primary truncate"
                          >
                            {p.company}
                          </Link>
                          {p.category && (
                            <Badge
                              variant="outline"
                              className={`text-[9px] ${CAT_CLASS[p.category] || ""}`}
                            >
                              {p.category}
                            </Badge>
                          )}
                          <Badge variant="secondary" className="text-[9px]">
                            opp {p.opportunity}
                          </Badge>
                        </div>
                        <p className="text-sm text-foreground mt-0.5 leading-snug">{p.headline}</p>
                        {p.why && (
                          <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                            {p.why}
                          </p>
                        )}
                        {p.sourceUrl && (
                          <a
                            href={p.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 mt-0.5"
                          >
                            source <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {briefing.opportunities.length > 0 && (
            <Card>
              <CardContent className="p-5">
                <h2 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
                  <TrendingUp className="h-4 w-4 text-primary" /> Buying windows
                </h2>
                <div className="space-y-1.5">
                  {briefing.opportunities.map((o) => (
                    <Link
                      key={o.company}
                      to="/companies"
                      search={{ c: o.company }}
                      className="flex items-center gap-3 py-2 -mx-1 px-1 rounded-md hover:bg-accent transition-colors"
                    >
                      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground truncate">
                            {o.company}
                          </span>
                          <Badge variant="secondary" className="text-[9px]">
                            opp {o.opportunity}
                          </Badge>
                        </div>
                        {o.reason && (
                          <p className="text-[11px] text-muted-foreground truncate">{o.reason}</p>
                        )}
                      </div>
                      <span className="text-[11px] text-muted-foreground shrink-0">
                        {o.networkCount} in network
                      </span>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Recommended actions */}
        <Card>
          <CardContent className="p-5">
            <h2 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
              <Sparkles className="h-4 w-4 text-primary" /> Recommended actions
            </h2>
            {briefing.actions.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                Nothing pressing — you're clear.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {briefing.actions.map((a, i) => (
                  <ActionRow key={i} a={a} onEmail={emailAction} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

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
