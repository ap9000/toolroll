The server matches each request once with `route-table.ts`. A row declares the whole policy of one address: method and pattern, callers, scope, project resolver, what a project-limited account may do, and the role (`any`, `approver` or `operator`) with the exact words a caller without it hears. Patterned families are one row per operation.

Every row has exactly one handler. Domain factories register one function per route id with `handlersOf`; a family binds its operation as a constant (`taskAct("hold")`), never by re-reading the path. Startup rejects a missing, extra, incompatible or shared handler. Handlers read path parameters (an id, a code) but never compare paths to choose what to do.

The shared policy checks caller, scope and the declared project before body-dependent work; `dispatchConsole` in `serve.ts` checks the row's role last and only then calls the handler. Unknown edge paths and wrong methods never enter a protocol adapter.

`guards.ts` owns browser credentials, mutation proof and project admission. `runtime.ts` describes the captured state used by console factories; getters preserve mutable server state. Handlers keep only checks for state that can change after admission: passwords, nonces, membership, generations, a resource's own state, and environment facts the table cannot know (no config folder, an in-memory database, demo mode).

Remote adapters retain their protocol authentication and refusal formats. An async request context carries the matched row through that proof; `adapterPolicy` applies the same evaluator before protocol operations. CLI, MCP and team POSTs declare a read minimum and also check each decoded operation's capability. Webhooks resolve the flow from the secret address; provider signatures remain required.

`route-roles-http.test.ts` and `route-policy-http.test.ts` exercise every declaration over HTTP; compact independent policy expectations preserve the reviewed caller and scope decisions.
