import { createStart } from "@tanstack/react-start";

// TanStack Start expects this named export during client hydration.
// Keep the options empty until global middleware or serialization adapters are needed.
export const startInstance = createStart(() => ({}));
