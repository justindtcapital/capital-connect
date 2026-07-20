import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { AsanaEvent } from "@/lib/types";
import { fetchAsanaEvents } from "@/utils/asana.functions";
import { fetchAppEvents } from "@/utils/sheets.functions";

interface EventPickerProps {
  value: string;
  onChange: (name: string) => void;
  placeholder?: string;
  className?: string;
  // Pre-loaded events (skips internal fetch). Optional.
  events?: AsanaEvent[];
}

// Module-level cache so multiple pickers on a page share one fetch.
let cachedEvents: AsanaEvent[] | null = null;
let inflight: Promise<AsanaEvent[]> | null = null;

function mergeEventCatalogs(asana: AsanaEvent[], app: AsanaEvent[]): AsanaEvent[] {
  const byName = new Map<string, AsanaEvent>();
  // App Events first so in-app catalog wins on name collisions, then fill from Asana.
  for (const e of app) {
    const key = e.name.trim().toLowerCase();
    if (key) byName.set(key, e);
  }
  for (const e of asana) {
    const key = e.name.trim().toLowerCase();
    if (key && !byName.has(key)) byName.set(key, e);
  }
  return [...byName.values()];
}

async function loadEvents(): Promise<AsanaEvent[]> {
  if (cachedEvents) return cachedEvents;
  if (inflight) return inflight;
  inflight = Promise.all([
    fetchAsanaEvents().catch((): AsanaEvent[] => []),
    fetchAppEvents().catch((): AsanaEvent[] => []),
  ])
    .then(([asana, app]) => {
      cachedEvents = mergeEventCatalogs(asana, app);
      return cachedEvents;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function EventPicker({ value, onChange, placeholder = "Select or type event…", className, events }: EventPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState<AsanaEvent[]>(() => events ?? cachedEvents ?? []);

  useEffect(() => {
    if (events) {
      setLoaded(events);
      return;
    }
    if (cachedEvents) {
      setLoaded(cachedEvents);
      return;
    }
    let active = true;
    loadEvents().then((e) => {
      if (active) setLoaded(e);
    });
    return () => {
      active = false;
    };
  }, [events]);

  const { upcoming, past } = useMemo(() => {
    const today = new Date().toISOString().split("T")[0];
    const up: AsanaEvent[] = [];
    const ps: AsanaEvent[] = [];
    for (const e of loaded) {
      if ((e.date || "") >= today) up.push(e);
      else ps.push(e);
    }
    // Upcoming: soonest first. Past: most recent first.
    up.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    ps.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return { upcoming: up, past: ps };
  }, [loaded]);

  const handleSelect = (name: string) => {
    onChange(name);
    setOpen(false);
    setQuery("");
  };

  const trimmedQuery = query.trim();
  const hasExactMatch = loaded.some((e) => e.name.toLowerCase() === trimmedQuery.toLowerCase());

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("h-9 w-full justify-between font-normal text-sm", !value && "text-muted-foreground", className)}
        >
          <span className="truncate">{value || placeholder}</span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter>
          <CommandInput placeholder="Search events…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>No events found.</CommandEmpty>
            {upcoming.length > 0 && (
              <CommandGroup heading="Upcoming">
                {upcoming.map((e) => (
                  <CommandItem key={e.gid || `up-${e.name}`} value={e.name} onSelect={() => handleSelect(e.name)}>
                    <Check className={cn("mr-2 h-3.5 w-3.5", value === e.name ? "opacity-100" : "opacity-0")} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{e.name}</div>
                      <div className="text-[10px] text-muted-foreground">{e.date}</div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {past.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Past">
                  {past.map((e) => (
                    <CommandItem key={e.gid || `past-${e.name}`} value={e.name} onSelect={() => handleSelect(e.name)}>
                      <Check className={cn("mr-2 h-3.5 w-3.5", value === e.name ? "opacity-100" : "opacity-0")} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">{e.name}</div>
                        <div className="text-[10px] text-muted-foreground">{e.date}</div>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
            {trimmedQuery && !hasExactMatch && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Custom">
                  <CommandItem value={`__custom__${trimmedQuery}`} onSelect={() => handleSelect(trimmedQuery)}>
                    <Check className="mr-2 h-3.5 w-3.5 opacity-0" />
                    <span className="text-sm">
                      Use “<span className="font-medium">{trimmedQuery}</span>”
                    </span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
