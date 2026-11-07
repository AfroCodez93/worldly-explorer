# World Explorer

A history, geography and etymology learning app in one file (`index.html`).
It has quizzes, flashcards, a World Tour, "Today in History", streaks and achievements.

## How it runs

| Mode | What works |
|------|------------|
| **Local-only** (default, no setup) | Everything except AI. Progress is saved in the browser. |
| **With Supabase** | Accounts (email sign-in link), progress synced across devices, and AI features for Pro users. |

## Free vs Pro

| Feature | Free (signed in) | Pro |
|---|---|---|
| Quizzes, curated flashcards, World Tour, Today in History | ✅ | ✅ |
| Streak and progress saved to account | ✅ | ✅ |
| AI flashcard decks | ❌ | ✅ |
| Ask the AI instructor | ❌ | ✅ |

The server enforces this, not the browser:

- The Anthropic API key exists only as a Supabase secret and never reaches the browser.
- The `ai` Edge Function rejects anyone who isn't signed in (401) or isn't Pro (403).
- Pro users get a daily cap (`PRO_DAILY_AI_LIMIT`, default 30 per UTC day), counted in the database (429 when reached). Failed AI calls refund the credit.
- Users can't make themselves Pro. The `profiles` table has no update policy for users, so only the service role (later, the Stripe webhook) can change `tier`.
- Prompts live on the server. Users pick an action (`deck` or `ask`), and questions are capped at 500 characters, so the endpoint can't be used as a general-purpose AI proxy.

## Supabase setup (about 15 minutes)

1. **Create or restore a project** at [supabase.com/dashboard](https://supabase.com/dashboard). Free-tier projects pause after a period of inactivity; a paused project can be restored from the dashboard.
2. **Create the tables.** Open the SQL Editor, paste `supabase/migrations/20261102000000_accounts_and_ai_quota.sql`, and run it.
   Or use the CLI: `supabase link --project-ref <ref>` and then `supabase db push`.
3. **Turn on email sign-in.** Go to Authentication → Providers → Email, and enable it.
   Under Authentication → URL Configuration, set the **Site URL** to where the app is hosted (for example your GitHub Pages URL).
4. **Deploy the AI function** with the [Supabase CLI](https://supabase.com/docs/guides/cli):
   ```bash
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   supabase secrets set ALLOWED_ORIGIN=https://<your-site>      # optional, recommended
   supabase secrets set PRO_DAILY_AI_LIMIT=30                   # optional
   supabase secrets set ANTHROPIC_MODEL=claude-opus-5-5         # optional
   supabase functions deploy ai
   ```
5. **Connect the app.** In `index.html`, find `APP_CONFIG` and paste your Project URL and the **anon** public key (Project Settings → API). Never paste the `service_role` key into the app.
6. **Test Pro manually** until payments exist: in Table Editor → `profiles`, set your own row's `tier` to `pro`.

## AI cost control

- The cost per request depends on the model. `ANTHROPIC_MODEL` lets you change models without editing code.
- Also set a monthly spend limit in the Anthropic Console as a hard backstop.
- To keep a single user's maximum daily cost bounded, lower `PRO_DAILY_AI_LIMIT`.

## Roadmap

- [ ] Stripe checkout and a webhook Edge Function that sets `profiles.tier = 'pro'`
- [ ] Ads for free users, removed for Pro
- [ ] Classroom: a teacher account with student seats and the AI instructor
- [ ] Deeper "story behind the event" write-ups (Pro)
- [ ] Optional `on-this-day` Edge Function for curated history (`HISTORY_CONFIG.supabaseUrl`)
