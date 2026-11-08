// World Explorer AI endpoint (Supabase Edge Function).
//
// Why this exists: the Anthropic API key must never ship in the browser, and
// free users must not be able to run up the bill. Every request here:
//   1. must come from a signed-in user (Supabase JWT),
//   2. free users get a small lifetime trial on a low-cost model; Pro users
//      get daily and monthly caps (all counted in the database),
//   3. can only run prompts defined on this server (no free-form proxying).
//
// Secrets (set with `supabase secrets set ...`):
//   ANTHROPIC_API_KEY      required
//   PRO_MODEL              optional, defaults to claude-opus-5-5
//   TRIAL_MODEL            optional, defaults to claude-haiku-5-5
//   FREE_TRIAL_AI_LIMIT    optional, lifetime requests for free users, default 3 (0 = no trial)
//   PRO_DAILY_AI_LIMIT     optional, default 10 requests per UTC day
//   PRO_MONTHLY_AI_LIMIT   optional, default 100 requests per UTC calendar month
//   ALLOWED_ORIGIN         optional, e.g. https://your-site.netlify.app (defaults to *)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

import Anthropic from "npm:@anthropic-ai/sdk@0.135.0";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

function intEnv(name: string, fallback: number, min = 1): number {
  const v = Number.parseInt(Deno.env.get(name) ?? "", 10);
  return Number.isFinite(v) && v >= min ? v : fallback;
}

const PRO_MODEL = Deno.env.get("PRO_MODEL") ?? "claude-opus-5-5";
const TRIAL_MODEL = Deno.env.get("TRIAL_MODEL") ?? "claude-haiku-5-5";
const FREE_TRIAL_LIMIT = intEnv("FREE_TRIAL_AI_LIMIT", 3, 0);
const PRO_DAILY_LIMIT = intEnv("PRO_DAILY_AI_LIMIT", 10);
const PRO_MONTHLY_LIMIT = intEnv("PRO_MONTHLY_AI_LIMIT", 100);

// Server-side refusal fallbacks exist for these models only (not Haiku).
const supportsFallback = (model: string) => /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
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

// ---------- prompts (server-side only) ----------
type Category = "etymology" | "history" | "geography";
const CATEGORIES: Category[] = ["etymology", "history", "geography"];

const DECK_PROMPTS: Record<Category, string> = {
  etymology:
    "Generate exactly 10 flashcards about fascinating word origins. front: a single interesting (not too common) word. back: its etymology in 2-3 sentences (origin language, root words, literal meaning, historical context). category: a subcategory such as Medical, Mythology, Science or Food. source: a reputable reference such as Online Etymology Dictionary or Oxford English Dictionary.",
  history:
    "Generate exactly 10 flashcards about historical events, figures or concepts across diverse periods and regions. front: a question. back: a 2-4 sentence answer with dates, context and significance. category: a subcategory such as Ancient, Medieval, Modern, Military or Cultural. source: a reputable reference such as Encyclopaedia Britannica.",
  geography:
    "Generate exactly 10 flashcards about physical geography, countries, landmarks or natural phenomena. front: a question. back: a 2-4 sentence answer with specific facts, measurements and locations. category: a subcategory such as Physical, Climate, Oceans, Landforms or Countries. source: a reputable reference such as National Geographic.",
};

const DECK_SCHEMA = {
  type: "object",
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          front: { type: "string" },
          back: { type: "string" },
          category: { type: "string" },
          source: { type: "string" },
        },
        required: ["front", "back", "category", "source"],
        additionalProperties: false,
      },
    },
  },
  required: ["cards"],
  additionalProperties: false,
};

const SYSTEM_PROMPT =
  "You are the World Explorer instructor: a warm, precise teacher of history, geography and etymology. " +
  "Only state facts you are confident are accurate and widely documented. If something is uncertain or disputed, say so plainly. " +
  "Stay on educational topics; politely decline anything unrelated to learning.";

const MAX_QUESTION_CHARS = 500;
const MAX_CONTEXT_CHARS = 1500;

