import type { EdgeContext,HandlerContext } from './handler-context.js';
import { ROUTES,type Domain,type RouteDeclaration,type RouteMethod } from './route-table.js';

export type Registration =
  | { id: string; domain: Domain; stage: 'console'; method: RouteMethod; handle: (ctx: HandlerContext) => Promise<void> }
  | { id: string; domain: Domain; stage: 'edge'; method: RouteMethod; handle: (ctx: EdgeContext) => Promise<void> };

/** Registrations are independent of policy. Missing, extra or incompatible entries fail at startup. */
export function assertHandlerRegistry(registrations: readonly Registration[], routes: readonly RouteDeclaration[] = ROUTES): void {
  const seen = new Set<string>();
  for (const handler of registrations) {
    if (seen.has(handler.id)) throw new Error(`Duplicate handler: ${handler.id}`);
    seen.add(handler.id);
    const route = routes.find(row => row.id === handler.id);
    if (!route || route.domain !== handler.domain || route.method !== handler.method || route.stage !== handler.stage) throw new Error(`Handler has no compatible route: ${handler.id}`);
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
