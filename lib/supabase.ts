import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client. Only ever imported from route handlers — the key is not
 * NEXT_PUBLIC_ prefixed, so a client component importing this fails the build.
 */
export function serverClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
