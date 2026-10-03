/** Discord REST requests and private installation credentials. */
import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  ChatDeliveryError,
  chatHash,
  type ChatIdentity,
} from "./chat-delivery-state.js";
import { chatObject as object } from "./chat-delivery.js";
export { object };
export const discordId = (v: unknown): v is string =>
  typeof v === "string" && /^[1-9][0-9]{16,19}$/.test(v);
export type DiscordCredentials = ChatIdentity & { botToken: string };
export type DiscordApi = (
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  body?: Record<string, unknown>,
  file?: { bytes: Uint8Array; name: string },
) => Promise<Record<string, unknown>>;
export class DiscordError extends ChatDeliveryError {}
/** Discord's 403: the bot may not do this here (for a file, no Attach Files permission). */
export const DISCORD_REFUSED = "Discord refused access. Check the app and direct-message permissions.";
export function discordApi(
  token: string,
  fetcher: typeof fetch = fetch,
): DiscordApi {
  return async (method, path, body, file) => {
    // Only relative API routes; never send the bot credential to supplied URLs.
    if (
      !/^\/(?:users\/@me|users\/[0-9]+|oauth2\/applications\/@me|channels\/[0-9]+(?:\/typing|\/messages\/[0-9]+\/reactions\/%F0%9F%91%8D\/@me|\/messages(?:\/[0-9]+)?(?:\?limit=100)?)?|interactions\/[0-9]+\/[A-Za-z0-9._-]+\/callback)$/.test(
        path,
      )
    )
      throw new DiscordError("Invalid Discord request");
    let response: Response;
    const headers: Record<string, string> = { Authorization: `Bot ${token}` };
    let payload: string | FormData | undefined;
    if (file) {
      const form = new FormData();
      form.set("payload_json", JSON.stringify(body ?? {}));
      form.set("files[0]", new Blob([Buffer.from(file.bytes)]), file.name);
      payload = form;
    } else if (body) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    try {
      response = await fetcher(`https://discord.com/api/v10${path}`, {
        method,
        headers,
        ...(payload ? { body: payload } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new DiscordError("Discord did not confirm delivery", 15_000, true);
    }
    let raw: unknown;
    try {
      raw = response.status === 204 ? {} : await response.json();
    } catch {
      throw new DiscordError(
        "Discord returned an incomplete receipt",
        15_000,
        true,
      );
    }
    const data = object(raw);
    if (response.status === 429) {
      const seconds = Number(
        data.retry_after ?? response.headers.get("retry-after"),
      );
      throw new DiscordError(
        "ratelimited",
        Number.isFinite(seconds) && seconds > 0
          ? Math.ceil(seconds * 1000)
          : 60_000,
      );
    }
    if (!response.ok) {
      const message =
        response.status === 401
          ? "Discord access expired. Disconnect and reconnect with the current bot token."
          : response.status === 403
            ? DISCORD_REFUSED
            : response.status === 404
              ? "The Discord message or conversation is unavailable. Open the saved chat."
              : response.status === 413
                ? "Discord refused this file size. Open the saved result to view the evidence."
                : "Discord could not complete the request";
      throw new DiscordError(
        message,
        response.status >= 500 ? 15_000 : 60_000,
        response.status >= 500,
      );
    }
    return Array.isArray(raw) ? { items: raw } : data;
  };
}
export const discordCredentialFile = (dir: string) =>
  join(dir, "discord-connection.json");
export function loadDiscordCredentials(dir: string): DiscordCredentials | null {
  try {
    const v = JSON.parse(
      readFileSync(discordCredentialFile(dir), "utf8"),
    ) as DiscordCredentials;
    return validToken(v.botToken) &&
      discordId(v.app) &&
      discordId(v.bot) &&
      typeof v.workspace === "string" &&
      v.installation === chatHash(`discord:${v.app}:${v.bot}`)
      ? v
      : null;
  } catch {
    return null;
  }
}
const validToken = (token: unknown): token is string =>
  typeof token === "string" && /^[A-Za-z0-9._-]{30,300}$/.test(token);
export function saveDiscordCredentials(
  dir: string,
  value: DiscordCredentials,
): void {
  const target = discordCredentialFile(dir),
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
export function clearDiscordCredentials(dir: string): void {
  rmSync(discordCredentialFile(dir), { force: true });
}
export async function checkDiscordCredentials(
  botToken: string,
  fetcher: typeof fetch = fetch,
): Promise<DiscordCredentials> {
  if (!validToken(botToken))
    throw new DiscordError("Enter the bot token from your Discord application");
  const api = discordApi(botToken, fetcher),
    user = await api("GET", "/users/@me"),
    app = await api("GET", "/oauth2/applications/@me");
  if (
    !discordId(user.id) ||
    user.bot !== true ||
    !discordId(app.id) ||
    (app.bot !== undefined && object(app.bot).id !== user.id)
  )
    throw new DiscordError("Discord did not confirm the app and bot identity");
  if (
    typeof app.interactions_endpoint_url === "string" &&
    app.interactions_endpoint_url
  )
    throw new DiscordError(
      "Clear the app’s Interactions Endpoint URL in Discord so buttons can reach this installation.",
    );
  return {
    botToken,
    app: app.id,
    bot: user.id,
    workspace: typeof app.name === "string" ? app.name : "Toolroll",
    installation: chatHash(`discord:${app.id}:${user.id}`),
  };
}
export async function discordMember(
  api: DiscordApi,
  member: string,
  channel: string,
): Promise<boolean> {
  if (!discordId(member) || !discordId(channel)) return false;
  const user = await api("GET", `/users/${member}`),
    dm = await api("GET", `/channels/${channel}`);
  const recipients = Array.isArray(dm.recipients)
    ? dm.recipients.map(object)
    : [];
  return (
    user.id === member &&
    user.bot !== true &&
    user.system !== true &&
    dm.id === channel &&
    dm.type === 1 &&
    recipients.length === 1 &&
    recipients[0]?.id === member
  );
}
