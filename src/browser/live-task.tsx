/** The live task page (live tasks): the stream that says when the task changed and who else has it open, and the one
 * line that says what a running agent did last. The room is a hint: a change asks the workspace to read itself
 * again the usual way, and the line is worded here, against this page's clock. */
import { useEffect, useRef, useState } from "react";
import { useLiveRoom } from "./live.js";
import { activityLine, type RunActivity } from "../activity-line.js";
import { cn } from "./components/ui/index.js";

/** The event the workspace listens for: read again now. */
export const WORKSPACE_NUDGE = "so:workspace-nudge";

/** A clock that moves on its own, so "40 s ago" keeps counting between reads. */
export function useNow(everyMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** What the agent did last, and when: one quiet line; amber when it has gone quiet or its worker is offline. */
export function ActivityLine({ activity, className }: { activity: RunActivity; className?: string }) {
  const line = activityLine(activity, useNow());
  return <span className={cn("block min-w-0 truncate text-[13px]", line.quiet ? "font-medium text-warning" : "text-muted-foreground", className)}
    data-activity={line.quiet ? "quiet" : "fresh"} title={line.text}>
    <time dateTime={activity.at}>{line.text}</time>
  </span>;
}

/** Who else has this task open, in words. */
export function AlsoViewing({ people }: { people: readonly string[] }) {
  if (people.length === 0) return null;
  const words = people.length === 1 ? `${people[0]} is also here` : people.length === 2 ? `${people[0]} and ${people[1]} are also here` : `${people[0]} and ${people.length - 1} others are also here`;
  return <span className="min-w-0 truncate" data-also-viewing={people.length} role="status" title={people.join(", ")}>{words}</span>;
}

/** Follow the task's room: a change nudges the workspace to read again (unless the page already shows that state),
 * and the list of who else is here comes back. */
export function useLiveTask(live: { room: string; at?: string | null } | null | undefined): string[] {
  const [people, setPeople] = useState<string[]>([]);
  const seen = useRef(live?.at ?? null);
  seen.current = live?.at ?? null;
  const room = live?.room ?? null;
  useEffect(() => { if (room === null) setPeople([]); }, [room]);
  useLiveRoom(room, (event, data) => {
    const nudge = () => window.dispatchEvent(new CustomEvent(WORKSPACE_NUDGE));
    if (event === "change") { const at = data["at"]; if (typeof at !== "string" || at !== seen.current) nudge(); }
    // The server's stream fell behind and caught up: read again whatever it last said.
    else if (event === "reload") nudge();
    else if (event === "here") { const list = data["people"]; if (Array.isArray(list)) setPeople(list.filter((one): one is string => typeof one === "string")); }
    else if (event === "gone" || event === "lost") setPeople([]);
  });
  return people;
}
