import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveCardInstagram,
  validatePayloadUrls,
  verifyRoasterInstagram,
} from "./roaster-instagram.mjs";

const account = "https://www.instagram.com/TimerCoffee/";

const resolutionCases = [
  {
    name: "proposed-only Instagram",
    input: { proposed: { instagram_url: account } },
    expected: { instagram_url: account, conflict: null },
  },
  {
    name: "contribution-only Instagram",
    input: { contributions: [{ instagram_url: account }] },
    expected: { instagram_url: account, conflict: null },
  },
  {
    name:
      "agreeing sources compare accounts case-insensitively and remove tracking",
    input: {
      proposed: {
        instagram_url: "https://instagram.com/TimerCoffee/?igsh=abc",
      },
      contributions: [{
        instagram_url: "https://www.instagram.com/timercoffee/",
      }],
    },
    expected: { instagram_url: account, conflict: null },
  },
  {
    name: "proposed and contribution conflict",
    input: {
      proposed: { instagram_url: "https://instagram.com/one/" },
      contributions: [{ instagram_url: "https://instagram.com/two/" }],
    },
    expected: { instagram_url: null, conflict: "instagram_account_conflict" },
  },
  {
    name: "existing profile disagrees with proposed and contribution",
    input: {
      proposed: { instagram_url: "https://instagram.com/one/" },
      contributions: [{ instagram_url: "https://instagram.com/ONE/" }],
      existingProfile: { instagram_url: "https://instagram.com/two/" },
    },
    expected: { instagram_url: null, conflict: "instagram_account_conflict" },
  },
  {
    name: "Instagram post anywhere is rejected",
    input: {
      proposed: { instagram_url: account },
      contributions: [{ website_url: "https://instagram.com/p/abc123/" }],
    },
    expected: { instagram_url: null, conflict: "invalid_instagram_source" },
  },
  {
    name: "no Instagram anywhere",
    input: { proposed: { roaster_website_url: "https://timer.coffee/" } },
    expected: { instagram_url: null, conflict: null },
  },
];

for (const item of resolutionCases) {
  test(item.name, () => {
    const actual = resolveCardInstagram(item.input);
    assert.equal(actual.instagram_url, item.expected.instagram_url);
    assert.equal(actual.conflict, item.expected.conflict);
  });
}

test("conflict notes name every account and source", () => {
  const result = resolveCardInstagram(resolutionCases[3].input);
  assert.match(result.notes.join(" "), /@one from LLM proposed/);
  assert.match(
    result.notes.join(" "),
    /@two from user-submitted contribution 1/,
  );
});

const validationCases = [
  ["Instagram host in website field", {
    roaster_website_url: "https://instagram.com/timercoffee/",
  }, 1],
  ["non-canonical Instagram URL", {
    instagram_url: "https://instagram.com/timercoffee/?igsh=x",
  }, 1],
  ["empty payload", {}, 1],
  ["clean website-only payload", {
    roaster_website_url: "https://timer.coffee/",
  }, 0],
];

for (const [name, payload, issueCount] of validationCases) {
  test(`validatePayloadUrls: ${name}`, () => {
    assert.equal(validatePayloadUrls(payload).length, issueCount);
  });
}

const verificationCases = [
  [
    "match",
    { roaster_website_url: "https://timer.coffee/", instagram_url: account },
    account,
    true,
  ],
  [
    "mismatch",
    {
      roaster_website_url: "https://timer.coffee/",
      instagram_url: "https://www.instagram.com/other/",
    },
    account,
    false,
  ],
  [
    "null/null pair",
    { roaster_website_url: "https://timer.coffee/", instagram_url: null },
    null,
    true,
  ],
  [
    "Instagram survived in website column",
    { roaster_website_url: account, instagram_url: account },
    account,
    false,
  ],
];

for (const [name, row, expected, ok] of verificationCases) {
  test(`verifyRoasterInstagram: ${name}`, () => {
    assert.equal(verifyRoasterInstagram(row, expected).ok, ok);
  });
}
