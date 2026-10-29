// Email content for the link scan. Only the host of a flagged link is ever
// written into an email (never the full URL): a full URL can carry personal
// data, and a clickable unsafe link is exactly what we are hiding.

import type { LinkField } from "./links.ts";

/** Same sender as the other roaster operator emails (check-new-roaster). */
export const ADMIN_EMAIL_FROM = "roasters@timer.coffee";
/** Same sender and reply-to as the roaster-facing claim confirmation. */
export const ROASTER_EMAIL_FROM = "Timer.Coffee <roasters@timer.coffee>";
export const SUPPORT_EMAIL = "support@timer.coffee";
export const ROASTER_ADMIN_URL = "https://www.timer.coffee/roaster-admin/";

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
}

export interface QuarantinedLink {
  roasterProfileId: string;
  roasterName: string | null;
  slug: string | null;
  field: LinkField;
  host: string;
  threatTypes: string[];
}

const FIELD_LABELS: Record<LinkField, string> = {
  website_url: "Website",
  description: "Description",
};

const THREAT_DESCRIPTIONS: Record<string, string> = {
  MALWARE: "malware",
  SOCIAL_ENGINEERING: "phishing or deceptive content",
  UNWANTED_SOFTWARE: "unwanted software",
};

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function describeThreats(threatTypes: string[]): string {
  const described = [
    ...new Set(
      threatTypes.map((type) => THREAT_DESCRIPTIONS[type] ?? "unsafe content"),
    ),
  ];
  return described.length > 0 ? described.join(", ") : "unsafe content";
}

function pageLabel(link: QuarantinedLink): string {
  const name = link.roasterName?.trim() || link.slug ||
    link.roasterProfileId;
  return link.slug && name !== link.slug ? `${name} (${link.slug})` : name;
}

export function buildAdminSummaryEmail(
  to: string,
  links: QuarantinedLink[],
): EmailMessage {
  const count = links.length;
  const lines = links.map((link) =>
    `${pageLabel(link)} | ${FIELD_LABELS[link.field]} | ${link.host} | ${
      link.threatTypes.join(", ")
    } | hidden`
  );
  const items = links.map((link) =>
    `<li><strong>${escapeHtml(pageLabel(link))}</strong><br>Field: ${
      escapeHtml(FIELD_LABELS[link.field])
    }<br>Host: ${escapeHtml(link.host)}<br>Threat types: ${
      escapeHtml(link.threatTypes.join(", "))
    }<br>The link was hidden from the page${
      link.field === "description" ? " (the whole description is hidden)" : ""
    }.</li>`
  );
  const intro = `The daily roaster link scan found ${count} link${
    count === 1 ? "" : "s"
  } listed by Google Web Risk and hid ${
    count === 1 ? "it" : "them"
  }. The original values are in service.roaster_link_flags; restore one there if a flag is a false positive.`;
  return {
    from: ADMIN_EMAIL_FROM,
    to,
    subject: `Roaster link scan: ${count} unsafe link${
      count === 1 ? "" : "s"
    } hidden`,
    text: [intro, "", ...lines].join("\n"),
    html: `<p>${escapeHtml(intro)}</p><ul>${items.join("")}</ul>`,
  };
}

export function buildRoasterEmail(
  to: string,
  links: QuarantinedLink[],
): EmailMessage {
  const name = links[0]?.roasterName?.trim() || "your roaster";
  const several = links.length > 1;
  const hidDescription = links.some((link) => link.field === "description");

  const entries = links.map((link) =>
    `${FIELD_LABELS[link.field]}: a link to ${link.host}, listed as ${
      describeThreats(link.threatTypes)
    }`
  );
  const intro =
    `Our daily safety check looks up the links on Timer.Coffee roaster pages with Google Web Risk. It listed ${
      several ? "these links" : "this link"
    } on the page for ${name} as unsafe, so we hid ${
      several ? "them" : "it"
    } from the page for now:`;
  const descriptionNote = hidDescription
    ? "Because a flagged link was in your description, the whole description is hidden until you save it again."
    : null;
  const fix =
    `To fix this, sign in at ${ROASTER_ADMIN_URL} and save your page details with a different link (or without it). The rest of your page stays visible.`;
  const mistake =
    `If you think this is a mistake, reply to this email or write to ${SUPPORT_EMAIL}.`;

  const text = [
    "Hi,",
    "",
    intro,
    "",
    ...entries.map((entry) => `- ${entry}`),
    "",
    ...(descriptionNote ? [descriptionNote, ""] : []),
    fix,
    "",
    mistake,
    "",
    "Timer.Coffee",
  ].join("\n");

  const html = `<p>Hi,</p><p>${escapeHtml(intro)}</p><ul>${
    entries.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")
  }</ul>${
    descriptionNote ? `<p>${escapeHtml(descriptionNote)}</p>` : ""
  }<p>To fix this, sign in at <a href="${ROASTER_ADMIN_URL}">${ROASTER_ADMIN_URL}</a> and save your page details with a different link (or without it). The rest of your page stays visible.</p><p>If you think this is a mistake, reply to this email or write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p><p>Timer.Coffee</p>`;

  return {
    from: ROASTER_EMAIL_FROM,
    to,
    reply_to: SUPPORT_EMAIL,
    subject: several
      ? "Links on your Timer.Coffee page were hidden"
      : "A link on your Timer.Coffee page was hidden",
    text,
    html,
  };
}
