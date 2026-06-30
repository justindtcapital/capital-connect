import { Check, ChevronsUpDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

interface MultiSelectProps {
  options: string[];
  /** Currently selected values (empty = nothing selected → "no filter"). */
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  /** Show a search box (default on; useful for long lists like cities). */
  searchable?: boolean;
  className?: string;
}

// Searchable multi-select: a popover checkbox list whose trigger summarizes the
// selection. Empty selection reads as "no filter" — mirrors the OR-within-a-field
// model used by the chart cross-filters.
export function MultiSelect({
  options,
  value,
  onChange,
  placeholder = "All",
  searchable = true,
  className,
}: MultiSelectProps) {
  const toggle = (option: string) => {
    onChange(value.includes(option) ? value.filter((v) => v !== option) : [...value, option]);
  };

  const label =
    value.length === 0 ? placeholder : value.length === 1 ? value[0] : `${value.length} selected`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          className={cn(
            "h-8 w-full justify-between px-2.5 text-xs font-normal",
            value.length === 0 && "text-muted-foreground",
            className,
          )}
        >
          <span className="truncate">{label}</span>
          <span className="flex items-center gap-1 shrink-0">
            {value.length > 0 && (
              <X
                className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onChange([]);
                }}
              />
            )}
            <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command>
          {searchable && <CommandInput placeholder="Search…" className="h-8 text-xs" />}
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const checked = value.includes(option);
                return (
                  <CommandItem
                    key={option}
                    value={option}
                    onSelect={() => toggle(option)}
                    className="text-xs"
                  >
                    <div
                      className={cn(
                        "mr-2 flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-primary",
                        checked ? "bg-primary text-primary-foreground" : "opacity-60",
                      )}
                    >
                      {checked && <Check className="h-3 w-3" />}
                    </div>
                    <span className="truncate">{option}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
