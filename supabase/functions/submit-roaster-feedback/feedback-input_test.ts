import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  CLAIM_ROLES,
  CLAIM_SOURCES,
  emailDomainMatchesWebsite,
  parseClaimInput,
  parseProfileRef,
  parseReportInput,
  REPORT_CATEGORIES,
} from "./feedback-input.ts";

function okReport(result: ReturnType<typeof parseReportInput>) {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}

function okClaim(result: ReturnType<typeof parseClaimInput>) {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}

function rejected(
  result:
    | ReturnType<typeof parseReportInput>
    | ReturnType<typeof parseClaimInput>,
): { status: number; error: string } {
  if (result.ok) throw new Error("expected rejection");
  return result;
}

// ─── parseReportInput ────────────────────────────────────────────────────────

Deno.test("accepts a full report from the web path", () => {
  const value = okReport(parseReportInput({
    category: "wrong_location",
    suggestedValue: "  Berlin  ",
    details: "  The map pin is in the wrong district.  ",
    contactEmail: "Owner@Example.COM",
  }, { allowContactEmail: true }));
  assertEquals(value.category, "wrong_location");
  assertEquals(value.suggested_value, "Berlin");
  assertEquals(value.details, "The map pin is in the wrong district.");
  assertEquals(value.contact_email, "owner@example.com");
});

Deno.test("accepts a minimal report with absent fields", () => {
  const value = okReport(parseReportInput({ category: "closed" }, {
    allowContactEmail: true,
  }));
  assertEquals(value.category, "closed");
  assertEquals(value.suggested_value, null);
  assertEquals(value.details, null);
  assertEquals(value.contact_email, null);
});

Deno.test("maps empty strings to null", () => {
  const value = okReport(parseReportInput({
    category: "closed",
    suggestedValue: "   ",
    details: "",
    contactEmail: "",
  }, { allowContactEmail: true }));
  assertEquals(value.suggested_value, null);
  assertEquals(value.details, null);
  assertEquals(value.contact_email, null);
});

Deno.test("ignores non-string optional fields instead of failing", () => {
  const value = okReport(parseReportInput({
    category: "duplicate",
    suggestedValue: 42,
    details: { text: "nope" },
  }, { allowContactEmail: true }));
  assertEquals(value.suggested_value, null);
  assertEquals(value.details, null);
});

Deno.test("rejects an unknown or missing category", () => {
  for (const body of [{}, { category: "wrong_price" }, { category: 7 }]) {
    const result = rejected(parseReportInput(body, {
      allowContactEmail: true,
    }));
    assertEquals(result.status, 400);
    assertEquals(result.error, "Missing or invalid category");
  }
});

Deno.test("accepts every listed category", () => {
  for (const category of REPORT_CATEGORIES) {
    const value = okReport(parseReportInput(
      category === "other" ? { category, details: "explain" } : { category },
      { allowContactEmail: false },
    ));
    assertEquals(value.category, category);
  }
});

Deno.test("rejects an over-long suggestedValue without truncating", () => {
  const result = rejected(parseReportInput({
    category: "wrong_name",
    suggestedValue: "R".repeat(501),
  }, { allowContactEmail: false }));
  assertEquals(result.status, 400);
  assertEquals(result.error, "suggestedValue must be at most 500 characters");
});

Deno.test("accepts a suggestedValue of exactly 500 characters", () => {
  const value = okReport(parseReportInput({
    category: "wrong_name",
    suggestedValue: "R".repeat(500),
  }, { allowContactEmail: false }));
  assertEquals(value.suggested_value, "R".repeat(500));
});

Deno.test("rejects over-long details without truncating", () => {
  const result = rejected(parseReportInput({
    category: "wrong_name",
    details: "D".repeat(1001),
  }, { allowContactEmail: false }));
  assertEquals(result.status, 400);
  assertEquals(result.error, "details must be at most 1000 characters");
});

Deno.test("accepts details of exactly 1000 characters", () => {
  const value = okReport(parseReportInput({
    category: "wrong_name",
    details: "D".repeat(1000),
  }, { allowContactEmail: false }));
  assertEquals(value.details, "D".repeat(1000));
});

Deno.test("category other requires non-empty details", () => {
  for (
    const body of [
      { category: "other" },
      { category: "other", details: "   " },
      { category: "other", details: "" },
    ]
  ) {
    const result = rejected(parseReportInput(body, {
      allowContactEmail: false,
    }));
    assertEquals(result.status, 400);
    assertEquals(result.error, "details are required when category is other");
  }
  const value = okReport(parseReportInput({
    category: "other",
    details: "It is a cafe, not a roastery.",
  }, { allowContactEmail: false }));
  assertEquals(value.details, "It is a cafe, not a roastery.");
});

Deno.test("ignores contactEmail on the app path", () => {
  const value = okReport(parseReportInput({
    category: "closed",
    contactEmail: "owner@example.com",
  }, { allowContactEmail: false }));
  assertEquals(value.contact_email, null);
});

Deno.test("ignores even a malformed contactEmail on the app path", () => {
  const value = okReport(parseReportInput({
    category: "closed",
    contactEmail: "not-an-email",
  }, { allowContactEmail: false }));
  assertEquals(value.contact_email, null);
});

