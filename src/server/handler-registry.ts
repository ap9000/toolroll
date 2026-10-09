import type { EdgeContext,HandlerContext } from './handler-context.js';
import { ROUTES,type Domain,type RouteDeclaration } from './route-table.js';

export type ConsoleHandler = (ctx: HandlerContext) => Promise<void>;
export type EdgeHandler = (ctx: EdgeContext) => Promise<void>;
export type Registration =
  | { id: string; domain: Domain; stage: 'console'; handle: ConsoleHandler }
  | { id: string; domain: Domain; stage: 'edge'; handle: EdgeHandler };

/** One domain's handlers by route id: one function per row. */
export function handlersOf(domain: Domain, console: Readonly<Record<string, ConsoleHandler>>, edge: Readonly<Record<string, EdgeHandler>> = {}): Registration[] {
  return [
    ...Object.entries(console).map(([id, handle]) => ({ id, domain, stage: 'console' as const, handle })),
    ...Object.entries(edge).map(([id, handle]) => ({ id, domain, stage: 'edge' as const, handle })),
  ];
}

/** Registrations are independent of policy. Missing, extra, incompatible or shared handlers fail at startup. */
export function assertHandlerRegistry(registrations: readonly Registration[], routes: readonly RouteDeclaration[] = ROUTES): void {
  const seen = new Set<string>();
  const callbacks = new Map<unknown, string>();
  for (const handler of registrations) {
    if (seen.has(handler.id)) throw new Error(`Duplicate handler: ${handler.id}`);
    seen.add(handler.id);
    const route = routes.find(row => row.id === handler.id);
    if (!route || route.domain !== handler.domain || route.stage !== handler.stage) throw new Error(`Handler has no compatible route: ${handler.id}`);
    const other = callbacks.get(handler.handle);
    if (other !== undefined) throw new Error(`Handler shared by ${other} and ${handler.id}`);
    callbacks.set(handler.handle, handler.id);
  }
  for (const route of routes) if (!seen.has(route.id)) throw new Error(`Route has no handler: ${route.id}`);
}

export function createHandlerRegistry(registrations: readonly Registration[]) {
  assertHandlerRegistry(registrations);
  const byId = new Map(registrations.map(handler => [handler.id, handler]));
  return {
    async console(route: RouteDeclaration, ctx: HandlerContext): Promise<void> {
      const handler = byId.get(route.id);
      if (!handler || handler.stage !== 'console') throw new Error(`No console handler: ${route.id}`);
      return handler.handle(ctx);
    },
    async edge(route: RouteDeclaration, ctx: EdgeContext): Promise<void> {
      const handler = byId.get(route.id);
      if (!handler || handler.stage !== 'edge') throw new Error(`No edge handler: ${route.id}`);
      return handler.handle(ctx);
    },
  };
}
