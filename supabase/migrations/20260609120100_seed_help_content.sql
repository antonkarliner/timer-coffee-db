-- Initial English help content. English is the source locale (is_translated = false);
-- the translation pipeline can fill localized rows later. Idempotent: re-running
-- refreshes the text via ON CONFLICT DO UPDATE.

insert into "public"."help_categories"
    ("slug", "locale", "title", "icon", "sort_order", "is_translated")
values
    ('beans',     'en', 'Coffee Beans',      'coffee',     1, false),
    ('brewing',   'en', 'Brewing & Timer',   'timer',      2, false),
    ('recipes',   'en', 'Recipes',           'menu_book',  3, false),
    ('account',   'en', 'Account & Sync',    'cloud_sync', 4, false),
    ('community', 'en', 'Stats & Community', 'groups',     5, false)
on conflict ("slug", "locale") do update set
    "title" = excluded."title",
    "icon" = excluded."icon",
    "sort_order" = excluded."sort_order",
    "is_translated" = excluded."is_translated",
    "updated_at" = now();

insert into "public"."help_articles"
    ("slug", "locale", "category_slug", "title", "body", "sort_order", "is_translated")
values
    ('ai-bag-scan', 'en', 'beans', 'Scan a coffee bag with AI', $md$## Scan a coffee bag with AI

Adding beans by hand is optional. Timer.Coffee can read the label on a coffee bag and fill in the details for you.

**Where to find it**
Open the **Beans** tab and tap **Add bean**. On the new bean screen, tap the **AI Scan** button (the camera with a sparkle).

**How it works**
1. Photograph the front and back of the bag (up to two photos).
2. The app reads the text on your device, then parses it.
3. Fields like roaster, origin, variety, process, roast date and tasting notes are filled in automatically.
4. Review and correct anything, then save. You can also keep one photo as the bean cover image.

**Tips**
- Good lighting and a flat, in-focus label give the best results.
- Nothing is locked in: every field stays editable after the scan.$md$, 1, false),

    ('bean-reviews', 'en', 'beans', 'Rate and review your beans', $md$## Rate and review your beans

Every bean can have a detailed tasting review, not just a note.

**Where to find it**
Open a bean from the **Beans** tab and scroll to the review section.

**What you can record**
- An overall rating.
- Sliders for sweetness, acidity, fruitiness, body, bitterness and aftertaste.
- Flavor tags and free-text notes.
- A "would buy again" toggle.

Make a review public to share it on the roaster profile, or keep it private just for you.$md$, 2, false),

    ('quick-notes', 'en', 'beans', 'Quick notes and grind size', $md$## Quick notes and grind size

You do not need to open the full edit screen to jot something down.

**Where to find it**
On a bean detail screen, use the **Quick notes** card.

There you can save your preferred grind size and a short note (for example, a dialed-in grinder setting) without editing the whole bean. It is the fastest way to remember what worked.$md$, 3, false),

    ('live-activities', 'en', 'brewing', 'Live Activities and Dynamic Island', $md$## Live Activities and Dynamic Island (iOS)

While you brew, Timer.Coffee shows the current step and a live countdown on your Lock Screen and in the Dynamic Island, so you can put the phone down.

**Where to find it**
Start any brew on iOS 16.1 or later. The Live Activity appears automatically, with no setup needed.

It updates as each step changes and clears itself when the brew finishes. On Android, an ongoing notification shows the same step and countdown.$md$, 1, false),

    ('manual-step-control', 'en', 'brewing', 'Manual step control (advanced)', $md$## Manual step control (advanced)

By default the timer advances steps automatically. If you prefer to control each pour yourself, switch to manual stepping.

**Where to find it**
Go to **Settings → Advanced** and enable **Manual step control**.

With it on, the brewing screen waits for you to tap to the next step instead of advancing on a timer. Turn it off any time to return to the guided countdown.$md$, 2, false),

    ('manual-brew-entry', 'en', 'brewing', 'Log a brew made without the timer', $md$## Log a brew you made without the timer

Brewed a coffee away from the app? You can still add it to your diary.

**Where to find it**
Open the **Brew Diary** and tap **Manual entry**.

Pick the method, recipe and bean, enter the amounts and grind, set the date and time, and save. The brew counts toward your stats just like a timed one.$md$, 3, false),

    ('share-recipes', 'en', 'recipes', 'Share and import recipes', $md$## Share and import recipes

Any recipe can be shared as a link, and links others send you open straight into the app.

**Where to find it**
Open a recipe and tap the **Share** button to generate a link.

When you open a shared link, the recipe is imported into **Your recipes**. From there you can brew it, edit it, or (if you are signed in) publish your own recipes for others to find.$md$, 1, false),

    ('create-recipes', 'en', 'recipes', 'Create your own recipe', $md$## Create your own recipe

You are not limited to the built-in recipes: build your own step by step.

**Where to find it**
On the home screen tap **New recipe**, or start from **Your recipes** in the Hub.

Set the method, coffee and water, then add, reorder and time each step. An optional **AI review** can sanity-check your recipe (sign-in required). Save it privately, or publish it to the community.$md$, 2, false),

    ('collections', 'en', 'recipes', 'Recipe collections', $md$## Recipe collections

Collections are curated sets of recipes grouped by theme rather than by brewing method, for example quick brews or iced coffee.

**Where to find it**
Open the **Hub** tab and browse the collections carousel.

Tap a collection to see the recipes inside and brew any of them directly.$md$, 3, false),

    ('account-sync', 'en', 'account', 'Accounts and syncing across devices', $md$## Accounts and syncing across devices

Your data lives on your device by default. Sign in to back it up and sync it across devices.

**Where to find it**
Open the **Hub** tab and tap **Account**, then sign in with Apple, Google or email.

Anything you added before signing in (beans, recipes, brews) is merged into your account automatically. Bean cover photos and publishing recipes also require sign-in.$md$, 1, false),

    ('stats-and-pulse', 'en', 'community', 'Stats, Pulse and your coffee story', $md$## Stats, Pulse and your coffee story

Timer.Coffee turns your brews into insights and connects them to the global community.

**Where to find it (Hub tab)**
- **Stats**: your totals by week, month, year or all time, plus live global figures.
- **Pulse**: a real-time feed of coffees being brewed around the world right now.
- **Brew Diary**: every brew you have logged, with the details.

At the turn of the year, a yearly story recaps your coffee journey.$md$, 1, false)
on conflict ("slug", "locale") do update set
    "category_slug" = excluded."category_slug",
    "title" = excluded."title",
    "body" = excluded."body",
    "sort_order" = excluded."sort_order",
    "is_translated" = excluded."is_translated",
    "updated_at" = now();
