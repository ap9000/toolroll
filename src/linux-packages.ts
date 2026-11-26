/**
 * The line that installs Linux packages on this computer: its own package manager's (apt, dnf, zypper, pacman, apk,
 * found by the program's fixed system path), with `sudo` only when not already root; every manager's line when none
 * is found. Package names are each distribution's own (checked against their repositories, 2026-11): the same word
 * everywhere except `which`, which Debian and Ubuntu ship in debianutils. install.sh says the same lines
 * (src/install-sh.test.ts and src/sandbox-runtime.test.ts hold them together).
 */
import { existsSync } from "node:fs";

export type PackageManager = "apt" | "dnf" | "zypper" | "pacman" | "apk";
export type PackageSystem = { manager: PackageManager | null; root: boolean };

/** Where each manager's program lives, in the order looked for. */
const PROGRAMS: readonly [PackageManager, readonly string[]][] = [
  ["apt", ["/usr/bin/apt-get"]],
  ["dnf", ["/usr/bin/dnf", "/usr/bin/dnf5"]],
  ["zypper", ["/usr/bin/zypper"]],
  ["pacman", ["/usr/bin/pacman"]],
  ["apk", ["/sbin/apk", "/usr/sbin/apk", "/usr/bin/apk"]],
];
const NAMES: Readonly<Record<PackageManager, string>> = { apt: "Debian, Ubuntu", dnf: "Fedora", zypper: "openSUSE", pacman: "Arch", apk: "Alpine" };
/** A package whose name differs on a manager. */
const RENAMED: Readonly<Record<string, Partial<Record<PackageManager, string>>>> = { which: { apt: "debianutils" } };

/** This computer's package manager (null when none of these is found) and whether this process is root. */
export function packageSystem(exists: (path: string) => boolean = existsSync, euid: number = process.geteuid?.() ?? -1): PackageSystem {
  const manager = PROGRAMS.find(([, paths]) => paths.some(path => exists(path)))?.[0] ?? null;
  return { manager, root: euid === 0 };
}

/** One manager's install command for `packages`. */
export function managerLine(manager: PackageManager, packages: readonly string[], root: boolean): string {
  const sudo = root ? "" : "sudo ";
  const named = [...new Set(packages.map(one => RENAMED[one]?.[manager] ?? one))].join(" ");
  switch (manager) {
    case "apt": return `${sudo}apt update && ${sudo}apt install ${named}`;
    case "dnf": return `${sudo}dnf install ${named}`;
    case "zypper": return `${sudo}zypper install ${named}`;
    case "pacman": return `${sudo}pacman -S --needed ${named}`;
    case "apk": return `${sudo}apk add ${named}`;
  }
}

/** The line that installs `packages` here; with no manager found, each manager's, named by its distributions. */
export function installLine(packages: readonly string[], system: PackageSystem = packageSystem()): string {
  if (system.manager !== null) return managerLine(system.manager, packages, system.root);
  return PROGRAMS.map(([manager]) => `${managerLine(manager, packages, system.root)} (${NAMES[manager]})`).join("; ");
}
