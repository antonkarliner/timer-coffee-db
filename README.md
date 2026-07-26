# Timer.Coffee Backend

Open-source backend for the [Timer.Coffee](https://timer.coffee) app — coffee timing, roaster management, push notifications, and AI-powered content features.

## Features

- **Coffee Recipe Storage** — store, manage, and share brewing recipes
- **Roaster Management** — add, verify, and enrich coffee roaster data with AI
- **Push Notifications** — Firebase Cloud Messaging with scheduling, translation, and analytics
- **AI Content Features** — coffee label parsing (OpenAI, Gemini, Groq), content moderation
- **Translation** — multi-language support for notifications and content via OpenAI
- **Logo Processing** — automatic roaster logo mirroring and optimization
- **App Version Monitoring** — track releases across App Store and Google Play
- **User Management** — authentication, data cleanup, rate limiting

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Deno (TypeScript) |
| Infrastructure | Supabase (PostgreSQL 15, auth, storage, edge functions) |
| AI | OpenAI (GPT-5.6 tiers, embeddings, moderation), Google Gemini, Groq |
| Notifications | Firebase Cloud Messaging (FCM) |
| Scheduling | pg_cron inside PostgreSQL |

## Quick Start

### Prerequisites

- [Deno](https://deno.com/)
- [Supabase CLI](https://supabase.com/docs/guides/cli)

### Setup

```bash
git clone https://github.com/antonkarliner/timer-coffee-db
cd timer-coffee-db

# Configure environment
cp .env.example .env.local
# Edit .env.local with your API keys and secrets

# Start local dev stack (API on :54321, DB on :54322)
supabase start

# Apply migrations
supabase db push
```

### Deploying an edge function

```bash
supabase functions deploy <function-name>
```

## Project Structure

```
supabase/
├── functions/               # 30+ Deno edge functions
│   ├── _shared/             # Shared utilities (CORS, auth, rate limiting, FCM, etc.)
│   ├── notification-api/    # Full notification REST API
│   ├── send-fcm-notification/
│   ├── process-scheduled-notifications-fcm/
│   ├── roaster-enrichment-worker/
│   ├── parse-coffee-label/  # OpenAI label parsing
│   ├── parse-coffee-label-gemini/
│   ├── content-moderation-gemini/
│   ├── translate-openai/
│   └── ...
├── migrations/              # SQL migrations (named YYYYMMDDHHMMSS_description.sql)
├── config.toml              # Supabase project configuration
└── seed.sql

scripts/                     # One-off utility scripts (Python/TypeScript)
.env.example                 # All environment variables with descriptions
```

## Environment Variables

Copy `.env.example` to `.env.local` for local development. The file documents all 80+ variables with descriptions and example values.

Key variable groups:

- **Supabase** — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- **OpenAI keys** — `OPENAI_API_KEY_NON_PERSONAL`, `OPENAI_API_KEY`
- **OpenAI models** — `OPENAI_MODEL_BIG`, `OPENAI_MODEL_MEDIUM`, `OPENAI_MODEL_SMALL`, plus specialized embedding and moderation model variables
- **Google / Gemini** — `GOOGLE_APPLICATION_CREDENTIALS_JSON`, `GEMINI_PROJECT_ID`
- **Firebase FCM** — `FIREBASE_SERVICE_ACCOUNT`, `FCM_PROJECT_ID`
- **App stores** — `APPSTORE_ISSUER_ID`, `APPSTORE_KEY_ID`, `GOOGLE_PLAY_SERVICE_ACCOUNT`
- **Notifications** — `CRON_JOB_SECRET`, `ALLOWED_ORIGINS`
- **Groq** — `GROQ_API_KEY`

For production, set secrets with:

```bash
supabase secrets set KEY=value
```

> **Never commit `.env.local` or any real secrets.** The `.gitignore` already excludes `.env` files.

## Important Notes for Self-Hosting

Several database migration files contain references to the project URL inside PostgreSQL functions and triggers. These functions fetch the URL from **Supabase Vault** at runtime using the `supabase_url` secret — you must store your own project URL in Vault before running them:

```sql
-- Run in your Supabase SQL editor after deploying
insert into vault.secrets (name, secret)
values ('supabase_url', 'https://your-project-ref.supabase.co');
```

Two triggers use `supabase_functions.http_request()` with a hardcoded placeholder URL (`your-project-ref.supabase.co`). Search for `your-project-ref` in the migrations directory and update these to your actual project URL if you apply them to a fresh project.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE) for details.
