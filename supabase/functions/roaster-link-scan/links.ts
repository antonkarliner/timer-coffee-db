// Which links on a roaster page the scan looks up. The description rules are
// a port of extractDescriptionUrls in the website's src/lib/link-safety.ts
// (timer-coffee-landing-2), so the scan sees the same links the save-time
// check does. Pure: no I/O, never throws.

import { isSocialPlatformHost } from "../_shared/roaster-url.ts";

/** At most this many distinct URLs are looked up per page. */
export const MAX_URLS_PER_PAGE = 10;

export type LinkField = "website_url" | "description";

export interface LinkOccurrence {
  field: LinkField;
  /**
   * The value as stored: the exact website_url, or the link as written in
   * the description (a bare `www.` token stays bare). This is what
   * service.quarantine_roaster_link matches against the column.
   */
  value: string;
}

export interface PageLink {
  /** The absolute URL looked up in Web Risk. */
  href: string;
  host: string;
  /** Every place this href appears on the page (website first). */
  occurrences: LinkOccurrence[];
}

// A link in free text starts with http(s):// anywhere, or with `www.` at the
// start of a word (not inside an email address or another URL). It runs to
// whitespace, a quote or bracket, or CJK punctuation.
const DESCRIPTION_URL_PATTERN =
  /(?:https?:\/\/|(?<![\w.@/-])www\.)[^\s<>"'`　，。、；：！？「」『』（）【】《》]+/giu;
// Sentence punctuation that usually follows a link rather than belonging to it.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}*_~»…]+$/u;

/** The http(s) links and bare `www.` links written into a description. */
export function extractDescriptionUrls(
  text: string | null | undefined,
): string[] {
  if (!text) return [];

  const urls: string[] = [];
  for (const match of text.matchAll(DESCRIPTION_URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    if (url.length > 0 && !/^(?:https?:\/\/|www\.)$/i.test(url)) {
      urls.push(url);
    }
  }
  return urls;
}

function parseHttpUrl(candidate: string): URL | null {
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Description link -> lookup URL; a bare `www.` link is looked up as https. */
export function descriptionLinkHref(link: string): URL | null {
  return parseHttpUrl(/^www\./i.test(link) ? `https://${link}` : link);
}

/** Stored website -> lookup URL; a scheme-less value is looked up as https. */
export function websiteHref(website: string): URL | null {
  const trimmed = website.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return parseHttpUrl(trimmed);
  // Any other explicit scheme (javascript:, mailto:, ...) is not a web link.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed)) return null;
  return parseHttpUrl(`https://${trimmed}`);
}

/**
 * The distinct links to look up for one page, website first: social platform
 * links are skipped, duplicates are merged (keeping every occurrence so each
 * one can be quarantined), and at most MAX_URLS_PER_PAGE are returned.
 */
export function collectPageLinks(page: {
  website_url: string | null;
  description: string | null;
}): PageLink[] {
  const byHref = new Map<string, PageLink>();

  const add = (field: LinkField, value: string, url: URL | null) => {
    if (!url) return;
    const host = url.hostname.toLowerCase();
    if (!host || isSocialPlatformHost(host)) return;
    const href = url.href;
    const existing = byHref.get(href);
    if (existing) {
      if (
        !existing.occurrences.some((o) =>
          o.field === field && o.value === value
        )
      ) {
        existing.occurrences.push({ field, value });
      }
      return;
    }
    if (byHref.size >= MAX_URLS_PER_PAGE) return;
    byHref.set(href, { href, host, occurrences: [{ field, value }] });
  };

  if (page.website_url) {
    add("website_url", page.website_url, websiteHref(page.website_url));
  }
  for (const link of extractDescriptionUrls(page.description)) {
    add("description", link, descriptionLinkHref(link));
  }
  return [...byHref.values()];
}
