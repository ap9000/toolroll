/**
 * Pages are named as the app names them now: Work at /, never the retired Home and Tasks pages. The not-found page
 * leads to Work, and no copy a person reads sends them to a page that is gone.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { NOT_FOUND } from "./design/kit.js";
import { htmlString } from "./html.js";
import { notFound } from "./server/kit.js";

/** Phrases that name the retired pages as places to go. */
const RETIRED = [/Go to Home/, /Home has what needs you/, /Tasks has every task/, /\bin Tasks[.\s]/, /Open in Tasks/, /more in Tasks/, /back in Tasks/];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("page names", () => {
  test("the not-found page says where things are: Work", () => {
    expect(NOT_FOUND.text).toBe("It may have moved. Work has every task and what needs you.");
    const page = htmlString(notFound("/somewhere")).replace(/<[^>]*>/g, " ");
    expect(page).toContain("Work has every task and what needs you.");
    expect(page).toContain("Go to Work");
    expect(page).not.toMatch(/\bHome\b|\bTasks\b/);
  });

  test("no string in the app sends a person to the retired Home or Tasks page", () => {
    const root = new URL(".", import.meta.url).pathname;
    const found: string[] = [];
    for (const file of sources(root)) {
      // Comments say how things came to be; only strings a person reads count.
      const strings = readFileSync(file, "utf8").split("\n").filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n").match(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g) ?? [];
      for (const one of strings) for (const phrase of RETIRED) if (phrase.test(one)) found.push(`${file.slice(root.length)}: ${one.slice(0, 120)}`);
    }
    expect(found).toEqual([]);
  });
});
