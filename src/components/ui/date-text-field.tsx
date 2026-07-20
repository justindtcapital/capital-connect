import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Typeable MM/DD/YYYY date input — no native browser date picker. The public
// value is ISO (YYYY-MM-DD, or "" when empty/unparseable); the field displays
// and accepts MM/DD/YYYY and auto-inserts the slashes as you type.

function toDisplay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
}

function toIso(display: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(display.trim());
  if (!m) return "";
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return "";
  const iso = `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  return Number.isNaN(Date.parse(iso)) ? "" : iso;
}

// Keep only digits + slashes and auto-insert slashes after MM and DD as typed.
function formatAsTyped(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean);
  return parts.join("/");
}

interface DateTextFieldProps {
  /** ISO YYYY-MM-DD (or ""). */
  value: string;
  /** Emits ISO YYYY-MM-DD, or "" when cleared. */
  onChange: (iso: string) => void;
  placeholder?: string;
  className?: string;
}

export function DateTextField({
  value,
  onChange,
  placeholder = "MM/DD/YYYY",
  className,
}: DateTextFieldProps) {
  const [text, setText] = useState(() => toDisplay(value));

  // Re-sync when the committed value changes from outside (clear, quick-range…).
  useEffect(() => {
    setText(toDisplay(value));
  }, [value]);

  const handleChange = (raw: string) => {
    const formatted = formatAsTyped(raw);
    setText(formatted);
    if (formatted.trim() === "") {
      onChange("");
      return;
    }
    const iso = toIso(formatted);
    if (iso) onChange(iso);
  };

  return (
    <Input
      inputMode="numeric"
      value={text}
      onChange={(e) => handleChange(e.target.value)}
      // Snap back to the canonical display of the committed value on blur so a
      // partial/invalid entry doesn't linger.
      onBlur={() => setText(toDisplay(value))}
      placeholder={placeholder}
      className={cn("h-8 text-xs", className)}
    />
  );
}
