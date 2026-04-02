/**
 * HTTP server for the bg-manager web dashboard.
 * Serves a web UI + JSON API + SSE for live updates.
 * Bound to 127.0.0.1 only (local dev tool).
 */
export declare function shutdownHttpServer(): void;
export declare function startHttpServer(preferredPort?: number): Promise<number>;
