/**
 * Shared auth for unattended cron / scheduler endpoints.
 * Accepts Authorization: Bearer <CRON_SECRET> or x-cron-secret: <CRON_SECRET>.
 */
export function authorizeCronRequest(request: Request): boolean {
  // Bracket access avoids Vite/Nitro static-empty replacement of process.env.X
  const secret = (process.env["CRON_SECRET"] || "").trim();
  if (!secret) return false;

  const auth = request.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const headerSecret = (request.headers.get("x-cron-secret") || "").trim();

  return timingSafeEqual(bearer, secret) || timingSafeEqual(headerSecret, secret);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
