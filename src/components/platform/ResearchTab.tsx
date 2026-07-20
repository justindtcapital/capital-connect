import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BookOpen, ExternalLink, Loader2, Newspaper, Plus, Swords, X } from "lucide-react";
import { toast } from "sonner";
import type { PlatformContentRow, RadarEntry } from "@/lib/platform-content";
import {
  generateBoardArticles,
  generateExecBrief,
  removeRadarEntry,
} from "@/utils/platform.functions";
import { ContentHistoryList } from "./ContentHistoryList";
import { ContentDetailSheet } from "./ContentDetailSheet";
import { AddRadarDialog } from "./AddRadarDialog";

// Thematic research: on-demand executive briefs + board reading lists
// (persisted, grounded) and the curated competitive radar.
export function ResearchTab({
  content,
  radar,
  userEmail,
  onContent,
  onRadarAdded,
  onRadarRemoved,
}: {
  content: PlatformContentRow[];
  radar: RadarEntry[];
  userEmail: string;
  onContent: (row: PlatformContentRow) => void;
  onRadarAdded: (entry: RadarEntry) => void;
  onRadarRemoved: (id: string) => void;
}) {
  const [theme, setTheme] = useState("");
  const [briefBusy, setBriefBusy] = useState(false);
  const [articlesBusy, setArticlesBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [removingId, setRemovingId] = useState("");
  const [detailRow, setDetailRow] = useState<PlatformContentRow | null>(null);

  const researchContent = content.filter(
    (r) => r.type === "exec_brief" || r.type === "board_article",
  );

  const runBrief = async () => {
    if (!theme.trim()) return;
    setBriefBusy(true);
    try {
      const row = await generateExecBrief({
        data: { theme: theme.trim(), generatedBy: userEmail },
      });
      onContent(row);
      setDetailRow(row);
      toast.success("Executive brief ready.");
    } catch (e) {
      console.error("generateExecBrief failed", e);
      toast.error(e instanceof Error ? e.message : "Brief generation failed.");
    } finally {
      setBriefBusy(false);
    }
  };

  const runArticles = async () => {
    if (!theme.trim()) return;
    setArticlesBusy(true);
    try {
      const row = await generateBoardArticles({
        data: { theme: theme.trim(), generatedBy: userEmail },
      });
      onContent(row);
      setDetailRow(row);
      toast.success("Board reading list ready.");
    } catch (e) {
      console.error("generateBoardArticles failed", e);
      toast.error(e instanceof Error ? e.message : "Curation failed.");
    } finally {
      setArticlesBusy(false);
    }
  };

  const removeEntry = async (entry: RadarEntry) => {
    setRemovingId(entry.id);
    try {
      await removeRadarEntry({ data: { id: entry.id } });
      onRadarRemoved(entry.id);
      toast.success(`Stopped watching ${entry.company}.`);
    } catch (e) {
      console.error("removeRadarEntry failed", e);
      toast.error("Couldn't remove the entry.");
    } finally {
      setRemovingId("");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 text-sm flex-1 min-w-56"
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          placeholder="Research theme — e.g. agentic AI in the enterprise, post-quantum security…"
        />
        <Button
          size="sm"
          className="h-8 text-xs"
          onClick={runBrief}
          disabled={briefBusy || !theme.trim()}
        >
          {briefBusy ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <BookOpen className="h-3.5 w-3.5 mr-1" />
          )}
          Generate briefing
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={runArticles}
          disabled={articlesBusy || !theme.trim()}
        >
          {articlesBusy ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <Newspaper className="h-3.5 w-3.5 mr-1" />
          )}
          Board reading
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <h3 className="text-sm font-semibold text-foreground mb-2">Saved research</h3>
          <ContentHistoryList
            rows={researchContent}
            onOpen={setDetailRow}
            emptyLabel="No briefings yet — enter a theme above and generate one. Results are grounded in web research and saved here."
          />
        </div>

        <Card className="h-fit">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                <Swords className="h-4 w-4 text-primary" /> Competitive radar
              </CardTitle>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setAddOpen(true)}
              >
                <Plus className="h-3 w-3 mr-1" /> Watch
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {radar.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4">
                No companies on the radar yet. Watch competitors and theme-relevant startups —
                they'll also feed themed executive briefs.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {radar.map((r) => (
                  <div key={r.id} className="py-2 flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <Link
                          to="/companies"
                          search={{ c: r.company }}
                          className="text-sm font-medium text-foreground hover:text-primary hover:underline truncate"
                        >
                          {r.company}
                        </Link>
                        {r.segment && (
                          <Badge variant="outline" className="text-[9px] shrink-0">
                            {r.segment}
                          </Badge>
                        )}
                        {r.website && (
                          <a
                            href={r.website.startsWith("http") ? r.website : `https://${r.website}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-muted-foreground hover:text-primary shrink-0"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                      {(r.theme || r.note) && (
                        <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                          {[r.theme, r.note].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeEntry(r)}
                      disabled={removingId === r.id}
                      aria-label={`Stop watching ${r.company}`}
                      className="text-muted-foreground hover:text-red-600 shrink-0 mt-0.5"
                    >
                      {removingId === r.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <X className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <AddRadarDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        userEmail={userEmail}
        onAdded={onRadarAdded}
      />
      <ContentDetailSheet
        row={detailRow}
        onOpenChange={(o) => !o && setDetailRow(null)}
        userEmail={userEmail}
        onRadarAdded={onRadarAdded}
      />
    </div>
  );
}
