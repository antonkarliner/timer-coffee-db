# Contributing to Timer.Coffee Backend

Thank you for your interest in contributing! This guide covers everything you need to get a local development environment running.

## Prerequisites

- [Deno](https://deno.com/) — runtime for edge functions
- [Supabase CLI](https://supabase.com/docs/guides/cli) — local dev stack
- Git

## Quick Start

1. **Clone the repository**
   ```bash
   git clone https://github.com/antonkarliner/timer-coffee-db
   cd timer-coffee-db
   ```

2. **Configure environment variables**
   ```bash
   cp .env.example .env.local
   # Edit .env.local — fill in your API keys (see Environment Variables below)
   ```

3. **Start the local stack**
   ```bash
   supabase start          # Boots API (:54321) and DB (:54322)
   supabase db push        # Applies all migrations
   ```

4. **Seed Vault** (required — migrations read the project URL from here)
   ```sql
   -- Run in Supabase Studio → SQL Editor after supabase start
   insert into vault.secrets (name, secret)
   values ('supabase_url', 'http://localhost:54321');
   ```

5. **Serve a function locally**
   ```bash
   supabase functions serve <function-name> --env-file .env.local
   ```

## Project Structure

```
timer-coffee-db/
├── supabase/
│   ├── config.toml              # Supabase project configuration
│   ├── functions/
│   │   ├── _shared/             # Shared utilities (CORS, FCM, rate limiting, etc.)
│   │   ├── notification-api/    # Full notification REST API
│   │   ├── send-fcm-notification/
│   │   ├── process-scheduled-notifications-fcm/
│   │   ├── roaster-enrichment-worker/
│   │   ├── parse-coffee-label/
│   │   ├── parse-coffee-label-gemini/
│   │   ├── parse-coffee-label-groq/
│   │   ├── content-moderation/
│   │   ├── content-moderation-gemini/
│   │   ├── translate-openai/
│   │   ├── generate-roaster-embedding/
│   │   ├── add-roaster/
│   │   ├── add-alias/
│   │   ├── check-new-roaster/
│   │   ├── check-new-version/
│   │   ├── geoip/
│   │   └── ...                  # 31 functions total
│   ├── migrations/              # SQL migrations (YYYYMMDDHHMMSS_description.sql)
│   └── seed.sql
├── scripts/                     # One-off utility scripts (Python/TypeScript)
├── .env.example                 # All environment variables with descriptions
├── CONTRIBUTING.md
├── LICENSE
└── README.md
```

**Always check `supabase/functions/_shared/` before writing new utility code** — it has CORS, security headers, rate limiting, FCM, moderation, translation, and logging helpers already implemented.

## Environment Variables

Copy `.env.example` to `.env.local`. The file documents every variable. Key groups:

### Supabase
| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key for server-side ops |

### OpenAI
| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Required for label parsing, translations, embeddings, and moderation |

### Other AI Services
| Variable | Purpose |
|----------|---------|
| `GROQ_API_KEY` | Label parsing, moderation fallback |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | Gemini service account (JSON) |
| `GEMINI_PROJECT_ID` | Google Cloud project ID |
| `GEMINI_REGION` | Gemini region (e.g. `us-central1`) |

### Firebase Cloud Messaging
| Variable | Purpose |
|----------|---------|
| `FIREBASE_SERVICE_ACCOUNT` | FCM service account (JSON) |
| `CRON_JOB_SECRET` | Authenticates scheduled notification triggers |

### App Stores
| Variable | Purpose |
|----------|---------|
| `APPSTORE_ISSUER_ID` | App Store Connect issuer ID |
| `APPSTORE_KEY_ID` | App Store Connect key ID |
| `APPSTORE_PRIVATE_KEY` | App Store Connect private key |
| `GOOGLE_PLAY_SERVICE_ACCOUNT` | Google Play service account (JSON) |
| `GOOGLE_PLAY_PACKAGE_NAME` | Android package name |

### Google Services
| Variable | Purpose |
|----------|---------|
| `GOOGLE_SEARCH_API_KEY` | Custom Search API key |
| `GOOGLE_PROGRAMMABLE_ENGINE_ID` | Custom Search Engine ID |
| `GEOCODING_API_KEY` | Geocoding API key |

### Security & Email
| Variable | Purpose |
|----------|---------|
| `ALLOWED_ORIGINS` | Comma-separated CORS origins |
| `RESEND_API_KEY` | Transactional email |
| `ADMIN_EMAIL` | Admin notification address |

> Never commit `.env.local` — it is excluded by `.gitignore`.

## Development Workflow

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** — edge functions live in `supabase/functions/<name>/index.ts`

3. **Test locally**
   ```bash
   supabase functions serve <function-name> --env-file .env.local
   # Then curl or use a REST client against http://localhost:54321/functions/v1/<function-name>
   ```

4. **New migration?** Name it correctly and apply:
   ```bash
   # File: supabase/migrations/YYYYMMDDHHMMSS_description.sql
   supabase db push
   ```

5. **Commit and open a PR**
   ```bash
   git add supabase/functions/my-function/index.ts   # stage specific files, not .
   git commit -m "feat: describe what and why"
   git push origin feature/your-feature-name
   ```

## Code Conventions

- TypeScript for all edge functions; Deno imports (no `node_modules`)
- Every function must include CORS headers — use `getCorsHeaders()` from `_shared/cors.ts`
- Validate all environment variables via `_shared/env-validation.ts`
- Use `logInfo()` / `logError()` from `_shared/monitoring.ts`, not `console.log`
- New tables **must** have RLS policies
- PL/pgSQL functions that need the project URL must read it from Vault (`supabase_url` secret), never hardcode it

## Security

- Never commit secrets or API keys
- Check `.gitignore` before staging new file types
- Rotate keys that may have been accidentally exposed

## Getting Help

- Open a GitHub issue with a clear description and reproduction steps
- Check existing issues before filing a new one

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE) for details.
