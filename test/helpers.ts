import type { TokenState, RosterEntry } from "../src/attend";
import { loadConfig, type Config, type Env } from "../src/config";
import type { StateStore } from "../src/poll";

export class MemoryStore implements StateStore {
  kv = new Map<string, unknown>();
  seen = new Map<string, Set<string>>();

  async loadToken() {
    return (this.kv.get("token") as TokenState | undefined) ?? null;
  }
  async saveToken(state: TokenState) {
    this.kv.set("token", structuredClone(state));
  }
  async get<T>(key: string) {
    return this.kv.get(key) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.kv.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.kv.delete(key);
  }
  async seenKeys(event: string) {
    return new Set(this.seen.get(event) ?? []);
  }
  async addSeen(event: string, keys: string[]) {
    const set = this.seen.get(event) ?? new Set();
    keys.forEach((k) => set.add(k));
    this.seen.set(event, set);
  }
}

export const SLACK_URL = "https://hooks.slack.com/services/T000/B000/XXXX";
export const ATTEND = "https://attend.test";

export function config(overrides: Partial<Env> = {}): Config {
  return loadConfig({
    ATTEND_TOKEN: "seed-token",
    SLACK_WEBHOOK_URL: SLACK_URL,
    ATTEND_EVENT: "scrapyard",
    ATTEND_BASE_URL: ATTEND,
    ...overrides,
  } as Env);
}

export function person(first: string, last: string, extra: Partial<RosterEntry> = {}): RosterEntry {
  return {
    email: `${first.toLowerCase()}@example.com`,
    first_name: first,
    last_name: last,
    slack_user_id: null,
    status: "complete",
    ...extra,
  };
}

/** A tiny fake of the parts of Attend and Slack the worker talks to. */
export class FakeWorld {
  roster: RosterEntry[] = [];
  validTokens = new Set(["seed-token"]);
  recommendRefresh = false;
  slackStatus = 200;
  slackMessages: any[] = [];
  refreshCalls = 0;
  rosterCalls = 0;
  private nextToken = 1;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.href === SLACK_URL) {
      if (this.slackStatus !== 200) return new Response("invalid_payload", { status: this.slackStatus });
      this.slackMessages.push(JSON.parse(String(init?.body)));
      return new Response("ok");
    }
    const auth = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
    if (!this.validTokens.has(auth)) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const headers: Record<string, string> = this.recommendRefresh ? { "X-Token-Refresh-Recommended": "true" } : {};

    if (url.pathname === "/api/v1/session/refresh" && init?.method === "POST") {
      this.refreshCalls += 1;
      this.validTokens.delete(auth); // Attend revokes the old token immediately
      const token = `rotated-${this.nextToken++}`;
      this.validTokens.add(token);
      this.recommendRefresh = false;
      return Response.json({ token, expires_at: new Date(Date.now() + 14 * 864e5).toISOString(), user: {} });
    }
    if (url.pathname === "/api/v1/events") {
      return Response.json({ events: [{ id: "evt_1", name: "Scrapyard Sydney", slug: "scrapyard" }] }, { headers });
    }
    if (url.pathname === "/api/v1/events/scrapyard/participants/roster") {
      this.rosterCalls += 1;
      return Response.json({ participants: this.roster, synced_at: new Date().toISOString() }, { headers });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  get slackTexts(): string[] {
    return this.slackMessages.map((m) => m.text);
  }
}