Deno.test("rejects a malformed contactEmail on the web path", () => {
  const result = rejected(parseReportInput({
    category: "closed",
    contactEmail: "not-an-email",
  }, { allowContactEmail: true }));
  assertEquals(result.status, 400);
  assertEquals(result.error, "Invalid contactEmail");
});

Deno.test("rejects an over-long contactEmail on the web path", () => {
  const result = rejected(parseReportInput({
    category: "closed",
    contactEmail: `a@${"b".repeat(250)}.com`,
  }, { allowContactEmail: true }));
  assertEquals(result.status, 400);
  assertEquals(result.error, "Invalid contactEmail");
});

Deno.test("trims and lowercases a valid contactEmail", () => {
  const value = okReport(parseReportInput({
    category: "closed",
    contactEmail: "  OWNER@Roastery.COFFEE ",
  }, { allowContactEmail: true }));
  assertEquals(value.contact_email, "owner@roastery.coffee");
});

// ─── parseClaimInput ─────────────────────────────────────────────────────────

function validClaimBody(): Record<string, unknown> {
  return {
    authorized: true,
    email: " Owner@Roastery.COM ",
    fullName: "  Ada Lovelace  ",
    role: "owner",
    message: "  We roast since 2014.  ",
  };
}

Deno.test("accepts a valid claim", () => {
  const value = okClaim(parseClaimInput(validClaimBody()));
  assertEquals(value.email, "owner@roastery.com");
  assertEquals(value.full_name, "Ada Lovelace");
  assertEquals(value.role, "owner");
  assertEquals(value.message, "We roast since 2014.");
  assertEquals(value.source, "web");
});

Deno.test("defaults source to web and keeps a known source", () => {
  for (
    const [raw, expected] of [
      [undefined, "web"],
      ["", "web"],
      ["pigeon", "web"],
      [42, "web"],
      ["app", "app"],
      ["email", "email"],
      ["web", "web"],
    ] as const
  ) {
    const body = validClaimBody();
    if (raw === undefined) delete body.source;
    else body.source = raw;
    const value = okClaim(parseClaimInput(body));
    assertEquals(value.source, expected);
  }
});

Deno.test("requires authorized to be exactly the boolean true", () => {
  for (const authorized of [undefined, false, "true", 1, null]) {
    const body = validClaimBody();
    if (authorized === undefined) delete body.authorized;
    else body.authorized = authorized;
    const result = rejected(parseClaimInput(body));
    assertEquals(result.status, 400);
    assertEquals(result.error, "authorization confirmation required");
  }
});

Deno.test("rejects a missing, blank, or invalid email", () => {
  for (
    const email of [undefined, "", "   ", "roastery.com", "a b@roastery.com", 7]
  ) {
    const body = validClaimBody();
    if (email === undefined) delete body.email;
    else body.email = email;
    const result = rejected(parseClaimInput(body));
    assertEquals(result.status, 400);
  }
});

Deno.test("rejects an email longer than 254 characters", () => {
  const body = validClaimBody();
  body.email = `a@${"b".repeat(250)}.com`;
  const result = rejected(parseClaimInput(body));
  assertEquals(result.status, 400);
  assertEquals(result.error, "Invalid email");
});

Deno.test("trims and lowercases a valid email", () => {
  const body = validClaimBody();
  body.email = "  INFO@MAIL.Roastery.COM ";
  const value = okClaim(parseClaimInput(body));
  assertEquals(value.email, "info@mail.roastery.com");
});

Deno.test("rejects a missing, blank, or over-long fullName", () => {
  for (const fullName of [undefined, "", "   ", "N".repeat(121), 9]) {
    const body = validClaimBody();
    if (fullName === undefined) delete body.fullName;
    else body.fullName = fullName;
    const result = rejected(parseClaimInput(body));
    assertEquals(result.status, 400);
  }
  const body = validClaimBody();
  body.fullName = "N".repeat(120);
  assertEquals(okClaim(parseClaimInput(body)).full_name, "N".repeat(120));
});

Deno.test("rejects a missing or unknown role", () => {
  for (const role of [undefined, "", "manager", "Owner", 3]) {
    const body = validClaimBody();
    if (role === undefined) delete body.role;
    else body.role = role;
    const result = rejected(parseClaimInput(body));
    assertEquals(result.status, 400);
    assertEquals(result.error, "Missing or invalid role");
  }
  for (const role of CLAIM_ROLES) {
    const body = validClaimBody();
    body.role = role;
    assertEquals(okClaim(parseClaimInput(body)).role, role);
  }
});

Deno.test("maps an empty message to null and rejects an over-long one", () => {
  for (const message of [undefined, "", "   "]) {
    const body = validClaimBody();
    if (message === undefined) delete body.message;
    else body.message = message;
    assertEquals(okClaim(parseClaimInput(body)).message, null);
  }
  const tooLong = validClaimBody();
  tooLong.message = "M".repeat(1001);
  const result = rejected(parseClaimInput(tooLong));
  assertEquals(result.status, 400);
  assertEquals(result.error, "message must be at most 1000 characters");
  const atLimit = validClaimBody();
  atLimit.message = "M".repeat(1000);
  assertEquals(okClaim(parseClaimInput(atLimit)).message, "M".repeat(1000));
});

