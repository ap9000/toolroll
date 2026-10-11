/**
 * The Socket Mode client, apart from the follower so the Slack SDK loads only
 * once Slack is set up (slack.ts imports this when it finds credentials).
 */
import { SocketModeClient } from "@slack/socket-mode";

export { LogLevel } from "@slack/socket-mode";

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
