import { useState } from "react";
import type { Contact } from "@/lib/types";
import { getCompanyLogoUrl } from "@/lib/domain-utils";
import { cn } from "@/lib/utils";

interface ContactAvatarProps {
  contact: Pick<Contact, "name" | "email"> & { website?: string };
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeClasses = {
  sm: { wrap: "h-7 w-7", text: "text-[10px]", img: "h-5 w-5" },
  md: { wrap: "h-9 w-9", text: "text-sm", img: "h-6 w-6" },
  lg: { wrap: "h-12 w-12", text: "text-lg", img: "h-8 w-8" },
};

export function ContactAvatar({ contact, size = "md", className }: ContactAvatarProps) {
  const primaryEmail = contact.email?.split(";")[0]?.trim() || contact.email;
  const logoUrl = getCompanyLogoUrl({ email: primaryEmail, website: contact.website });
  const [errored, setErrored] = useState(false);
  const sz = sizeClasses[size];

  const initials = contact.name
    .split(" ")
    .map((n) => n[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2);

  const showLogo = logoUrl && !errored;

  return (
    <div
      className={cn(
        sz.wrap,
        "rounded-full bg-accent flex items-center justify-center shrink-0 overflow-hidden",
        className
      )}
    >
      {showLogo ? (
        <img
          src={logoUrl}
          alt={contact.name}
          className={cn(sz.img, "object-contain")}
          referrerPolicy="no-referrer"
          onError={() => setErrored(true)}
        />
      ) : (
        <span className={cn(sz.text, "font-semibold text-foreground")}>{initials}</span>
      )}
    </div>
  );
}
