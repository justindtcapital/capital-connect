import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { FilterProvider, useFilters } from "@/lib/filter-context";
import { SelectionProvider } from "@/lib/selection-context";
import { DashboardFilterProvider, useDashboardFilters } from "@/lib/dashboard-filter-context";
import { TargetingFilterProvider, useTargetingFilters } from "@/lib/targeting-filter-context";
import { TargetSelectionProvider } from "@/lib/target-selection-context";
import { PortfolioFilterProvider, usePortfolioFilters } from "@/lib/portfolio-filter-context";
import { FilterOptionsProvider } from "@/lib/filter-options-context";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { LoginScreen } from "@/components/login-screen";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";

import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "VenturePulse — DTC Network Intelligence" },
      { name: "description", content: "DTC network management" },
      { name: "author", content: "Dell Technologies Capital" },
      { property: "og:title", content: "VenturePulse — DTC Network Intelligence" },
      { property: "og:description", content: "DTC network management" },
      { property: "og:type", content: "website" },
      { name: "twitter:title", content: "VenturePulse — DTC Network Intelligence" },
      { name: "twitter:description", content: "DTC network management" },
      { name: "twitter:card", content: "summary" },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/eec20a45-e73e-4a3e-aff1-da50fc1c15c9/id-preview-82758b98--33c9a4dc-3d95-4e54-9da9-413bf3238ece.lovable.app-1782850835844.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/eec20a45-e73e-4a3e-aff1-da50fc1c15c9/id-preview-82758b98--33c9a4dc-3d95-4e54-9da9-413bf3238ece.lovable.app-1782850835844.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body style={{ fontFamily: "'Inter', sans-serif" }}>
        {children}
        <Toaster richColors position="top-right" />
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

function AuthGate() {
  const { email, ready } = useAuth();

  // Avoid flashing the login screen before the stored session is read.
  if (!ready) return null;
  if (!email) return <LoginScreen />;

  return (
    <FilterOptionsProvider>
    <FilterProvider>
      <DashboardFilterProvider>
        <TargetingFilterProvider>
          <PortfolioFilterProvider>
            <SelectionProvider>
              <TargetSelectionProvider>
                <SidebarProvider>
                  <div className="min-h-screen flex w-full">
                    <SidebarWithFilters />
                    <div className="flex-1 flex flex-col min-w-0">
                      <header className="h-12 flex items-center justify-between border-b border-border bg-background px-4">
                        <SidebarTrigger />
                        <UserMenu />
                      </header>
                      <main className="flex-1 overflow-auto">
                        <Outlet />
                      </main>
                    </div>
                  </div>
                </SidebarProvider>
              </TargetSelectionProvider>
            </SelectionProvider>
          </PortfolioFilterProvider>
        </TargetingFilterProvider>
      </DashboardFilterProvider>
    </FilterProvider>
    </FilterOptionsProvider>
  );
}

function UserMenu() {
  const { email, logout } = useAuth();
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground">{email}</span>
      <Button variant="ghost" size="sm" onClick={logout}>
        Sign out
      </Button>
    </div>
  );
}

function SidebarWithFilters() {
  const { filters, setFilters } = useFilters();
  const { filters: dashFilters, setFilters: setDashFilters } = useDashboardFilters();
  const { filters: targetFilters, setFilters: setTargetFilters } = useTargetingFilters();
  const { filters: portfolioFilters, setFilters: setPortfolioFilters } = usePortfolioFilters();
  return (
    <AppSidebar
      filters={filters}
      onFiltersChange={setFilters}
      dashboardFilters={dashFilters}
      onDashboardFiltersChange={setDashFilters}
      targetingFilters={targetFilters}
      onTargetingFiltersChange={setTargetFilters}
      portfolioFilters={portfolioFilters}
      onPortfolioFiltersChange={setPortfolioFilters}
    />
  );
}
