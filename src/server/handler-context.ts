import type { IncomingMessage,ServerResponse } from 'node:http';
import type { RouteDeclaration } from './route-table.js';
import type { Who } from './shared.js';
export interface HandlerContext { url: URL; who: Who; request: IncomingMessage; response: ServerResponse; route: RouteDeclaration; now: Date; project: string | null; chosenProject: string | null; posted: URLSearchParams; }
export interface EdgeContext { route: RouteDeclaration; url: URL; who: Who | null; request: IncomingMessage; response: ServerResponse; method: string; }
