import { ConfigError, type Env } from "./config";

export { Poller } from "./poller";

const poller = (env: Env) => env.POLLER.get(env.POLLER.idFromName("default"));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });

/** Constant-time string comparison for the admin key. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

function authorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_KEY) return false;
  const header = request.headers.get("Authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : (new URL(request.url).searchParams.get("key") ?? "");
  return safeEqual(given, env.ADMIN_KEY);
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      poller(env)
        .poll()
        .then((report) => {
          if (report.error) console.error(`Poll finished with an error: ${report.error}`);
        })
        .catch((e: Error) => console.error(`Poll failed: ${e.message}`)),
    );
  },

  /**
   * Admin endpoints, only enabled when the ADMIN_KEY secret is set. Pass it as
   * `Authorization: Bearer <key>` or `?key=<key>`.
   *   GET  /status  last poll result and token expiry
   *   POST /poll    poll now
   *   POST /test    send a sample message with the current template
   *   POST /reset   forget who's been announced (next poll re-seeds silently)
   */
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") {
      return new Response("attend-slack-notifications is running. See https://github.com/ingoau/attend-slack-notifications\n");
    }
    if (!authorized(request, env)) return json({ error: env.ADMIN_KEY ? "Unauthorized" : "Not found" }, env.ADMIN_KEY ? 401 : 404);

    try {
      const stub = poller(env);
      if (pathname === "/status" && request.method === "GET") return json(await stub.status());
      if (request.method !== "POST") return json({ error: "Not found" }, 404);
      if (pathname === "/poll") return json(await stub.poll());
      if (pathname === "/test") return json({ sent: await stub.test() });
      if (pathname === "/reset") {
        await stub.reset();
        return json({ ok: true });
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: (e as Error).message }, e instanceof ConfigError ? 400 : 500);
    }
  },
} satisfies ExportedHandler<Env>;
