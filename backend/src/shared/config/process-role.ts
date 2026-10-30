/**
 * What kind of process this is (Work 65). The HTTP server is the default. An operator CLI (e.g.
 * `npm run admin:bootstrap-super-admin`) declares itself before it creates its Nest context, so
 * the background timers its modules carry — the outbox relay, the licence-expiry job — never start.
 * A CLI that relayed outbox events would publish them to only the handlers it happens to load,
 * marking them published and taking them away from the real server.
 */
let role: 'server' | 'cli' = 'server';

/** Call once, at the top of a CLI entry point, before `NestFactory.createApplicationContext`. */
export function declareCliProcess(): void {
  role = 'cli';
}

export function isCliProcess(): boolean {
  return role === 'cli';
}
