/** The relay conformance suite against the Cloudflare worker under Miniflare (real HTTP and WebSockets, the Durable
 * Object on SQLite). The same suite runs against the reference relay in src/companion/relay-conformance.test.ts. */
import { defineRelayConformance } from "../../conformance/suite.js";
import { startWorker } from "./miniflare.js";

defineRelayConformance("cloudflare worker (Miniflare)", opts => startWorker(opts));
