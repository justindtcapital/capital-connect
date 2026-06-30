import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// Allowlist of email addresses permitted to sign in.
// To grant access to another person, add their lowercase email here.
const ALLOWED_EMAILS = [
  "justin.adorante@dell.com",
];

const STORAGE_KEY = "vp-auth-email";

function isAllowed(email: string): boolean {
  return ALLOWED_EMAILS.includes(email.trim().toLowerCase());
}

interface AuthContextType {
  /** The signed-in email, or null when signed out. */
  email: string | null;
  /** True until the stored session has been read on the client. */
  ready: boolean;
  /** Attempts sign-in. Returns null on success, or an error message. */
  login: (email: string) => string | null;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  email: null,
  ready: false,
  login: () => "Auth not ready",
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Read the persisted session on mount (client only — localStorage is
  // unavailable during SSR).
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && isAllowed(stored)) {
        setEmail(stored.trim().toLowerCase());
      }
    } catch {
      // localStorage may be unavailable (private mode, etc.) — stay signed out.
    }
    setReady(true);
  }, []);

  function login(input: string): string | null {
    const normalized = input.trim().toLowerCase();
    if (!normalized) return "Please enter your email.";
    if (!isAllowed(normalized)) {
      return "No account found for this email.";
    }
    try {
      localStorage.setItem(STORAGE_KEY, normalized);
    } catch {
      // Ignore persistence failure — session still works for this tab.
    }
    setEmail(normalized);
    return null;
  }

  function logout() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore.
    }
    setEmail(null);
  }

  return (
    <AuthContext.Provider value={{ email, ready, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
