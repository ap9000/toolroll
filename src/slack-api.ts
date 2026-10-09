import { ChatDeliveryError } from "./chat-delivery-state.js";
import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { chatHash, type ChatIdentity } from "./chat-delivery-state.js";

/** A Slack app installation: the chat identity, with the workspace (team) it belongs to. */
export type SlackIdentity = ChatIdentity & { team: string };

export type SlackCredentials = SlackIdentity & {
  appToken: string;
  botToken: string;
};
export type SlackApi = (
  method: string,
  args?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
export class SlackError extends ChatDeliveryError {
  constructor(code: string, retryMs = 5_000, uncertain = false) {
    super(code, retryMs, uncertain);
    this.message =
      (
        {
          invalid_auth:
            "Slack access expired. Disconnect and reconnect with the current tokens.",
          not_authed: "Slack access expired. Reconnect the app.",
          token_revoked: "Slack access was revoked. Reconnect the app.",
          token_expired: "Slack access expired. Reconnect the app.",
          account_inactive: "This Slack account is no longer active.",
          missing_scope:
            "The Slack app needs additional permissions. Reinstall it with the supplied manifest.",
          no_permission:
            "Slack refused access to this conversation. Check the app permissions.",
          ratelimited: "Slack asked us to wait. Saved replies will retry.",
          channel_not_found:
            "The Slack conversation is unavailable. Pair your account again.",
          message_not_found:
            "The original Slack message was removed. Open the saved chat to recover it.",
          already_complete: "Waiting to confirm the uploaded file’s receipt.",
        } as Record<string, string>
      )[code] ?? code;
  }
}
const errors = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "missing_scope",
  "no_permission",
  "channel_not_found",
  "message_not_found",
  "ratelimited",
  "file_not_found",
  "already_complete",
  "not_in_channel",
]);
export function slackApi(
  token: string,
  fetcher: typeof fetch = fetch,
): SlackApi {
  return async (method, args = {}) => {
    if (!/^[a-zA-Z]+(?:\.[a-zA-Z]+){1,2}$/.test(method))
      throw new SlackError("Invalid Slack method");
    let response: Response;
    try {
      response = await fetcher(`https://slack.com/api/${method}`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new SlackError("Slack did not confirm delivery", 15_000, true);
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      throw new SlackError(
        "ratelimited",
        Number.isFinite(seconds) && seconds > 0
          ? Math.ceil(seconds) * 1000
          : 60_000,
      );
    }
    if (!response.ok)
      throw new SlackError("Slack is unavailable", 15_000, true);
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new SlackError(
        "Slack returned an incomplete receipt",
        15_000,
        true,
      );
    }
    if (body.ok !== true)
      throw new SlackError(
        errors.has(String(body.error))
          ? String(body.error)
          : "Slack could not complete the request",
        5_000,
        body.error === "internal_error" || body.error === "fatal_error",
      );
    return body;
  };
}
export const slackCredentialFile = (dir: string): string =>
  join(dir, "slack-connection.json");
export function loadSlackCredentials(dir: string): SlackCredentials | null {
  try {
    const value = JSON.parse(
      readFileSync(slackCredentialFile(dir), "utf8"),
    ) as SlackCredentials;
    return /^xapp-\S+$/.test(value.appToken) &&
      /^xoxb-\S+$/.test(value.botToken) &&
      [value.team, value.app, value.bot, value.installation].every(
        (v) => typeof v === "string" && v.length > 0,
      )
      ? value
      : null;
  } catch {
    return null;
  }
}
export function saveSlackCredentials(
  dir: string,
  value: SlackCredentials,
): void {
  const target = slackCredentialFile(dir),
    temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(temp, 0o600);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}
export function clearSlackCredentials(dir: string): void {
  rmSync(slackCredentialFile(dir), { force: true });
}
export async function checkSlackCredentials(
  appToken: string,
  botToken: string,
  fetcher: typeof fetch = fetch,
): Promise<SlackCredentials> {
  if (!/^xapp-\S{10,}$/.test(appToken) || !/^xoxb-\S{10,}$/.test(botToken))
    throw new SlackError(
      "Enter the app token and bot token from your Slack app",
    );
  const api = slackApi(botToken, fetcher),
    auth = await api("auth.test");
  const bot = await api("bots.info", { bot: auth.bot_id });
  const detail = object(bot.bot);
  if (
    !slackId(auth.team_id, "T") ||
    !slackId(auth.user_id, "UW") ||
    !slackId(detail.app_id, "A")
  )
    throw new SlackError("Slack did not return a workspace and bot identity");
  await slackApi(appToken, fetcher)("apps.connections.open");
  return {
    appToken,
    botToken,
    team: String(auth.team_id),
    app: String(detail.app_id),
    bot: String(auth.user_id),
    workspace: typeof auth.team === "string" ? auth.team : "Slack",
    installation: chatHash(`${auth.team_id}:${detail.app_id}:${auth.user_id}`),
  };
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function slackId(value: unknown, prefix: string): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^[${prefix}][A-Z0-9]{2,80}$`).test(value)
  );
}
export function slackTs(value: unknown): value is string {
  return typeof value === "string" && /^\d{10,16}\.\d{6}$/.test(value);
}
export async function slackMember(
  api: SlackApi,
  identity: SlackIdentity,
  member: string,
  channel: string,
): Promise<boolean> {
  const user = object((await api("users.info", { user: member })).user);
  if (
    user.id !== member ||
    user.team_id !== identity.team ||
    user.deleted === true ||
    user.is_bot === true ||
    user.is_app_user === true
  )
    return false;
  const conversation = object(
    (await api("conversations.info", { channel })).channel,
  );
  return (
    conversation.id === channel &&
    conversation.is_im === true &&
    conversation.user === member &&
    conversation.is_ext_shared !== true
  );
}
export async function uploadSlackBytes(
  url: string,
  bytes: Uint8Array,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.hostname !== "files.slack.com" ||
    target.username ||
    target.password ||
    target.port
  )
    throw new SlackError("Slack returned an invalid upload address");
  try {
    const response = await fetcher(url, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from(bytes),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error();
  } catch {
    throw new SlackError("Slack did not confirm the file upload", 15_000, true);
  }
}

/** DM scopes plus channel history for rooms that follow a team conversation. */
export const SLACK_MANIFEST = {
  display_information: {
    name: "Toolroll",
    description: "Manage your projects and review results in a private chat",
    background_color: "#142b2b",
  },
  features: {
    bot_user: { display_name: "Toolroll", always_online: false },
    app_home: {
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    },
  },
  oauth_config: {
    scopes: {
      bot: [
        "chat:write",
        "im:history",
        "im:read",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "users:read",
        "files:read",
        "files:write",
      ],
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: [
        "message.im",
        "message.channels",
        "message.groups",
        "app_uninstalled",
        "tokens_revoked",
        "user_change",
      ],
    },
    interactivity: { is_enabled: true },
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};
