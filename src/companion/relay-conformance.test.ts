/** The relay conformance suite (relay/conformance/suite.ts) against the Node reference relay. The same suite runs
 * against the Cloudflare worker in relay/cloudflare/test/conformance.test.ts (`npm run relay:test`). */
import { defineRelayConformance } from "../../relay/conformance/suite.js";
import { startReferenceRelay } from "./relay-server.js";

defineRelayConformance("reference relay", async opts => {
  const relay = await startReferenceRelay({
    ...(opts.timing?.phoneFirstFrameMs !== undefined ? { phoneFirstFrameMs: opts.timing.phoneFirstFrameMs } : {}),
    ...(opts.timing?.phoneIdleMs !== undefined ? { phoneIdleMs: opts.timing.phoneIdleMs } : {}),
    ...(opts.timing?.daemonSilenceMs !== undefined ? { daemonSilenceMs: opts.timing.daemonSilenceMs } : {}),
    ...(opts.registerPerMin !== undefined ? { registerPerMin: opts.registerPerMin } : {}),
    ...(opts.connectPerMin !== undefined ? { connectPerMin: opts.connectPerMin } : {}),
    ...(opts.clientPerMin !== undefined ? { clientPerMin: opts.clientPerMin } : {}),
  });
  return {
    name: "reference",
    url: relay.url,
    wsUrl: relay.wsUrl,
    publicHost: relay.publicHost,
    timing: {
      phoneFirstFrameMs: opts.timing?.phoneFirstFrameMs ?? 10_000,
      phoneIdleMs: opts.timing?.phoneIdleMs ?? 90_000,
      daemonSilenceMs: opts.timing?.daemonSilenceMs ?? 60_000,
    },
    replayRows: async machineId => relay.replayRows(machineId) ?? 0,
    close: relay.close,
  };
});
