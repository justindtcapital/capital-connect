import { useEffect, useMemo, useState } from "react";
import type { Contact } from "@/lib/types";
import {
  companyLogoSources,
  resolveCompanyLogoDomain,
  type LogoConfidence,
} from "@/lib/domain-utils";
import { cn } from "@/lib/utils";

interface ContactAvatarProps {
  contact: Pick<Contact, "name" | "email"> & {
    website?: string;
    company?: string;
    /** Explicit company domain when known (e.g. Sumble org domain). */
    domain?: string;
  };
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeClasses = {
  sm: { wrap: "h-7 w-7", text: "text-[10px]", img: "h-5 w-5" },
  md: { wrap: "h-9 w-9", text: "text-sm", img: "h-6 w-6" },
  lg: { wrap: "h-12 w-12", text: "text-lg", img: "h-8 w-8" },
};

/**
 * Company logo avatar for Network / Targets people rows.
 * Resolves domain from website → domain → corporate email → company-name guess,
 * then tries Logo.dev (optional) → DuckDuckGo → Google favicon before initials.
 */
export function ContactAvatar({ contact, size = "md", className }: ContactAvatarProps) {
  const primaryEmail = contact.email?.split(/[;,]/)[0]?.trim() || contact.email;
  const resolved = useMemo(
    () =>
      resolveCompanyLogoDomain({
        website: contact.website,
        domain: contact.domain,
        email: primaryEmail,
        company: contact.company,
      }),
    [contact.website, contact.domain, primaryEmail, contact.company],
  );

  const sources = useMemo(() => {
    if (!resolved) return [] as string[];
    return companyLogoSources(resolved.domain, resolved.confidence as LogoConfidence);
  }, [resolved]);

  const [stage, setStage] = useState(0);
  const sz = sizeClasses[size];

  // Reset ladder when the underlying domain/sources change (new contact row).
  useEffect(() => {
    setStage(0);
  }, [sources.join("|")]);

  const initials = (contact.name || "?")
    .split(/\s+/)
    .map((n) => n[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const src = stage < sources.length ? sources[stage] : null;

  return (
    <div
      className={cn(
        sz.wrap,
        "rounded-full bg-accent flex items-center justify-center shrink-0 overflow-hidden",
        className,
      )}
      title={
        resolved
          ? `${resolved.domain} (${resolved.source}${resolved.confidence === "low" ? ", guessed" : ""})`
          : undefined
      }
    >
      {src ? (
        <img
          key={src}
          src={src}
          alt=""
          className={cn(sz.img, "object-contain")}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setStage((s) => s + 1)}
        />
      ) : (
        <span className={cn(sz.text, "font-semibold text-foreground")}>{initials}</span>
      )}
    </div>
  );
}
