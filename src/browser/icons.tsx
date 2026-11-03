/** The workspace's own drawn icons (one stroke weight, inline and CSP-safe). */
import type { ReactNode } from "react";

export function Icon({ name }: { name: "menu" | "chat" | "tasks" | "agents" | "flows" | "projects" | "knowledge" | "settings" | "arrow" | "close" | "send" | "tools" | "plus" }) {
  const paths: Record<typeof name, ReactNode> = {
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    chat: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z" />,
    tasks: <><path d="m3 6 2 2 4-4m-6 9 2 2 4-4m-6 9 2 2 4-4M13 6h8M13 13h8M13 20h8" /></>,
    agents: <><rect width="18" height="14" x="3" y="5" rx="2" /><path d="m7 10 3 2-3 2M13 14h4" /></>,
    flows: <><rect width="8" height="8" x="3" y="3" rx="2" /><path d="M7 11v4a2 2 0 0 0 2 2h4" /><rect width="8" height="8" x="13" y="13" rx="2" /></>,
    projects: <path d="M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
    knowledge: <path d="M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15" />,
    settings: <><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 3v6M16 9v6M10 15v6" /></>,
    arrow: <path d="m10 6-6 6 6 6M4 12h16" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    send: <path d="m12 19 0-14m-6 6 6-6 6 6" />,
    tools: <><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
