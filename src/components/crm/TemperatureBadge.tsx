import type { Contact, Temperature } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface TemperatureBadgeProps {
  temperature: Temperature;
  className?: string;
}

export function TemperatureBadge({ temperature, className }: TemperatureBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px] font-semibold uppercase tracking-wide border-0",
        temperature === "Council" && "bg-council text-council-foreground",
        temperature === "Hot" && "bg-hot text-hot-foreground",
        temperature === "Warm" && "bg-warm text-warm-foreground",
        temperature === "Cold" && "bg-cold text-cold-foreground",
        className,
      )}
    >
      {temperature}
    </Badge>
  );
}
