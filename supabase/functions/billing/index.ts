// World Explorer billing (Supabase Edge Function).
//
// POST { action: "checkout" } -> { url } Stripe Checkout page for Pro
// POST { action: "portal" }   -> { url } Stripe Customer Portal (manage / cancel)
//
// Pro access itself is granted by the stripe-webhook function after Stripe
// confirms payment, never by this function or the browser.
//
// Secrets:
//   STRIPE_SECRET_KEY   required (sk_test_... while testing, sk_live_... for real)
//   STRIPE_PRICE_ID     required, the $3.99/month recurring price (price_...)
//   SITE_URL            required, where users return after paying, e.g. https://worldlyexplorer.netlify.app
//   ALLOWED_ORIGIN      optional, defaults to *

import Stripe from "npm:stripe@23.0.1";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "");
const PRICE_ID = Deno.env.get("STRIPE_PRICE_ID") ?? "";
const SITE_URL = (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!PRICE_ID || !SITE_URL) return json(500, { error: "billing_not_configured" });

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json(401, { error: "sign_in_required" });
  const user = userData.user;

  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .select("tier, stripe_customer_id")
    .eq("id", user.id)
    .single();
  if (profileErr || !profile) return json(500, { error: "profile_not_found" });

  try {
    if (body.action === "portal") {
      if (!profile.stripe_customer_id) return json(400, { error: "no_subscription" });
      const portal = await stripe.billingPortal.sessions.create({
        customer: profile.stripe_customer_id,
        return_url: SITE_URL,
      });
      return json(200, { url: portal.url });
    }

    if (body.action === "checkout") {
      if (profile.tier === "pro") return json(409, { error: "already_pro" });

      // One Stripe customer per user, linked both ways.
      let customerId = profile.stripe_customer_id as string | null;
      if (!customerId) {
        const customer = await stripe.customers.create(
          { email: user.email, metadata: { user_id: user.id } },
          { idempotencyKey: `customer-${user.id}` },
        );
        customerId = customer.id;
        const { error } = await admin
          .from("profiles")
          .update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() })
          .eq("id", user.id);
        if (error) throw new Error(`could not save customer id: ${error.message}`);
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: PRICE_ID, quantity: 1 }],
        client_reference_id: user.id,
        subscription_data: { metadata: { user_id: user.id } },
        allow_promotion_codes: true,
        success_url: `${SITE_URL}/?checkout=success`,
        cancel_url: `${SITE_URL}/?checkout=cancel`,
      });
      if (!session.url) throw new Error("checkout session has no url");
      return json(200, { url: session.url });
    }

    return json(400, { error: "invalid_action" });
  } catch (error) {
    console.error("Billing error:", error);
    return json(502, { error: "billing_unavailable" });
  }
});
