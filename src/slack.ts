/** One leased Socket Mode connection, hosted by the ordinary worker. */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { SocketModeClient, LogLevel } from "@slack/socket-mode";
import { loadSlackCredentials, slackApi } from "./slack-api.js";
import { ChatState } from "./chat-delivery-state.js";
import {
  receiveSlack,
  processSlackEvent,
  deliverSlackPart,
  planSlackNotifications,
  type SlackChatOptions,
  planSlackRooms,
} from "./slack-chat.js";

/** The bot and socket tokens must belong to the same app, including after reconnect. */
export class ToolrollSlackSocket extends SocketModeClient {
  expectedApp = "";
  wrongApp: () => void = () => {};
  protected override async onWebSocketMessage(
    data: string | ArrayBuffer,
    isBinary: boolean,
  ): Promise<void> {
    let packet: Record<string, unknown>;
    try {
      packet = JSON.parse(
        typeof data === "string" ? data : new TextDecoder().decode(data),
      ) as Record<string, unknown>;
    } catch {
      return;
    }
    if (packet.type === "hello") {
      const info = packet.connection_info as { app_id?: unknown } | undefined;
      if (info?.app_id !== this.expectedApp) {
        this.wrongApp();
        await this.disconnect();
        return;
      }
    }
    return super.onWebSocketMessage(data, isBinary);
  }
}

export async function followSlack(
  options: Omit<SlackChatOptions, "identity" | "api" | "owner" | "current"> & {
    dir: string;
    signal: AbortSignal;
    notifications: () => boolean;
  },
): Promise<void> {
  const owner = randomBytes(16).toString("hex"),
    state = new ChatState(options.store, "slack");
  const pause = async (ms: number) => {
    try {
      await sleep(ms, undefined, { signal: options.signal });
    } catch {
      /* shutdown */
    }
  };
  while (!options.signal.aborted) {
    const credentials = loadSlackCredentials(options.dir);
    if (
      !credentials ||
      !state.lease(credentials.installation, owner, new Date())
    ) {
      await pause(2000);
      continue;
    }
    let alive = true,
      connected = false;
    const same = () => {
      const current = loadSlackCredentials(options.dir);
      return (
        alive &&
        !options.signal.aborted &&
        current?.installation === credentials.installation &&
        current.botToken === credentials.botToken &&
        current.appToken === credentials.appToken &&
        state.owns(credentials.installation, owner)
      );
    };
    const problem = (text: string) => state.setProblem(credentials.installation, owner, text);
    // SDK log output can include envelopes/tokens. Only fixed status phrases are saved.
    const client = new ToolrollSlackSocket({
      appToken: credentials.appToken,
      autoReconnectEnabled: true,
      clientOptions: { retryConfig: { retries: 2 }, timeout: 15_000 },
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {
          problem(
            "Slack is reconnecting. Check the app tokens if this continues.",
          );
        },
        setLevel() {},
        getLevel() {
          return LogLevel.ERROR;
        },
        setName() {},
      },
    });
    client.expectedApp = credentials.app;
    client.wrongApp = () => {
      alive = false;
      problem(
        "The app token and bot token belong to different Slack apps. Disconnect and use tokens from the same app.",
      );
    };
    const stop = () => {
      alive = false;
      void client.disconnect().catch(() => {});
    };
    options.signal.addEventListener("abort", stop, { once: true });
    const heartbeat = setInterval(() => {
      if (!same() || !state.lease(credentials.installation, owner, new Date()))
        stop();
    }, 10_000);
    client.on("connected", () => {
      connected = true;
      state.setConnected(credentials.installation, owner, new Date());
    });
    client.on("disconnected", () => {
      connected = false;
      if (alive) problem("Slack is disconnected; queued replies are saved.");
    });
    client.on("reconnecting", () => {
      connected = false;
      problem("Reconnecting to Slack…");
    });
    client.on("error", () =>
      problem("Slack connection failed. Check the app tokens and reconnect."),
    );
    client.on(
      "slack_event",
      (envelope: { type: string; body: unknown; ack: () => Promise<void> }) => {
        if (!same()) return;
        try {
          receiveSlack(
            state,
            credentials,
            envelope.type,
            envelope.body,
            new Date(),
          );
          void envelope
            .ack()
            .catch(() =>
              problem(
                "Slack acknowledgement was lost; a repeated event will be recognized.",
              ),
            );
        } catch {
          problem(
            "Slack could not save an incoming message; it has not been acknowledged.",
          );
        }
      },
    );
    const chat: SlackChatOptions = {
      ...options,
      identity: credentials,
      owner,
      api: slackApi(credentials.botToken),
      canNotify: options.notifications,
      current: same,
    };
    try {
      await client.start();
      while (same()) {
        if (!connected || state.retryAt(credentials.installation) > new Date().toISOString()) {
          await pause(1000);
          continue;
        }
        await processSlackEvent(chat);
        if (same()) await planSlackRooms(chat);
        if (same()) await deliverSlackPart(chat);
        if (same() && options.notifications())
          await planSlackNotifications(chat);
        await pause(1000);
      }
    } catch {
      if (alive) problem("Slack connection is unavailable. Retrying shortly.");
    } finally {
      clearInterval(heartbeat);
      alive = false;
      options.signal.removeEventListener("abort", stop);
      await client.disconnect().catch(() => {});
      state.stop(credentials.installation, owner);
    }
    await pause(5000);
  }
}
