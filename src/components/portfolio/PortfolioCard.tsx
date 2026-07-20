import type { PortfolioCompany } from "@/lib/types";
import type { PortfolioCompanyCounts } from "@/routes/portfolio";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Building2, Mail, MapPin, Users, Calendar, Link2 } from "lucide-react";

interface PortfolioCardProps {
  company: PortfolioCompany;
  counts: PortfolioCompanyCounts;
  onClick: () => void;
}

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

export function PortfolioCard({ company, counts, onClick }: PortfolioCardProps) {
  const logoUrl = getLogoUrl(company.website);

  return (
    <Card
      className="cursor-pointer surface-hover border-border h-full flex flex-col"
      onClick={onClick}
    >
      <CardContent className="p-5 flex flex-col flex-1">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
              {logoUrl ? (
                <img
                  src={logoUrl}
                  alt={company.name}
                  className="h-7 w-7 object-contain"
                  onError={(e) => {
                    const target = e.currentTarget;
                    target.style.display = "none";
                    if (target.nextElementSibling) (target.nextElementSibling as HTMLElement).style.display = "";
                  }}
                />
              ) : null}
              <span
                className="text-sm font-semibold text-primary"
                style={logoUrl ? { display: "none" } : {}}
              >
                {company.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
              </span>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">{company.name}</h3>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Building2 className="h-3 w-3" />
                {company.sector}
              </div>
            </div>
          </div>
          <Badge variant="outline" className="text-[10px]">{company.domain}</Badge>
        </div>

        <p className="text-xs text-muted-foreground line-clamp-2 mb-3">{company.description}</p>

        <div className="space-y-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <MapPin className="h-3 w-3" />
            {company.location}
          </div>
          <div className="flex items-center gap-1.5">
            <Mail className="h-3 w-3" />
            {company.contactEmail}
          </div>
        </div>

        <div className="flex items-center gap-3 mt-auto pt-3 border-t border-border">
          <span className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">
            <Users className="h-3 w-3 inline mr-0.5" />
            {counts.people} {counts.people === 1 ? "person" : "people"}
          </span>
          <span className="text-muted-foreground/30">·</span>
          <span className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">
            <Calendar className="h-3 w-3 inline mr-0.5" />
            {counts.events} events
          </span>
          <span className="text-muted-foreground/30">·</span>
          <span className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">
            <Link2 className="h-3 w-3 inline mr-0.5" />
            {counts.intros} intros
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
