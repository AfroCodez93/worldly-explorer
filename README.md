# World Explorer

A history, geography and etymology learning app in one file (`index.html`).
It has quizzes, flashcards, a World Tour, "Today in History", streaks and achievements.

## How it runs

| Mode | What works |
|------|------------|
| **Local-only** (default, no setup) | Everything except AI. Progress is saved in the browser. |
| **With Supabase + Stripe** | Accounts (email sign-in link), progress synced across devices, a free AI trial, and Pro subscriptions. |

## Free vs Pro

| Feature | Free (signed in) | Pro ($3.99/mo) |
|---|---|---|
| Quizzes, curated flashcards, World Tour, Today in History | ✅ | ✅ |
| Streak and progress saved to account | ✅ | ✅ |
| AI flashcard decks + Ask the AI instructor | 3 lifetime tries (Haiku) | 10/day, 100/month |

The server enforces this, not the browser:

- The Anthropic and Stripe keys exist only as Supabase secrets. They never reach the browser.
- The `ai` function rejects anyone who isn't signed in. Free users get a lifetime trial (`FREE_TRIAL_AI_LIMIT`, default 3) on `TRIAL_MODEL` (default `claude-haiku-5-5`). Pro users get `PRO_DAILY_AI_LIMIT` (default 10) and `PRO_MONTHLY_AI_LIMIT` (default 100) on `PRO_MODEL` (default `claude-opus-5-5`). The database counts every request atomically, and a failed AI call refunds its credit.
- Only the `stripe-webhook` function can grant or remove Pro, and only after a Stripe-signed event. The subscription is re-read from Stripe each time. Users can't edit their own `tier`.
- Pro lasts while the Stripe subscription is `active` or `trialing`. A failed payment (`past_due`), cancellation, or non-payment drops the user to Free.
- Prompts live on the server, and questions are capped at 500 characters, so the endpoint can't be used as a general-purpose AI proxy.

## Setup

### 1. Supabase (about 15 minutes)

1. **Create or restore a project** at [supabase.com/dashboard](https://supabase.com/dashboard). Free-tier projects pause after a period of inactivity; a paused project can be restored from the dashboard.
2. **Create the tables.** In the SQL Editor, run both files in `supabase/migrations/` **in order** (`20261102…` first, then `20261108…`).
   Or use the CLI: `supabase link --project-ref <ref>` and then `supabase db push`.
3. **Turn on email sign-in.** Go to Authentication → Providers → Email.
   Under Authentication → URL Configuration, set the **Site URL** to your Netlify URL.
4. **Connect the app.** In `index.html`, find `APP_CONFIG` and paste your Project URL and the **anon** public key (Project Settings → API). Never paste the `service_role` key into the app.

### 2. Stripe (about 15 minutes; use **Test mode** first)

1. **Create the product.** At [dashboard.stripe.com](https://dashboard.stripe.com), turn on **Test mode**. Go to Product catalog → Add product.
   Name it "World Explorer Pro" with a recurring price of **$3.99 / month**. Copy the **price ID** (`price_…`).
2. **Get the secret key.** Under Developers → API keys, copy the **Secret key** (`sk_test_…`).
3. **Turn on the customer portal.** Go to Settings → Billing → Customer portal, and allow customers to cancel and update payment methods. Save.
4. **Add the webhook.** Go to Developers → Webhooks → Add endpoint.
   - URL: `https://<your-project-ref>.supabase.co/functions/v1/stripe-webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the **Signing secret** (`whsec_…`).

### 3. Deploy the functions

```bash
supabase link --project-ref <your-project-ref>

supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set STRIPE_SECRET_KEY=sk_test_...
supabase secrets set STRIPE_PRICE_ID=price_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set SITE_URL=https://worldlyexplorer.netlify.app
supabase secrets set ALLOWED_ORIGIN=https://worldlyexplorer.netlify.app

# optional tuning (defaults shown)
supabase secrets set PRO_MODEL=claude-opus-5-5 TRIAL_MODEL=claude-haiku-5-5
supabase secrets set FREE_TRIAL_AI_LIMIT=3 PRO_DAILY_AI_LIMIT=10 PRO_MONTHLY_AI_LIMIT=100

supabase functions deploy ai
supabase functions deploy billing
supabase functions deploy stripe-webhook --no-verify-jwt   # Stripe can't send a login token; the function checks Stripe's signature instead
```

### 4. Test a purchase

1. Sign in on the site. Your 3 free AI tries should work, and the 4th should ask you to upgrade.
2. Click **Upgrade to Pro**. Pay with Stripe's test card `4242 4242 4242 4242`, any future date, any CVC.
3. You return to the site, which shows "Activating Pro…" and then the **Pro** badge.
4. **Manage subscription** opens Stripe's portal. Cancel there, and the account drops back to Free when the subscription ends.
5. To go live, repeat Stripe steps 1–4 with Test mode off. Then replace `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET` with the live values.

## AI cost control

- **Worst case per Pro user per month = `PRO_MONTHLY_AI_LIMIT` × cost per request.** At $3.99, Stripe's fee is about $0.42 (2.9% + 30¢ for US cards), which leaves about $3.57.
- These are rough estimates; check real numbers in the Anthropic Console after launch:
  - **Opus 5.5:** about $0.01–0.04 per request, so 100 requests ≈ $1–4 a month. That can wipe out the margin.
  - **Sonnet 5.5:** about half the cost of Opus.
  - **Haiku 5.5:** about 40× cheaper than Opus, roughly $0.05 for 100 requests.
- For the market test, consider setting `PRO_MODEL=claude-sonnet-5-5` or `claude-haiku-5-5`, then compare answer quality.
- Set a monthly spend limit in the Anthropic Console as a hard backstop.

## Roadmap

- [x] Stripe checkout, customer portal, and a webhook that sets `profiles.tier`
- [x] Free AI trial for signed-in users
- [ ] Ads for free users, removed for Pro
- [ ] Classroom: a teacher account with student seats and the AI instructor
- [ ] Deeper "story behind the event" write-ups (Pro)
- [ ] Optional `on-this-day` Edge Function for curated history (`HISTORY_CONFIG.supabaseUrl`)
