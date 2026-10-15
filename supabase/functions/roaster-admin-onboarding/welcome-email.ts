// Welcome email sent when a roaster admin is linked to a roaster profile.
// Kept apart from index.ts, which needs Supabase env at import time, so the
// templates can be imported and rendered locally with plain `deno run`.

export const WELCOME_EMAIL_FROM =
  "Anton from Timer.Coffee <support@timer.coffee>";

export type WelcomeEmailArgs = {
  email: string;
  loginUrl: string;
  roasterName: string;
  slug: string;
  // From the matching claim request; null when the admin onboarded the
  // roaster directly (festival mode) and there is no claim.
  claimantFullName: string | null;
  hasDescription: boolean;
};

type WelcomeEmailContent = {
  greeting: string;
  intro: string;
  features: Array<{ title: string; body: string }>;
  firstSteps: string;
  publicUrl: string;
  guideUrl: string;
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function firstName(fullName: string | null) {
  const first = fullName?.trim().split(/\s+/)[0];
  return first ? first : null;
}

function joinSteps(steps: string[]) {
  if (steps.length === 1) {
    return steps[0];
  }

  return `${steps.slice(0, -1).join(", ")}, and ${steps[steps.length - 1]}`;
}

function buildContent(args: WelcomeEmailArgs): WelcomeEmailContent {
  const name = firstName(args.claimantFullName);
  const publicUrl = new URL(
    `/roasters/${args.slug}/`,
    new URL(args.loginUrl).origin,
  )
    .toString();
  const guideUrl = new URL(
    "/roaster-admin/guide/",
    new URL(args.loginUrl).origin,
  )
    .toString();
  const hasNumericSlug = /^\d+$/.test(args.slug);

  const intro = args.claimantFullName
    ? `Thanks for claiming ${args.roasterName} on Timer.Coffee. Your claim is approved, so ${args.email} now manages your roaster page.`
    : `We've set up ${args.email} to manage the ${args.roasterName} roaster page on Timer.Coffee.`;

  const steps: string[] = [];

  if (!args.hasDescription) {
    steps.push(
      "write two or three sentences about who you are and how you roast",
    );
  }

  if (hasNumericSlug) {
    steps.push(
      `pick a readable page address instead of /roasters/${args.slug}/`,
    );
  }

  steps.push("add a recipe for the coffee you sell most");

  return {
    greeting: name ? `Hi ${name},` : "Hi there,",
    intro,
    features: [
      {
        title: "Edit your page",
        body: "description, website and social links",
      },
      { title: "Update your logo", body: "upload or replace it any time" },
      {
        title: "Choose your page address",
        body: "a readable link like /roasters/your-roastery/",
      },
      {
        title: "Add brew recipes",
        body:
          "for your coffees, with AI help or from scratch, and publish them to your page",
      },
      {
        title: "Reply to reviews",
        body: "answer publicly when Timer.Coffee users review your beans",
      },
    ],
    firstSteps: `${
      steps.length > 1 ? "A good first ten minutes" : "A good place to start"
    }: ${
      joinSteps(steps)
    }. That's what people see first when they find you through the app.`,
    publicUrl,
    guideUrl,
  };
}

export function buildWelcomeEmailSubject(
  args: Pick<WelcomeEmailArgs, "roasterName">,
) {
  return `${args.roasterName} is now yours on Timer.Coffee`;
}

export function buildWelcomeEmailHtml(args: WelcomeEmailArgs) {
  const content = buildContent(args);
  const email = escapeHtml(args.email);
  const loginUrl = escapeHtml(args.loginUrl);
  const publicUrl = escapeHtml(content.publicUrl);
  const guideUrl = escapeHtml(content.guideUrl);
  const p = 'style="margin:0 0 16px;font-size:16px;line-height:1.6;"';

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<body style=\"margin:0;padding:0;background:#f7f1e8;color:#1c1917;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;\">",
    '<div style="max-width:600px;margin:0 auto;padding:32px 20px;">',
    '<div style="background:#fffdf8;border:1px solid #e7dbc9;border-radius:24px;padding:32px;">',
    '<p style="margin:0 0 12px;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#78716c;">Timer.Coffee roaster access</p>',
    `<p ${p}>${escapeHtml(content.greeting)}</p>`,
    `<p ${p}>${escapeHtml(content.intro)}</p>`,
    `<p style="margin:0 0 8px;font-size:16px;line-height:1.6;"><strong>Sign in:</strong> enter <strong>${email}</strong> and we'll email you a one-time code. There's no password to set up, but always sign in with this same address.</p>`,
    `<p style="margin:16px 0 24px;"><a href="${loginUrl}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:14px 20px;border-radius:999px;font-weight:600;">Open roaster admin</a></p>`,
    `<p style="margin:0 0 8px;font-size:16px;line-height:1.6;">Once you're in, you can:</p>`,
    '<ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.7;">',
    ...content.features.map((feature) =>
      `<li><strong>${escapeHtml(feature.title)}:</strong> ${
        escapeHtml(feature.body)
      }</li>`
    ),
    "</ul>",
    `<p ${p}>${escapeHtml(content.firstSteps)}</p>`,
    `<p ${p}>Your public page: <a href="${publicUrl}" style="color:#1c1917;">${publicUrl}</a></p>`,
    `<p ${p}>The <a href="${guideUrl}" style="color:#1c1917;">roaster admin guide</a> walks through each part. If anything is unclear or doesn't work, just reply to this email.</p>`,
    '<p style="margin:0 0 24px;font-size:16px;line-height:1.6;">Anton<br>Timer.Coffee</p>',
    "<p style=\"margin:0;font-size:13px;line-height:1.6;color:#78716c;\">If you didn't ask for this access, reply to this email and we'll remove it.</p>",
    "</div>",
    "</div>",
    "</body>",
    "</html>",
  ].join("");
}

export function buildWelcomeEmailText(args: WelcomeEmailArgs) {
  const content = buildContent(args);

  return [
    content.greeting,
    "",
    content.intro,
    "",
    `Sign in: ${args.loginUrl}`,
    `Enter ${args.email} and we'll email you a one-time code. There's no password to set up, but always sign in with this same address.`,
    "",
    "Once you're in, you can:",
    ...content.features.map((feature) => `- ${feature.title}: ${feature.body}`),
    "",
    content.firstSteps,
    "",
    `Your public page: ${content.publicUrl}`,
    "",
    `The roaster admin guide walks through each part: ${content.guideUrl}`,
    "If anything is unclear or doesn't work, just reply to this email.",
    "",
    "Anton",
    "Timer.Coffee",
    "",
    "If you didn't ask for this access, reply to this email and we'll remove it.",
  ].join("\n");
}
