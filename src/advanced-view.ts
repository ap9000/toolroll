/**
 * Settings → Advanced, as a page sees it (advanced.ts decides it): whether the page being drawn shows the advanced
 * entry points, and the list Settings → Advanced always shows. No store and no request here, so any renderer can ask.
 */

/** The request's answer (request-context.ts provides it from the signed-in person's row). Outside a request: shown. */
let shownNow: () => boolean = () => true;
export function provideAdvancedShown(source: () => boolean): void { shownNow = source; }
/** Whether the page being drawn shows advanced entry points. */
export function advancedShownNow(): boolean {
  try { return shownNow(); } catch { return true; }
}

/** Every advanced page, as Settings → Advanced lists it (always, whatever the switch). `operator`: only an instance
 * operator can open it, so only they see the link. */
export type AdvancedPage = { title: string; href: string; words: string; operator?: true };
export const ADVANCED_PAGES: readonly AdvancedPage[] = Object.freeze([
  { title: "Flows", href: "/flows", words: "Work that starts on a schedule, a webhook or a form" },
  { title: "Agents", href: "/agents", words: "Every agent at work now, and the computers that build" },
  { title: "Spend", href: "/spend", words: "What agent work cost, and monthly limits", operator: true },
  { title: "Subagents", href: "/settings/lead/subagents", words: "Helpers the lead looks after" },
  { title: "Skills", href: "/settings/skills", words: "Reusable instructions for agents" },
  { title: "Learning", href: "/settings/learning", words: "Lessons kept from finished work" },
  { title: "Operating mode", href: "/mode", words: "Let a project run for a while without asking" },
  { title: "Policy", href: "/settings/policy", words: "Limits no task can go past" },
  { title: "Release approval", href: "/settings/approval#release-approval", words: "Approve releases automatically when checks pass" },
  { title: "Sign-in with a provider", href: "/settings/sign-in", words: "Let people sign in with your identity provider", operator: true },
  { title: "Passwordless", href: "/settings/passwordless", words: "Sign in once; most approvals then need no password", operator: true },
  { title: "Monitoring", href: "/settings/monitoring", words: "Send the audit stream and traces to your own systems", operator: true },
  { title: "Builders", href: "/fleet", words: "Every computer that builds" },
  { title: "For each project", href: "/settings/projects", words: "Fallback agents, live view commands, code map and flaky tests, on each project’s page" },
]);
