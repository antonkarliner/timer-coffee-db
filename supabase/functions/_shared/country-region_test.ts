import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import { createCountryRegionLookup } from "./country-region.ts";
Deno.test("region cache reads shared mapping, coalesces requests and expires after one hour", async () => {
  let calls = 0;
  let time = 0;
  const lookup = createCountryRegionLookup(() => {
    calls++;
    return Promise.resolve({
      data: [{ country_code: "DE", region: calls === 1 ? "EU" : "WW" }],
      error: null,
    });
  }, () => {
    throw new Error("Unexpected warning");
  }, () => time);
  assertEquals(await Promise.all([lookup("DE"), lookup("XX")]), ["EU", "WW"]);
  assertEquals(calls, 1);
  time = 3599999;
  assertEquals(await lookup("DE"), "EU");
  time = 3600000;
  assertEquals(await lookup("DE"), "WW");
  assertEquals(calls, 2);
});
Deno.test("region database errors and thrown failures warn and fall back to WW", async () => {
  const warnings: string[] = [];
  const lookup = createCountryRegionLookup(
    () => Promise.resolve({ data: null, error: { message: "offline" } }),
    (message) => warnings.push(message),
  );
  assertEquals(await lookup("DE"), "WW");
  const thrown = createCountryRegionLookup(() => {
    throw new Error("transport");
  }, (message) => warnings.push(message));
  assertEquals(await thrown("DE"), "WW");
  assertEquals(warnings, ["offline", "transport"]);
});
Deno.test("expired region cache is not used after a failed refresh", async () => {
  let time = 0;
  const lookup = createCountryRegionLookup(
    () =>
      Promise.resolve(
        time === 0
          ? { data: [{ country_code: "DE", region: "EU" }], error: null }
          : { data: null, error: { message: "offline" } },
      ),
    () => {},
    () => time,
  );
  assertEquals(await lookup("DE"), "EU");
  time = 3600000;
  assertEquals(await lookup("DE"), "WW");
});
