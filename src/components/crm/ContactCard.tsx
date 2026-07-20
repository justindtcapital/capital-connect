import type { Contact } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { TemperatureBadge } from "./TemperatureBadge";
import { ContactAvatar } from "./ContactAvatar";
import { Building2, Mail, User, Briefcase, AlertCircle, CheckCircle2 } from "lucide-react";

interface ContactCardProps {
  contact: Contact;
  onClick: () => void;
}

export function ContactCard({ contact, onClick }: ContactCardProps) {
  const primaryEmail = contact.email?.split(";")[0]?.trim() || contact.email;
  const hasOpenFollowUps = contact.interactions.some((i) => i.isFollowUp && !i.followUpComplete);
  const allFollowUpsComplete = contact.interactions.some((i) => i.isFollowUp) && !hasOpenFollowUps;

  return (
    <Card
      className="cursor-pointer surface-hover border-border h-full flex flex-col"
      onClick={onClick}
    >
      <CardContent className="p-5 flex flex-col flex-1">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <ContactAvatar contact={contact} size="md" />
            <div>
              <h3 className="text-sm font-semibold text-foreground">{contact.name}</h3>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Briefcase className="h-3 w-3" />
                {contact.title}
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Building2 className="h-3 w-3" />
                {contact.company}
              </div>
            </div>
          </div>
          <TemperatureBadge temperature={contact.temperature} />
        </div>

        <div className="space-y-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Mail className="h-3 w-3" />
            <a
              href={`mailto:${primaryEmail}`}
              className="text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {primaryEmail}
            </a>
          </div>
          <div className="flex items-center gap-1.5">
            <User className="h-3 w-3" />
            <span className="font-medium">{contact.prime}</span>
            <span className="text-muted-foreground/60">·</span>
            <span>{contact.sector}</span>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-auto pt-3 border-t border-border">
          <span className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">
            {contact.portCoIntros.length} intros
          </span>
          <span className="text-muted-foreground/30">·</span>
          <span className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">
            {contact.eventsAttended.length} events
          </span>
          <span className="text-muted-foreground/30">·</span>
          <span
            className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground/80 truncate"
            title={`Source: ${contact.source || "Manual Entry"}`}
          >
            {contact.source || "Manual Entry"}
          </span>
          {hasOpenFollowUps && (
            <>
              <span className="text-muted-foreground/30">·</span>
              <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide font-medium text-red-500">
                <AlertCircle className="h-3 w-3" />
                Follow-up
              </span>
            </>
          )}
          {allFollowUpsComplete && (
            <>
              <span className="text-muted-foreground/30">·</span>
              <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide font-medium text-emerald-600">
                <CheckCircle2 className="h-3 w-3" />
                Done
              </span>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
