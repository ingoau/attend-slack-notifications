import { DurableObject } from "cloudflare:workers";
import type { TokenState } from "./attend";
import { loadConfig, type Env } from "./config";
import { buildPayload, signupVars } from "./message";
import { Poller as PollRunner, postToSlack, type PollReport, type StateStore } from "./poll";

/**
 * The single place state lives. One instance (named "default") polls Attend; Durable Object
 * storage is strongly consistent, which matters because every token rotation revokes the
 * previous token — reading a stale copy would sign the worker out for good.
 */
export class Poller extends DurableObject<Env> {
  /** Serializes polls so a manual /poll can't race the cron and rotate the token twice. */
  private running: Promise<PollReport> | null = null;
  private readonly store: StateStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS seen (event TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (event, key))");
    const storage = ctx.storage;

    this.store = {
      loadToken: async () => (await storage.get<TokenState>("token")) ?? null,
      saveToken: async (state) => storage.put("token", state),
      get: async <T>(key: string) => storage.get<T>(key),
      put: async (key, value) => storage.put(key, value),
      delete: async (key) => {
        await storage.delete(key);
      },
      seenKeys: async (event) =>
        new Set(sql.exec<{ key: string }>("SELECT key FROM seen WHERE event = ?", event).toArray().map((r) => r.key)),
      addSeen: async (event, keys) => {
        for (const key of keys) sql.exec("INSERT OR IGNORE INTO seen (event, key) VALUES (?, ?)", event, key);
      },
    };
  }

  async poll(): Promise<PollReport> {
    if (this.running) return this.running;
    this.running = new PollRunner(loadConfig(this.env), this.store).run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Last poll result plus token expiry, for GET /status. Never includes the token. */
  async status(): Promise<{ lastReport: PollReport | null; tokenExpiresAt: string | null; seen: Record<string, number> }> {
    const token = await this.ctx.storage.get<TokenState>("token");
    const seen = Object.fromEntries(
      this.ctx.storage.sql
        .exec<{ event: string; n: number }>("SELECT event, COUNT(*) AS n FROM seen GROUP BY event")
        .toArray()
        .map((r) => [r.event, r.n]),
    );
    return {
      lastReport: (await this.ctx.storage.get<PollReport>("last_report")) ?? null,
      tokenExpiresAt: token?.expiresAt ?? null,
      seen,
    };
  }

  /** Sends a sample message with the current templates, without touching Attend. */
  async test(): Promise<unknown> {
    const config = loadConfig(this.env);
    const event = config.events[0] ?? "my-event";
    const sample = signupVars(
      { email: "orpheus@hackclub.com", first_name: "Orpheus", last_name: "the Dinosaur", slack_user_id: null, status: "complete" },
      { id: event, name: `${event} (test message)`, slug: event },
      42,
      config.attendBaseUrl,
    );
    const payload = buildPayload(config, config.messageTemplate, sample);
    await postToSlack(config.slackWebhookUrl, payload, (input, init) => fetch(input, init));
    return payload;
  }

  /** Forgets who has been announced, so the next poll re-seeds silently. */
  async reset(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM seen");
    const keys = await this.ctx.storage.list({ prefix: "initialized:" });
    await this.ctx.storage.delete([...keys.keys()]);
  }
}
