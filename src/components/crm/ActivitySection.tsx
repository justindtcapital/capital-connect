import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Activity as ActivityIcon, ExternalLink, UserPlus } from "lucide-react";
import { sourceContactsFromActivities } from "@/utils/activity-sourcing.functions";
import type { AsanaActivity } from "@/lib/types";

interface ActivitySectionProps {
  activities: AsanaActivity[];
  loading: boolean;
  /** Smaller header style for the contact sheet (vs. portfolio panel). */
  compact?: boolean;
  /** Show the "Source contacts" button (parses the threads → contacts + activity log). */
  enableSourcing?: boolean;
  /** Company stamped on newly-created contacts when their email domain can't supply one. */
  defaultCompany?: string;
}

function trackClass(track: AsanaActivity["track"]): string {
  return track === "BD"
    ? "bg-blue-50 text-blue-700 border-blue-200"
    : "bg-purple-50 text-purple-700 border-purple-200";
}

// BD / GTM activities (from Asana Activity Tracking projects) matched to this
// record. Renders nothing while there's nothing to show, so it stays out of the
// way for records with no tracked activity.
export function ActivitySection({ activities, loading, compact, enableSourcing, defaultCompany }: ActivitySectionProps) {
  const router = useRouter();
  const [sourcing, setSourcing] = useState(false);
  const headerClass = compact
    ? "text-[10px] uppercase tracking-widest font-semibold text-muted-foreground"
    : "text-xs uppercase tracking-wider font-semibold text-muted-foreground";

  const sourceContacts = async () => {
    if (activities.length === 0) return;
    setSourcing(true);
    try {
      const res = await sourceContactsFromActivities({
        data: { activityGids: activities.map((a) => a.gid), defaultCompany },
      });
      if (!res.found) {
        toast.error(res.error || "Couldn't source contacts.");
        return;
      }
      if (res.peopleCount === 0) {
        toast.info("No external people found in these activity threads.");
        return;
      }
      const enrichBit =
        res.createdCount > 0 ? ` (${res.enrichedCount} enriched via Apollo)` : "";
      const insightBit =
        res.summariesWritten > 0
          ? ` · ${res.summariesWritten} summarized${res.followUpsFlagged > 0 ? `, ${res.followUpsFlagged} follow-up${res.followUpsFlagged !== 1 ? "s" : ""} flagged` : ""}`
          : "";
      const eventBit =
        res.eventsTagged > 0
          ? ` · ${res.eventsTagged} event tag${res.eventsTagged !== 1 ? "s" : ""}${res.eventsCreated > 0 ? ` (${res.eventsCreated} new event${res.eventsCreated !== 1 ? "s" : ""})` : ""}`
          : "";
      const connBit =
        res.connectionsLogged > 0
          ? ` · ${res.connectionsLogged} connection${res.connectionsLogged !== 1 ? "s" : ""} mapped`
          : "";
      toast.success(
        `${res.createdCount} new contact${res.createdCount !== 1 ? "s" : ""} added${enrichBit} · ${res.existingCount} existing · ${res.notesLogged} activit${res.notesLogged !== 1 ? "ies" : "y"} logged${insightBit}${eventBit}${connBit}`,
      );
      if (res.apolloUnavailable && res.createdCount > 0) {
        toast.info("Apollo enrichment was unavailable (check the API key/plan) — contacts were saved with the parsed details only.");
      }
      router.invalidate(); // refresh contacts/notes so the new records show
    } catch (e) {
      console.error("ActivitySection: sourceContacts failed", e);
      toast.error("Sourcing failed — see console.");
    } finally {
      setSourcing(false);
    }
  };

  if (loading) {
    return (
      <div className={`${headerClass} flex items-center gap-1.5`}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading activity…
      </div>
    );
  }
  if (activities.length === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className={`${headerClass} flex items-center gap-1.5`}>
          <ActivityIcon className="h-3.5 w-3.5" /> BD / GTM Activity ({activities.length})
        </h3>
        {enableSourcing && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            onClick={sourceContacts}
            disabled={sourcing}
            title="Add the people in these email threads as contacts (deduped) and log the activity"
          >
            {sourcing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <UserPlus className="h-3 w-3 mr-1" />}
            {sourcing ? "Sourcing…" : "Source contacts"}
          </Button>
        )}
      </div>
      <div className="space-y-1.5">
        {activities.map((a) => {
          const meta = [a.type, a.status, a.owner].filter(Boolean).join(" · ");
          return (
            <div key={a.gid} className="rounded-md border border-border bg-card px-2.5 py-2 min-w-0 overflow-hidden">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Badge variant="outline" className={`text-[9px] shrink-0 ${trackClass(a.track)}`}>
                    {a.track}
                  </Badge>
                  <span className="text-xs font-medium truncate">{a.name}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {a.date && <span className="text-[10px] text-muted-foreground">{a.date}</span>}
                  {a.url && (
                    <a href={a.url} target="_blank" rel="noopener noreferrer" title="Open in Asana" className="text-muted-foreground hover:text-foreground">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
              {meta && <div className="text-[10px] text-muted-foreground mt-0.5 truncate">{meta}</div>}
              {a.notes && <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2 wrap-break-word">{a.notes}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
