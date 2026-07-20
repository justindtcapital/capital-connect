import { useState } from "react";
import { Check, ChevronsUpDown, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import { COMMON_LOCATIONS } from "@/lib/location-utils";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Suggestions to offer; free text is always allowed. Defaults to common metros. */
  suggestions?: string[];
  placeholder?: string;
  className?: string;
}

// A location picker that suggests canonical metros but never constrains input —
// the typed query can always be committed verbatim ("Use …"). Used for the
// contact Location field so the same place collapses to one label while still
// accepting anything the user types.
export function LocationCombobox({
  value,
  onChange,
  suggestions = COMMON_LOCATIONS,
  placeholder = "City, ST",
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filtered = q ? suggestions.filter((s) => s.toLowerCase().includes(q)) : suggestions;
  const exact = suggestions.some((s) => s.toLowerCase() === q);

  const commit = (v: string) => {
    onChange(v);
    setQuery("");
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("h-8 w-full justify-between text-sm font-normal", className)}
        >
          <span className={cn("flex items-center gap-1.5 truncate", !value && "text-muted-foreground")}>
            <MapPin className="h-3.5 w-3.5 shrink-0 opacity-60" />
            {value || placeholder}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-56 p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search or type a location…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {query.trim() && !exact && (
              <CommandItem value={`__use__${query}`} onSelect={() => commit(query.trim())}>
                <Check className="mr-2 h-3.5 w-3.5 opacity-0" />
                Use “{query.trim()}”
              </CommandItem>
            )}
            {filtered.length === 0 && !query.trim() && <CommandEmpty>No suggestions.</CommandEmpty>}
            {filtered.length > 0 && (
              <CommandGroup heading="Suggestions">
                {filtered.map((s) => (
                  <CommandItem key={s} value={s} onSelect={() => commit(s)}>
                    <Check
                      className={cn("mr-2 h-3.5 w-3.5", value === s ? "opacity-100" : "opacity-0")}
                    />
                    {s}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {value && (
              <>
                <CommandSeparator />
                <CommandItem
                  value="__clear__"
                  onSelect={() => commit("")}
                  className="text-muted-foreground"
                >
                  <Check className="mr-2 h-3.5 w-3.5 opacity-0" />
                  Clear location
                </CommandItem>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