// ---------- request handling ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  // 1. Who is calling?
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json(401, { error: "sign_in_required" });
  const userId = userData.user.id;

  // 2. Pro or free trial?
  const { data: profile } = await admin.from("profiles").select("tier").eq("id", userId).single();
  const isPro = profile?.tier === "pro";
  if (!isPro && FREE_TRIAL_LIMIT === 0) return json(403, { error: "upgrade_required" });
  const model = isPro ? PRO_MODEL : TRIAL_MODEL;
  const fallback = supportsFallback(model)
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};

  // 3. Validate input before spending a credit.
  let body: { action?: string; category?: string; question?: string; context?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  let request: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
  if (body.action === "deck") {
    const category = body.category as Category;
    if (!CATEGORIES.includes(category)) return json(400, { error: "invalid_category" });
    request = {
      model,
      max_tokens: 6000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: DECK_PROMPTS[category] }],
      output_config: { effort: "low", format: { type: "json_schema", schema: DECK_SCHEMA } },
      ...fallback,
    };
  } else if (body.action === "ask") {
    const question = (body.question ?? "").trim();
    const context = (body.context ?? "").trim().slice(0, MAX_CONTEXT_CHARS);
    if (!question || question.length > MAX_QUESTION_CHARS) {
      return json(400, { error: "invalid_question", max: MAX_QUESTION_CHARS });
    }
    const content = context
      ? `The learner is studying this fact:\n<fact>\n${context}\n</fact>\n\nTheir question:\n<question>\n${question}\n</question>\n\nAnswer in under 200 words.`
      : `Learner's question:\n<question>\n${question}\n</question>\n\nAnswer in under 200 words.`;
    request = {
      model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
      output_config: { effort: "low" },
      ...fallback,
    };
  } else {
    return json(400, { error: "invalid_action" });
  }

  // 4. Take one credit (atomic). Free: lifetime trial. Pro: daily + monthly caps.
  const { data: allowed, error: quotaErr } = await admin.rpc("consume_ai_credit", {
    p_user: userId,
    p_daily: isPro ? PRO_DAILY_LIMIT : null,
    p_monthly: isPro ? PRO_MONTHLY_LIMIT : null,
    p_lifetime: isPro ? null : FREE_TRIAL_LIMIT,
  });
  if (quotaErr) return json(500, { error: "quota_check_failed" });
  if (!allowed) {
    return isPro
      ? json(429, { error: "limit_reached", daily: PRO_DAILY_LIMIT, monthly: PRO_MONTHLY_LIMIT })
      : json(403, { error: "trial_used", trial: FREE_TRIAL_LIMIT });
  }

  // 5. Call Claude. Refund the credit if anything goes wrong.
  try {
    const response = await anthropic.beta.messages.create(request);

    // Declined requests are still billed, so they keep using a credit
    // (otherwise they could be spammed for free).
    if (response.stop_reason === "refusal") return json(422, { error: "request_declined" });

    // If a fallback model took over, text before the last `fallback` block is
    // the declining model's partial output: keep only what follows it.
    let text = "";
    for (const block of response.content) {
      if (block.type === "fallback") text = "";
      else if (block.type === "text") text += block.text;
    }

    if (response.stop_reason === "max_tokens") throw new Error("response truncated");

    if (body.action === "deck") {
      const parsed = JSON.parse(text) as { cards: unknown[] };
      if (!Array.isArray(parsed.cards) || parsed.cards.length === 0) throw new Error("empty deck");
      return json(200, { cards: parsed.cards });
    }
    return json(200, { answer: text.trim() });
  } catch (error) {
    await admin.rpc("refund_ai_quota", { p_user: userId });
    if (error instanceof Anthropic.RateLimitError) return json(503, { error: "ai_busy" });
    if (error instanceof Anthropic.APIError) {
      console.error(`Anthropic API error ${error.status}: ${error.message}`);
      return json(502, { error: "ai_unavailable" });
    }
    console.error("AI request failed:", error);
    return json(502, { error: "ai_failed" });
  }
});
