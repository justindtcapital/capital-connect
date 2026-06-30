import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Linkedin, Users, Sparkles, Copy, ExternalLink, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { scoreNetworkTargets, draftLinkedInPost, type ScoredTarget } from "@/utils/broadcast.functions";
import type { FeedCard } from "@/lib/signal-feed";

type Mode = "linkedin" | "targets";

interface BroadcastDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  card: FeedCard | null;
  /** Launch the email composer (reuses EmailDraftDialog) for a scored target. */
  onEmailTarget: (target: ScoredTarget) => void;
}

export function BroadcastDialog({ open, onOpenChange, card, onEmailTarget }: BroadcastDialogProps) {
  const [mode, setMode] = useState<Mode>("linkedin");
  const [post, setPost] = useState("");
  const [postBusy, setPostBusy] = useState(false);
  const [targets, setTargets] = useState<ScoredTarget[] | null>(null);
  const [targetsBusy, setTargetsBusy] = useState(false);

  if (!card) return null;

  const reset = () => {
    setMode("linkedin");
    setPost("");
    setPostBusy(false);
    setTargets(null);
    setTargetsBusy(false);
  };

  const close = (o: boolean) => {
    if (!o) reset();
    onOpenChange(o);
  };

  const genPost = async () => {
    setPostBusy(true);
    try {
      const res = await draftLinkedInPost({
        data: { company: card.company, headline: card.headline, summary: card.summary, sourceUrl: card.sourceUrl },
      });
      if (!res.ok || !res.post) {
        toast.error(res.error || "Could not draft the post.");
        return;
      }
      setPost(res.post);
    } catch (e) {
      console.error("draftLinkedInPost failed", e);
      toast.error("Draft failed — see console.");
    } finally {
      setPostBusy(false);
    }
  };

  const copyPost = async () => {
    try {
      await navigator.clipboard.writeText(post);
      toast.success("Post copied");
    } catch {
      toast.error("Could not copy.");
    }
  };

  const openLinkedIn = () => {
    const url = `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(post)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const findTargets = async () => {
    setTargetsBusy(true);
    setTargets(null);
    try {
      const res = await scoreNetworkTargets({
        data: { company: card.company, headline: card.headline, summary: card.summary, segment: card.segment },
      });
      if (!res.ok) {
        toast.error(res.error || "Could not score contacts.");
        setTargets([]);
        return;
      }
      setTargets(res.targets);
      if (res.targets.length === 0) toast.info("No strongly relevant contacts found.");
    } catch (e) {
      console.error("scoreNetworkTargets failed", e);
      toast.error("Scoring failed — see console.");
      setTargets([]);
    } finally {
      setTargetsBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Broadcast
          </DialogTitle>
          <DialogDescription className="text-xs">
            {card.company} · {card.headline}
          </DialogDescription>
        </DialogHeader>

        {/* Mode switch */}
        <div className="flex items-center gap-1.5">
          <Button variant={mode === "linkedin" ? "default" : "outline"} size="sm" className="h-8 text-xs" onClick={() => setMode("linkedin")}>
            <Linkedin className="h-3.5 w-3.5" /> LinkedIn post
          </Button>
          <Button variant={mode === "targets" ? "default" : "outline"} size="sm" className="h-8 text-xs" onClick={() => setMode("targets")}>
            <Users className="h-3.5 w-3.5" /> Find network targets
          </Button>
        </div>

        {mode === "linkedin" && (
          <div className="space-y-3 py-1">
            {!post && !postBusy && (
              <p className="text-xs text-muted-foreground">
                Draft a LinkedIn post in DTC's voice about this signal — with #DellTechCapital and relevant hashtags.
              </p>
            )}
            {postBusy && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
                <Loader2 className="h-4 w-4 animate-spin" /> Drafting…
              </div>
            )}
            {post && (
              <Textarea value={post} onChange={(e) => setPost(e.target.value)} rows={10} className="text-sm" />
            )}
            <div className="flex items-center gap-2">
              <Button size="sm" className="h-8 text-xs" onClick={genPost} disabled={postBusy}>
                <Sparkles className="h-3.5 w-3.5" /> {post ? "Regenerate" : "Generate post"}
              </Button>
              {post && (
                <>
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={copyPost}>
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={openLinkedIn}>
                    <Linkedin className="h-3.5 w-3.5" /> Open LinkedIn <ExternalLink className="h-3 w-3" />
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {mode === "targets" && (
          <div className="space-y-3 py-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Score your network for who this signal is most relevant to.
              </p>
              <Button size="sm" className="h-8 text-xs shrink-0" onClick={findTargets} disabled={targetsBusy}>
                {targetsBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Users className="h-3.5 w-3.5" />}
                {targets ? "Re-score" : "Find targets"}
              </Button>
            </div>

            {targetsBusy && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
                <Loader2 className="h-4 w-4 animate-spin" /> Scoring your network…
              </div>
            )}

            {targets && targets.length > 0 && (
              <div className="max-h-80 overflow-y-auto overflow-x-hidden space-y-2 pr-2 -mr-2">
                {targets.map((t, i) => (
                  <div key={`${t.email}-${i}`} className="rounded-lg border border-border p-2.5 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold truncate">{t.name}</span>
                        <Badge variant="secondary" className="text-[10px]">{t.score}/100</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {[t.title, t.company].filter(Boolean).join(" · ")}
                      </div>
                      {t.reason && <p className="text-[11px] text-muted-foreground mt-0.5">{t.reason}</p>}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px] shrink-0"
                      disabled={!t.email}
                      title={t.email ? "" : "No email on file"}
                      onClick={() => onEmailTarget(t)}
                    >
                      <Mail className="h-3 w-3" /> Email
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {targets && targets.length === 0 && !targetsBusy && (
              <p className="text-sm text-muted-foreground text-center py-4">No strongly relevant contacts found.</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
