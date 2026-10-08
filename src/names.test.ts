/**
 * The rename to Toolroll: new names first, older ones still found. Every
 * case builds a real HOME on disk; nothing is ever moved.
 */

import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDatabaseEnv } from "./child-database.js";
import { evidenceRoot } from "./evidence.js";
import { keysDir } from "./keys.js";
import { loadBotToken } from "./telegram.js";
import { loadWebhookTargets, loadConsoleUrl } from "./webhooks.js";
import { oneClickServices } from "./mcp-connect.js";
import { BRANCH_PREFIX, envTwins, envValue, existingOrFirst, headWithin, isOwnBranch, taskBranch, taskBranches } from "./names.js";
import { configPath } from "./repos.js";
import { databasePath } from "./store.js";

const homes: string[] = [];
const home = () => {
  const made = mkdtempSync(join(tmpdir(), "toolroll-home-"));
  homes.push(made);
  return made;
};
afterEach(() => {
  for (const one of homes.splice(0)) rmSync(one, { recursive: true, force: true });
});

describe("the config home", () => {
  test("a fresh install (empty HOME) uses ~/.config/toolroll, ~/.toolroll", () => {
    const h = home();
    expect(databasePath({}, h)).toBe(join(h, ".config", "toolroll", "orders.db"));
    expect(configPath({}, h)).toBe(join(h, ".config", "toolroll", "repos.json"));
    expect(evidenceRoot(h)).toBe(join(h, ".toolroll", "evidence"));
    expect(keysDir(h)).toBe(join(h, ".toolroll", "keys"));
    expect(databasePath({ XDG_CONFIG_HOME: join(h, "xdg") }, h)).toBe(join(h, "xdg", "toolroll", "orders.db"));
  });

  test("a HOME that already has ~/.config/standing-orders/orders.db keeps using it, and its neighbours", () => {
    const h = home();
    const old = join(h, ".config", "standing-orders");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "orders.db"), "");
    mkdirSync(join(h, ".standing-orders", "evidence"), { recursive: true });

    expect(databasePath({}, h)).toBe(join(old, "orders.db"));
    // A file that does not exist yet goes beside the database, not into a new folder.
    expect(configPath({}, h)).toBe(join(old, "repos.json"));
    expect(evidenceRoot(h)).toBe(join(h, ".standing-orders", "evidence"));
    expect(keysDir(h)).toBe(join(h, ".standing-orders", "keys"));
    // Nothing was moved or created under the new name.
    expect(existsSync(join(h, ".config", "toolroll"))).toBe(false);
    expect(existsSync(join(h, ".toolroll"))).toBe(false);
  });

  test("the older nightorders database is still found; one under the new name wins once it exists", () => {
    const h = home();
    const oldest = join(h, ".config", "nightorders");
    mkdirSync(oldest, { recursive: true });
    writeFileSync(join(oldest, "orders.db"), "");
    expect(databasePath({}, h)).toBe(join(oldest, "orders.db"));

    mkdirSync(join(h, ".config", "standing-orders"), { recursive: true });
    writeFileSync(join(h, ".config", "standing-orders", "orders.db"), "");
    expect(databasePath({}, h)).toBe(join(h, ".config", "standing-orders", "orders.db"));

    mkdirSync(join(h, ".config", "toolroll"), { recursive: true });
    // A new-name folder without a database never orphans the one that has it.
    expect(databasePath({}, h)).toBe(join(h, ".config", "standing-orders", "orders.db"));
    writeFileSync(join(h, ".config", "toolroll", "orders.db"), "");
    expect(databasePath({}, h)).toBe(join(h, ".config", "toolroll", "orders.db"));
  });
});

