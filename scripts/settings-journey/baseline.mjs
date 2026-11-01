/** Wave-0 baseline (Settings revamp S1): today's Settings surface on the lived-in fixture, so every later slice starts
 * from the same shots and probe results. Its known findings are the allowlist the slices burn down; a slice that
 * replaces one of these pages moves it into its own step file and deletes its line here. */
export const about = "Today's Settings pages, owner and viewer, before the revamp";
export const fixture = "lived-in";

const owner = [
  ["settings-hub", "/settings"],
  ["models", "/settings/models"],
  ["spend-settings", "/settings/spend"],
  ["spend-report", "/spend"],
  ["telegram", "/settings/telegram"],
  ["slack", "/settings/slack"],
  ["discord", "/settings/discord"],
  ["teams", "/settings/teams"],
  ["people", "/people"],
  ["sessions", "/settings/sessions"],
  ["tools", "/settings/tools"],
  ["lead", "/settings/lead"],
  ["integrations", "/settings/integrations"],
  ["sign-in", "/settings/sign-in"],
  ["passwordless", "/settings/passwordless"],
  ["project", "/settings/project"],
  ["policy", "/settings/policy"],
  ["approval-rules", "/settings/approval"],
  ["monitoring", "/settings/monitoring"],
  ["retention", "/settings/retention"],
  ["storage", "/settings/storage"],
  ["updates", "/settings/updates"],
  ["backups", "/settings/backups"],
  ["data", "/settings/data"],
  ["mode", "/mode"],
  ["requirements", "/caps"],
  ["fleet", "/fleet"],
  ["system", "/system"],
  ["project-setup", "/control"],
];

export const pages = [
  ...owner.map(([name, path]) => ({ name, path })),
  { name: "viewer-settings-hub", path: "/settings", as: "viewer" },
  { name: "viewer-models", path: "/settings/models", as: "viewer" },
];
