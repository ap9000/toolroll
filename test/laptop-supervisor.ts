/**
 * A scripted launchctl/systemctl for the laptop background service (laptop-background.ts): `launchctl print` and
 * `systemctl is-active` answer by a loaded flag that bootstrap/enable set and bootout/disable/stop clear; plutil and
 * systemd-analyze pass unless told not to. `onLoad` runs when the unit is loaded (a test may start a real child there,
 * as launchd would). Every call is logged; nothing reaches the machine's real supervisor.
 */
import type { SupervisorRunner } from "../src/daemon.js";

export function scriptedSupervisor(options: { loaded?: boolean; plutil?: boolean; onLoad?: () => void } = {}) {
  const state = { loaded: options.loaded ?? false, log: [] as string[] };
  const ok = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
  const run = (async (file: string, args: readonly string[]) => {
    state.log.push([file, ...args].join(" "));
    if (file === "plutil") return options.plutil === false ? { ...ok, code: 1, stdout: `${args[1]}: Encountered unknown tag` } : ok;
    if (file === "systemd-analyze") return ok;
    if (file === "launchctl") {
      if (args[0] === "print") return state.loaded ? ok : { ...ok, code: 113 };
      if (args[0] === "bootstrap") { state.loaded = true; options.onLoad?.(); }
      if (args[0] === "bootout") state.loaded = false;
      return ok;
    }
    if (file === "systemctl") {
      if (args[1] === "is-active") return { ...ok, code: state.loaded ? 0 : 3, stdout: state.loaded ? "active\n" : "inactive\n" };
      if (args[1] === "enable") { state.loaded = true; options.onLoad?.(); }
      if (args[1] === "disable" || args[1] === "stop") state.loaded = false;
      return ok;
    }
    return { ...ok, code: 1 };
  }) as unknown as SupervisorRunner;
  return { state, run };
}