describe("TOOLROLL_* variables", () => {
  test("the new name wins when both are set, and the old one still works alone", () => {
    expect(envValue({ TOOLROLL_DB: "/new.db", STANDING_ORDERS_DB: "/old.db" }, "DB")).toBe("/new.db");
    expect(envValue({ STANDING_ORDERS_DB: "/old.db" }, "DB")).toBe("/old.db");
    expect(envValue({}, "DB")).toBeUndefined();
    expect(envValue({ TOOLROLL_DB: "", STANDING_ORDERS_DB: "/old.db" }, "DB")).toBe("/old.db");
    expect(envTwins("KIND", "x")).toEqual({ TOOLROLL_KIND: "x", STANDING_ORDERS_KIND: "x" });
  });

  test("the database override", () => {
    expect(databasePath({ TOOLROLL_DB: "/new.db", STANDING_ORDERS_DB: "/old.db" }, "/h")).toBe("/new.db");
    expect(databasePath({ STANDING_ORDERS_DB: "/old.db" }, "/h")).toBe("/old.db");
    // A child the plane starts gets both, so neither name can reach the live store.
    expect(childDatabaseEnv("/isolated.db")).toEqual({ TOOLROLL_DB: "/isolated.db", STANDING_ORDERS_DB: "/isolated.db" });
  });

  test("the Telegram token, the console URL and the test connector", () => {
    const token = (n: number) => `${n}:${"a".repeat(35)}`;
    expect(loadBotToken({ TOOLROLL_TELEGRAM_TOKEN: token(1), STANDING_ORDERS_TELEGRAM_TOKEN: token(2) }, "/nowhere")?.botId).toBe("1");
    expect(loadBotToken({ STANDING_ORDERS_TELEGRAM_TOKEN: token(2) }, "/nowhere")?.botId).toBe("2");

    const dir = home();
    expect(loadConsoleUrl({ TOOLROLL_CONSOLE_URL: "https://new.example", STANDING_ORDERS_CONSOLE_URL: "https://old.example" }, dir)).toBe("https://new.example");
    expect(loadConsoleUrl({ STANDING_ORDERS_CONSOLE_URL: "https://old.example" }, dir)).toBe("https://old.example");

    expect(loadWebhookTargets({ TOOLROLL_SLACK_WEBHOOK: "https://new.example/slack", STANDING_ORDERS_SLACK_WEBHOOK: "https://old.example/slack" }, dir)).toEqual([{ kind: "slack", url: "https://new.example/slack" }]);
    expect(loadWebhookTargets({ STANDING_ORDERS_DISCORD_WEBHOOK: "https://old.example/discord" }, dir)).toEqual([{ kind: "discord", url: "https://old.example/discord" }]);

    const stripe = (env: Record<string, string>) => oneClickServices(env).find(one => one.id === "stripe")?.url;
    expect(stripe({ TOOLROLL_TEST_CONNECT: "stripe|Stripe|http://127.0.0.1:1/mcp", STANDING_ORDERS_TEST_CONNECT: "stripe|Stripe|http://127.0.0.1:2/mcp" })).toBe("http://127.0.0.1:1/mcp");
    expect(stripe({ STANDING_ORDERS_TEST_CONNECT: "stripe|Stripe|http://127.0.0.1:2/mcp" })).toBe("http://127.0.0.1:2/mcp");
  });
});

describe("task branches", () => {
  test("new ones are toolroll/<id>; standing-orders/<id> ones are still the plane's own", () => {
    expect(BRANCH_PREFIX).toBe("toolroll/");
    expect(taskBranch("fix-login")).toBe("toolroll/fix-login");
    expect(taskBranches("fix-login")).toEqual(["toolroll/fix-login", "standing-orders/fix-login"]);
    expect(isOwnBranch("toolroll/fix-login")).toBe(true);
    expect(isOwnBranch("standing-orders/fix-login")).toBe(true);
    expect(isOwnBranch("feature/login")).toBe(false);
  });

  test("a retry reuses the branch it already has, under either name", async () => {
    const exists = (have: string[]) => async (branch: string) => have.includes(branch);
    expect(await existingOrFirst(taskBranches("t"), exists([]))).toBe("toolroll/t");
    expect(await existingOrFirst(taskBranches("t"), exists(["standing-orders/t"]))).toBe("standing-orders/t");
    expect(await existingOrFirst(taskBranches("t"), exists(["toolroll/t", "standing-orders/t"]))).toBe("toolroll/t");
  });

  test("a publication grant for one name covers the plane's branches under the other", () => {
    expect(headWithin("toolroll/t", "standing-orders/")).toBe(true);
    expect(headWithin("standing-orders/t", "toolroll/")).toBe(true);
    expect(headWithin("toolroll/team/t", "standing-orders/team/")).toBe(true);
    expect(headWithin("toolroll/other/t", "standing-orders/team/")).toBe(false);
    expect(headWithin("feature/t", "standing-orders/")).toBe(false);
    expect(headWithin("release/t", "release/")).toBe(true);
    expect(headWithin("toolroll/t", "release/")).toBe(false);
  });
});
