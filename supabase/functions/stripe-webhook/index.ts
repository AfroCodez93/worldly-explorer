// World Explorer Stripe webhook (Supabase Edge Function).
//
// Stripe calls this after checkout and whenever a subscription changes
// (renewal, failed payment, cancellation). It is the ONLY place that grants or
// removes Pro. Every request is verified with the webhook signing secret, and
// the subscription is re-read from Stripe so out-of-order events can't leave a
// user with the wrong tier.
//
// JWT verification is turned off for this function in supabase/config.toml,
// because Stripe can't send a Supabase login token. The Stripe signature check
// below replaces it.
//
// Secrets:
//   STRIPE_SECRET_KEY       required
//   STRIPE_WEBHOOK_SECRET   required (whsec_..., from the webhook endpoint in Stripe)

import Stripe from "npm:stripe@23.0.1";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "");
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// Statuses that keep Pro access. Anything else (past_due, unpaid, canceled,
// incomplete, ...) drops the user back to free.
const PRO_STATUSES = new Set(["active", "trialing"]);

const idOf = (v: string | { id: string } | null | undefined) =>
  typeof v === "string" ? v : v?.id ?? null;

async function syncSubscription(subscriptionId: string): Promise<void> {
  let sub: Stripe.Subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const customerId = idOf(sub.customer);
  if (!customerId) return;

  // If this subscription has ended, the customer may still have another active one
  // (e.g. they cancelled and re-subscribed). Prefer the active one.
  if (!PRO_STATUSES.has(sub.status)) {
    const active = await stripe.subscriptions.list({ customer: customerId, status: "active", limit: 1 });
    if (active.data[0]) sub = active.data[0];
  }

  // Find the user: by stored customer id, else by the user id we put in metadata.
  let { data: profile } = await admin
    .from("profiles").select("id").eq("stripe_customer_id", customerId).maybeSingle();
  if (!profile && sub.metadata?.user_id) {
    ({ data: profile } = await admin
      .from("profiles").select("id").eq("id", sub.metadata.user_id).maybeSingle());
  }
  if (!profile) {
    console.error(`No profile for Stripe customer ${customerId}`);
    return; // nothing to update; don't make Stripe retry forever
  }

  const periodEnd = sub.items.data[0]?.current_period_end;
  const { error } = await admin.from("profiles").update({
    tier: PRO_STATUSES.has(sub.status) ? "pro" : "free",
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    subscription_status: sub.status,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("id", profile.id);
  if (error) throw new Error(`profile update failed: ${error.message}`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!WEBHOOK_SECRET) return new Response("webhook not configured", { status: 500 });

  const signature = req.headers.get("Stripe-Signature");
  if (!signature) return new Response("missing signature", { status: 400 });

  const payload = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, signature, WEBHOOK_SECRET, undefined, cryptoProvider);
  } catch (err) {
    console.error("Webhook signature check failed:", (err as Error).message);
    return new Response("invalid signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const subId = idOf(event.data.object.subscription);
        if (subId) await syncSubscription(subId);
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncSubscription(event.data.object.id);
        break;
      default:
        break; // other events are ignored
    }
  } catch (err) {
    console.error(`Failed to handle ${event.type}:`, err);
    return new Response("handler error", { status: 500 }); // Stripe will retry
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
