/** A single leased Discord Gateway connection, hosted by the ordinary worker. */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import {
  loadDiscordCredentials,
  discordApi,
  object,
  discordId,
} from "./discord-api.js";
import { ChatState, chatHash } from "./chat-delivery-state.js";
import {
  receiveDiscord,
  processDiscordEvent,
  deliverDiscordPart,
  planDiscordNotifications,
  type DiscordChatOptions,
  planDiscordRooms,
} from "./discord-chat.js";
export function discordReadyMatches(
  raw: unknown,
  identity: { app: string; bot: string },
): boolean {
  const packet = object(raw);
  return (
    object(packet.application).id === identity.app &&
    object(packet.user).id === identity.bot &&
    object(packet.user).bot === true
  );
}
export async function followDiscord(
  options: Omit<
    DiscordChatOptions,
    "identity" | "api" | "owner" | "current"
  > & { dir: string; signal: AbortSignal; notifications: () => boolean },
): Promise<void> {
  const owner = randomBytes(16).toString("hex"),
    state = new ChatState(options.store, "discord");
  const pause = async (ms: number) => {
    try {
      await sleep(ms, undefined, { signal: options.signal });
    } catch {
      /* shutdown */
    }
  };
  while (!options.signal.aborted) {
    const credentials = loadDiscordCredentials(options.dir);
    if (
      !credentials ||
      !state.lease(credentials.installation, owner, new Date())
    ) {
      await pause(2000);
      continue;
    }
    let alive = true,
      connected = false,
      validated = false;
    const same = () => {
      const current = loadDiscordCredentials(options.dir);
      return (
        alive &&
        !options.signal.aborted &&
        current?.installation === credentials.installation &&
        current.botToken === credentials.botToken &&
        state.owns(credentials.installation, owner)
      );
    };
    const problem = (message: string) => state.setProblem(credentials.installation, owner, message);
    const api = discordApi(credentials.botToken);
    const client = new Client({
      // Guild messages and their content are needed for rooms; the Message
      // Content intent must be enabled for the app in Discord's developer portal.
      intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel],
      allowedMentions: { parse: [], repliedUser: false },
      rest: { timeout: 15_000, retries: 2 },
    });
    const stop = () => {
      alive = false;
      connected = false;
      void client.destroy().catch(() => {});
    };
    options.signal.addEventListener("abort", stop, { once: true });
    const heartbeat = setInterval(() => {
      if (!same() || !state.lease(credentials.installation, owner, new Date()))
        stop();
    }, 10_000);
    const online = () => {
      if (!same() || !validated) return;
      connected = true;
      state.setConnected(credentials.installation, owner, new Date());
    };
    client.on("shardReady", online);
    client.on("shardResume", online);
    client.on("shardDisconnect", () => {
      connected = false;
      problem("Discord is disconnected; saved replies will retry.");
    });
    client.on("shardReconnecting", () => {
      connected = false;
      problem("Reconnecting to Discord…");
    });
    client.on("error", () =>
      problem("Discord connection failed. Check the bot token and reconnect."),
    );
    client.on("shardError", () =>
      problem("Discord connection failed. Saved replies will retry."),
    );
    // Never subscribe a logger to raw payloads, SDK debug output or interaction tokens.
    client.on("raw", (packet: { t: string; d: unknown }) => {
      if (!same()) return;
      if (packet.t === "READY") {
        validated = discordReadyMatches(packet.d, credentials);
        if (!validated) {
          problem(
            "Discord returned a different app identity. Disconnect and reconnect the intended app.",
          );
          stop();
        } else online();
        return;
      }
      if (!validated) return;
      const body = object(packet.d);
      try {
        const saved = receiveDiscord(
          state,
          credentials,
          packet.t,
          body,
          new Date(),
        );
        if (
          packet.t === "INTERACTION_CREATE" &&
          body.type === 3 &&
          body.application_id === credentials.app &&
          discordId(body.id) &&
          typeof body.token === "string" &&
          /^[A-Za-z0-9._-]{1,300}$/.test(body.token)
        ) {
          const repeated =
            state.event(
              chatHash(`${credentials.installation}:interaction:${body.id}`),
            ) !== null;
          // Immediate acknowledgement; model work and approvals are handled from the durable queue.
          void api(
            "POST",
            `/interactions/${body.id}/${body.token}/callback`,
            saved || repeated
              ? { type: 6 }
              : {
                  type: 4,
                  data: {
                    content:
                      "This button is unavailable. Use your paired direct message or ask for the current state.",
                    flags: 64,
                    allowed_mentions: { parse: [] },
                  },
                },
          ).catch(() =>
            problem(
              "Discord did not acknowledge the button. Its saved result will appear in the conversation.",
            ),
          );
        }
      } catch {
        problem(
          "An incoming Discord message could not be saved. Send it again after reconnecting.",
        );
      }
    });
    const chat: DiscordChatOptions = {
      ...options,
      identity: credentials,
      owner,
      api,
      current: same,
      canNotify: options.notifications,
    };
    try {
      await client.login(credentials.botToken);
      while (same()) {
        if (!connected || state.retryAt(credentials.installation) > new Date().toISOString()) {
          await pause(1000);
          continue;
        }
        await processDiscordEvent(chat);
        if (same()) await planDiscordRooms(chat);
        if (same()) await deliverDiscordPart(chat);
        if (same() && options.notifications())
          await planDiscordNotifications(chat);
        await pause(1000);
      }
    } catch {
      if (alive) problem("Discord is unavailable. Retrying shortly.");
    } finally {
      clearInterval(heartbeat);
      alive = false;
      options.signal.removeEventListener("abort", stop);
      await client.destroy().catch(() => {});
      state.stop(credentials.installation, owner);
    }
    await pause(5000);
  }
}
