import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import { handler } from "./handler.ts";

for (const method of ["POST", "GET", "OPTIONS"]) {
  Deno.test(`retired endpoint: ${method}`, async () => {
    const req = new Request("https://example.com", {
      method,
      body: method === "POST" ? "invalid JSON" : undefined,
    });
    const response = handler(req, {
      "Access-Control-Allow-Origin": "https://example.com",
    });
    assertEquals(response.status, method === "OPTIONS" ? 200 : 410);
    assertEquals(
      response.headers.get("Access-Control-Allow-Origin"),
      "https://example.com",
    );
    assertEquals(req.bodyUsed, false);
    if (method !== "OPTIONS") {
      assertEquals(response.headers.get("Content-Type"), "application/json");
      assertEquals(await response.json(), {
        error:
          "This endpoint is retired. Logo mirroring and dominant-colour extraction run in roaster-postprocess-worker.",
      });
    }
  });
}
