// Retired (security F07/F08). This route used to accept database-webhook
// payloads from anyone and write Storage and coffee_roasters from the request
// body. Logo mirroring and dominant-colour extraction now run only in
// roaster-postprocess-worker, from canonical rows queued by the
// coffee_roasters enqueue triggers. Every request gets 410 with no side
// effects; nothing here reads the body, the environment or the database.
import { handler } from "./handler.ts";

Deno.serve((req) => handler(req, {}));