// ─── parseProfileRef ─────────────────────────────────────────────────────────

Deno.test("accepts a UUID roasterProfileId", () => {
  const ref = parseProfileRef({
    roasterProfileId: "123e4567-e89b-12d3-a456-426614174000",
  });
  assertEquals(ref, {
    roasterProfileId: "123e4567-e89b-12d3-a456-426614174000",
  });
  assertEquals(
    parseProfileRef({
      roasterProfileId: "123E4567-E89B-12D3-A456-426614174000",
    }),
    { roasterProfileId: "123E4567-E89B-12D3-A456-426614174000" },
  );
});

Deno.test("accepts a slug, including a numeric one", () => {
  assertEquals(parseProfileRef({ slug: "loom-coffee" }), {
    slug: "loom-coffee",
  });
  assertEquals(parseProfileRef({ slug: "2376" }), { slug: "2376" });
  assertEquals(parseProfileRef({ slug: "  bonanza-coffee  " }), {
    slug: "bonanza-coffee",
  });
});

Deno.test("accepts a slug of exactly 100 characters", () => {
  const slug = "a".repeat(100);
  assertEquals(parseProfileRef({ slug }), { slug });
});

Deno.test("returns null for junk profile references", () => {
  for (
    const body of [
      {},
      { slug: "has spaces" },
      { slug: "" },
      { slug: "under_score" },
      { slug: "s".repeat(101) },
      { slug: 42 },
      { roasterProfileId: "not-a-uuid" },
      { roasterProfileId: "" },
      { roasterProfileId: 42 },
      { slug: "valid-slug", roasterProfileId: "malformed id" },
    ]
  ) {
    assertEquals(parseProfileRef(body), null, JSON.stringify(body));
  }
});

// ─── emailDomainMatchesWebsite ───────────────────────────────────────────────

Deno.test("matches an exact domain", () => {
  assertEquals(
    emailDomainMatchesWebsite("owner@roastery.com", "https://roastery.com"),
    true,
  );
});

Deno.test("strips www from the website host", () => {
  assertEquals(
    emailDomainMatchesWebsite("owner@roastery.com", "https://www.roastery.com"),
    true,
  );
});

Deno.test("matches a website subdomain against the email domain", () => {
  assertEquals(
    emailDomainMatchesWebsite(
      "owner@roastery.com",
      "https://shop.roastery.com/menu",
    ),
    true,
  );
});

Deno.test("matches a mail subdomain in the email against the website", () => {
  assertEquals(
    emailDomainMatchesWebsite("info@mail.roastery.com", "https://roastery.com"),
    true,
  );
});

Deno.test("rejects free-mail domains", () => {
  for (const domain of ["gmail.com", "proton.me", "gmx.de", "yahoo.com"]) {
    assertEquals(
      emailDomainMatchesWebsite(`owner@${domain}`, "https://roastery.com"),
      false,
      domain,
    );
  }
  assertEquals(
    emailDomainMatchesWebsite("owner@gmail.com", "https://gmail.com"),
    false,
  );
});

Deno.test("rejects platform hosts, including myshopify subdomains", () => {
  for (
    const website of [
      "https://my-store.myshopify.com",
      "https://deep.sub.myshopify.com",
      "https://myshopify.com",
      "https://www.shopify.com",
      "https://linktr.ee/roastery",
      "https://roastery.wixsite.com/home",
      "https://roastery.bigcartel.com",
    ]
  ) {
    assertEquals(
      emailDomainMatchesWebsite("owner@my-store.com", website),
      false,
      website,
    );
  }
});

Deno.test("rejects a null or garbage website", () => {
  assertEquals(emailDomainMatchesWebsite("owner@roastery.com", null), false);
  assertEquals(
    emailDomainMatchesWebsite("owner@roastery.com", "not a url"),
    false,
  );
  assertEquals(emailDomainMatchesWebsite("owner@roastery.com", ""), false);
});

Deno.test("accepts a scheme-less website", () => {
  assertEquals(
    emailDomainMatchesWebsite("owner@roastery.com", "roastery.com"),
    true,
  );
  assertEquals(
    emailDomainMatchesWebsite("owner@roastery.com", "www.roastery.com/shop"),
    true,
  );
});

Deno.test("is case-insensitive on both sides", () => {
  assertEquals(
    emailDomainMatchesWebsite(
      "Owner@ROASTERY.Com",
      "HTTPS://WWW.Roastery.COM/Shop",
    ),
    true,
  );
});

Deno.test("does not match a look-alike domain", () => {
  assertEquals(
    emailDomainMatchesWebsite("owner@evilroastery.com", "https://roastery.com"),
    false,
  );
  assertEquals(
    emailDomainMatchesWebsite("owner@roastery.com", "https://evilroastery.com"),
    false,
  );
  assertEquals(
    emailDomainMatchesWebsite(
      "owner@notroastery.com",
      "https://sub.roastery.com",
    ),
    false,
  );
});
