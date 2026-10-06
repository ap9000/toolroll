import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { accessFailure, probeDesktopProject, interpretAccessProbe, currentDesktopAccess, type DesktopAccessReport } from "./desktop-access.js";
import { fakePid } from "../test/fake-pid.js";

test("the real access probe reads the repository and round-trips only its own Git-metadata scratch file", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-access-")));
  try {
    execFileSync("git", ["init", "-q", root]); writeFileSync(join(root, "keep.txt"), "Do not change\n");
    const gitBefore = readdirSync(join(root, ".git")).sort();
    const before = execFileSync("git", ["-C", root, "status", "--porcelain"], {encoding:"utf8"});
    expect(probeDesktopProject(root).state).toBe("ready");
    expect(readdirSync(join(root, ".git")).sort()).toEqual(gitBefore);
    expect(execFileSync("git", ["-C", root, "status", "--porcelain"], {encoding:"utf8"})).toBe(before);
    expect(probeDesktopProject(join(root, "missing")).state).toBe("missing");
    const other = join(root,"ordinary"); mkdirSync(other);
    // A subfolder resolves to its Git repository; no broad filesystem grants.
    expect(probeDesktopProject(other).state).toBe("ready");
  } finally { rmSync(root, {recursive:true,force:true}); }
});

test("access failures use plain-language recovery without treating every failure as a permission denial", () => {
  for (const code of ["EPERM","EACCES","EROFS"]) expect(accessFailure("/repo",code).state).toBe("permission-needed");
  expect(accessFailure("/repo","ENOENT").state).toBe("missing");
  expect(accessFailure("/repo","EIO").state).toBe("unavailable");
  const result = {code:0,stdout:JSON.stringify({repo:"/elsewhere",state:"ready",message:"ok"}),stderr:"",timedOut:false,notFound:false};
  expect(interpretAccessProbe("/repo",result).state).toBe("unavailable");
  expect(interpretAccessProbe("/repo",{...result,timedOut:true}).message).toContain("Unlock your Mac");
});

test("setup never accepts an old worker, old selection, corrupt result or pre-recheck receipt as ready", () => {
  const controller = fakePid(1), otherController = fakePid(2);
  const report: DesktopAccessReport = {version:1,controllerPid:controller,checkedAt:"2026-09-13T02:00:01.000Z",request:"current",projects:[{repo:"/repo",state:"ready",message:"checked"}]};
  const worker = {phase:"running",controllerPid:controller,updatedAt:"2026-09-13T02:00:00.000Z"};
  expect(currentDesktopAccess(report,worker,["/repo"],"current").verified).toBe(true);
  for (const state of [{...worker,controllerPid:otherController},{...worker,phase:"stopped"},{...worker,updatedAt:"2026-09-13T02:00:02.000Z"},null]) {
    expect(currentDesktopAccess(report,state,["/repo"],"current").verified).toBe(false);
  }
  expect(currentDesktopAccess(report,worker,["/new-repo"],"current").verified).toBe(false);
  expect(currentDesktopAccess(report,worker,["/repo"],"new-request").verified).toBe(false);
  expect(currentDesktopAccess({...report,projects:[null as any]},worker,["/repo"],"current").verified).toBe(false);
  expect(currentDesktopAccess(null,worker,[],"").verified).toBe(false);
  const denied = {...report,projects:[accessFailure("/repo","EPERM")]};
  expect(currentDesktopAccess(denied,{...worker,phase:"backoff",controllerPid:null},["/repo"],"current")).toMatchObject({verified:false,projects:[{state:"permission-needed"}]});
});
