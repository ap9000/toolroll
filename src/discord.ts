/** A single leased Discord Gateway connection, hosted by the ordinary worker. */
import { randomBytes } from "node:crypto";
import { abortablePause, workChatQueue } from "./chat-follow.js";
import {
  loadDiscordCredentials,
  discordApi,
  object,
  discordId,
} from "./discord-api.js";
import { ChatState, chatHash } from "./chat-delivery-state.js";
import type { DiscordGatewayError } from "./discord-gateway.js";
import { runChatAcks } from "./chat-live.js";
import {
  receiveDiscord,
  processDiscordEvent,
  deliverDiscordPart,
  planDiscordNotifications,
  type DiscordChatOptions,
  planDiscordRooms,
  discordAckHooks,
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
  const pause = abortablePause(options.signal);
  // A close Discord says must not be retried (a rejected token, a refused intent): wait for new credentials, or for a
  // while, instead of reconnecting into the same refusal every few seconds.
  const refusal: { token: string; until: number } = { token: "", until: 0 }; // token: a hash, never the token
  while (!options.signal.aborted) {
    const credentials = loadDiscordCredentials(options.dir);
    if (refusal.token !== "" && chatHash(credentials?.botToken ?? "") === refusal.token && Date.now() < refusal.until) {
      await pause(2000);
      continue;
    }
    refusal.token = "";
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
    // The gateway client (and ws) load once Discord is set up, not with every command that could host the follower.
    // It asks for direct messages, guild messages and their content (rooms need them); the Message Content intent
    // must be enabled for the app in Discord's developer portal.
    const { DiscordGateway } = await import("./discord-gateway.js");
    const client = new DiscordGateway();
    const refuse = (error: DiscordGatewayError) => {
      // A rejected token waits for a different one; any other refusal is tried again in ten minutes.
      refusal.token = chatHash(credentials.botToken);
      refusal.until = error.code === 4004 ? Infinity : Date.now() + 600_000;
      problem(error.message);
    };
    const fatal = (error: unknown): error is DiscordGatewayError =>
      error instanceof Error && error.name === "DiscordGatewayError" && (error as DiscordGatewayError).fatal;
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
    client.on("error", (error: unknown) => {
      // A gateway notice (a daily limit, a wait Discord asked for) says what is happening; anything else is generic.
      if (!fatal(error))
        return problem(error instanceof Error && error.name === "DiscordGatewayError" ? error.message : "Discord connection failed. Check the bot token and reconnect.");
      refuse(error);
      stop();
    });
    // The 👀 on each owner message as it arrives, beside the queue (a turn there can take a minute).
    const acks = runChatAcks({ state, installation: credentials.installation, owner, current: () => same() && connected,
      hooks: discordAckHooks({ api }), same, signal: options.signal });
    // Never subscribe a logger to raw payloads or interaction tokens.
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
        if (saved && packet.t === "MESSAGE_CREATE") acks.wake();
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
      liveReplies: true,
    };
    try {
      await client.login(credentials.botToken);
      await workChatQueue({
        same,
        ready: () => connected && !(state.retryAt(credentials.installation) > new Date().toISOString()),
        pause,
        notifications: () => options.notifications(),
        process: () => processDiscordEvent(chat),
        rooms: () => planDiscordRooms(chat),
        deliver: () => deliverDiscordPart(chat),
        notify: () => planDiscordNotifications(chat),
      });
    } catch (error) {
      if (alive && fatal(error)) refuse(error);
      else if (alive) problem("Discord is unavailable. Retrying shortly.");
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
