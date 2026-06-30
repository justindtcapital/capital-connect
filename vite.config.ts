// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { Plugin } from "vite";

const emptyPluginAdaptersSource = `export const pluginSerializationAdapters = [];
export const hasPluginAdapters = false;
`;

function tanstackEmptyPluginAdaptersCompat(): Plugin {
  const virtualId = "\0tanstack-empty-plugin-adapters-compat";

  const isEmptyPluginAdaptersId = (id: string) =>
    id
      .replaceAll("\\", "/")
      .includes("@tanstack/start-client-core/dist/esm/empty-plugin-adapters.js");

  return {
    name: "tanstack-empty-plugin-adapters-compat",
    enforce: "pre",
    resolveId(id) {
      if (isEmptyPluginAdaptersId(id)) {
        return virtualId;
      }
    },
    load(id) {
      if (id === virtualId || isEmptyPluginAdaptersId(id)) {
        return emptyPluginAdaptersSource;
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (
          req.url?.startsWith(
            "/node_modules/@tanstack/start-client-core/dist/esm/empty-plugin-adapters.js",
          )
        ) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/javascript");
          res.end(emptyPluginAdaptersSource);
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  vite: {
    plugins: [tanstackEmptyPluginAdaptersCompat()],
  },
});
