import { Inngest } from "inngest";

/** App id shown in the Inngest dashboard / Lovable connector. */
export const inngest = new Inngest({
  id: "venture-pulse",
  isDev:
    process.env["INNGEST_DEV"] === "1" ||
    process.env["NODE_ENV"] === "development",
});
