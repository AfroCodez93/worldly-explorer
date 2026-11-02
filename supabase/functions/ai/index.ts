// World Explorer AI endpoint (Supabase Edge Function).
//
// Why this exists: the Anthropic API key must never ship in the browser, and
// free users must not be able to run up the bill. Every request here:
//   1. must come from a signed-in user (Supabase JWT),
//   2. must belong to a paid ("pro") account,
//   3. must fit inside that user's daily AI limit (counted in the database),
//   4. can only run prompts defined on this server (no free-form proxying).
//
// Secrets (set with `supabase secrets set ...`):
//   ANTHROPIC_API_KEY      required
//   ANTHROPIC_MODEL        optional, defaults to claude-opus-5-5
//   PRO_DAILY_AI_LIMIT     optional, defaults to 30 requests per user per UTC day
//   ALLOWED_ORIGIN         optional, e.g. https://afrocodez93.github.io (defaults to *)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

import Anthropic from "npm:@anthropic-ai/sdk@0.135.0";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-opus-5-5";
const limitEnv = Number.parseInt(Deno.env.get("PRO_DAILY_AI_LIMIT") ?? "", 10);
const PRO_DAILY_LIMIT = Number.isFinite(limitEnv) && limitEnv > 0 ? limitEnv : 30;
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

  // 2. Are they paid?
  const { data: profile } = await admin.from("profiles").select("tier").eq("id", userId).single();
  if (profile?.tier !== "pro") return json(403, { error: "upgrade_required" });

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
      model: MODEL,
      max_tokens: 6000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: DECK_PROMPTS[category] }],
      output_config: { effort: "low", format: { type: "json_schema", schema: DECK_SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
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
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
  } else {
    return json(400, { error: "invalid_action" });
  }

  // 4. Take one credit (atomic; fails when the daily limit is reached).
  const { data: allowed, error: quotaErr } = await admin.rpc("consume_ai_quota", {
    p_user: userId,
    p_limit: PRO_DAILY_LIMIT,
  });
  if (quotaErr) return json(500, { error: "quota_check_failed" });
  if (!allowed) return json(429, { error: "daily_limit_reached", limit: PRO_DAILY_LIMIT });

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
