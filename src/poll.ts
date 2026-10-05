import { AttendClient, AttendError, sha256Hex, type AttendEvent, type RosterEntry, type TokenStore } from "./attend";
import type { Config } from "./config";
import { buildPayload, signupVars, summaryVars, type EventInfo } from "./message";

export interface StateStore extends TokenStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Hashed identities of everyone already announced (or seeded) for this event. */
  seenKeys(event: string): Promise<Set<string>>;
  addSeen(event: string, keys: string[]): Promise<void>;
}

export interface EventReport {
  event: string;
  ok: boolean;
  count?: number;
  newSignups?: number;
  messagesSent?: number;
  seeded?: boolean;
  error?: string;
}

export interface PollReport {
  at: string;
  events: EventReport[];
  tokenRefreshed: boolean;
  tokenExpiresAt: string | null;
  adoptedNewToken: boolean;
  error?: string;
}

export class SlackError extends Error {}

const EVENT_INFO_TTL_MS = 6 * 60 * 60 * 1000;

/** A stable, non-reversible identity for a roster row, so no emails are stored. */
export async function identityKey(p: RosterEntry): Promise<string> {
  const email = p.email?.trim().toLowerCase();
  const basis = email
    ? `email:${email}`
    : `name:${(p.first_name ?? "").trim().toLowerCase()}|${(p.last_name ?? "").trim().toLowerCase()}|${p.slack_user_id ?? ""}`;
  return (await sha256Hex(basis)).slice(0, 32);
}

export async function postToSlack(url: string, payload: unknown, fetchImpl: typeof fetch): Promise<void> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new SlackError(`Slack webhook returned HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
}

export class Poller {
  readonly client: AttendClient;

  constructor(
    private readonly config: Config,
    private readonly store: StateStore,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly log: (msg: string) => void = (msg) => console.log(msg),
  ) {
    this.client = new AttendClient(config.attendBaseUrl, config.seedToken, store, fetchImpl);
  }

  async run(): Promise<PollReport> {
    const { adoptedSeed } = await this.client.init();
    if (adoptedSeed) this.log("Using the ATTEND_TOKEN secret (first run, or the secret was changed)");

    const report: PollReport = {
      at: new Date().toISOString(),
      events: [],
      tokenRefreshed: false,
      tokenExpiresAt: null,
      adoptedNewToken: adoptedSeed,
    };

    let tokenDead = false;
    for (const event of this.config.events) {
      try {
        report.events.push(await this.pollEvent(event));
        await this.clearAlert(`event:${event}`, null);
      } catch (e) {
        const message = (e as Error).message;
        report.events.push({ event, ok: false, error: message });
        this.log(`[${event}] ${message}`);
        if (e instanceof AttendError && e.isUnauthorized) {
          tokenDead = true;
          break;
        }
        if (e instanceof AttendError && (e.status === 403 || e.status === 404)) {
          await this.alert(
            `event:${event}`,
            `:warning: Attend sign-up notifications can't read the roster for \`${event}\`: ${message}. ` +
              "Check ATTEND_EVENT and that the token's account can view participants for this event.",
          );
        }
      }
    }

    if (tokenDead) {
      report.error = "Attend rejected the token";
      await this.alert(
        "token",
        ":rotating_light: Attend sign-up notifications have stopped: Attend rejected the mobile token " +
          "(it expired or was revoked). Issue a new one (BetterAttend → Settings → Developer → Copy a new " +
          "mobile token) and run `wrangler secret put ATTEND_TOKEN`.",
      );
    } else {
      await this.clearAlert("token", ":white_check_mark: Attend sign-up notifications are working again.");
      if (this.client.needsRefresh) {
        try {
          await this.client.refresh();
          report.tokenRefreshed = true;
          this.log(`Rotated the Attend token; new one expires ${this.client.expiresAt}`);
        } catch (e) {
          // A network failure leaves the current token valid; try again next poll.
          report.error = (e as Error).message;
          this.log(report.error);
        }
      }
    }

    report.tokenExpiresAt = this.client.expiresAt;
    await this.store.put("last_report", report);
    return report;
  }

  private async pollEvent(event: string): Promise<EventReport> {
    const roster = await this.client.roster(event);
    const { statuses } = this.config;
    const signedUp = roster.filter((p) => statuses.size === 0 || statuses.has((p.status ?? "").toLowerCase()));

    // One entry per person, in roster order.
    const people = new Map<string, RosterEntry>();
    for (const p of signedUp) {
      const key = await identityKey(p);
      if (!people.has(key)) people.set(key, p);
    }
    const count = people.size;

    const seen = await this.store.seenKeys(event);
    const fresh = [...people].filter(([key]) => !seen.has(key));
    const initializedKey = `initialized:${event}`;

    if (!(await this.store.get<boolean>(initializedKey)) && !this.config.announceExisting) {
      // First look at this event: remember everyone already here without announcing them.
      await this.store.addSeen(event, fresh.map(([key]) => key));
      await this.store.put(initializedKey, true);
      this.log(`[${event}] First run: ${count} existing sign-ups recorded, nothing announced`);
      return { event, ok: true, count, newSignups: 0, messagesSent: 0, seeded: true };
    }

    let messagesSent = 0;
    if (fresh.length > 0) {
      const info = await this.eventInfo(event);
      const { maxMessagesPerPoll: max, attendBaseUrl } = this.config;
      // Past the limit, the last message summarizes everyone left over.
      const individual = fresh.length <= max ? fresh : fresh.slice(0, max - 1);
      const rest = fresh.slice(individual.length);
      let running = count - fresh.length;

      for (const [key, person] of individual) {
        running += 1;
        const payload = buildPayload(this.config, this.config.messageTemplate, signupVars(person, info, running, attendBaseUrl));
        await postToSlack(this.config.slackWebhookUrl, payload, this.fetchImpl);
        // Marked one at a time, so a Slack failure only retries the people not yet announced.
        await this.store.addSeen(event, [key]);
        messagesSent += 1;
      }
      if (rest.length > 0) {
        const payload = buildPayload(this.config, this.config.summaryTemplate, summaryVars(rest.length, info, count, attendBaseUrl));
        await postToSlack(this.config.slackWebhookUrl, payload, this.fetchImpl);
        await this.store.addSeen(event, rest.map(([key]) => key));
        messagesSent += 1;
      }
      this.log(`[${event}] ${fresh.length} new sign-up(s), ${messagesSent} message(s) sent, total ${count}`);
    }

    await this.store.put(initializedKey, true);
    return { event, ok: true, count, newSignups: fresh.length, messagesSent };
  }

  /** The event's name for messages, from `GET /events`, cached for a few hours. */
  async eventInfo(event: string): Promise<EventInfo> {
    const cacheKey = `event_info:${event}`;
    const cached = await this.store.get<{ info: EventInfo; fetchedAt: number }>(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < EVENT_INFO_TTL_MS) return cached.info;
    try {
      const events = await this.client.events();
      const match = events.find((e: AttendEvent) => e.id === event || e.slug === event);
      if (match) {
        const info = { id: match.id, name: match.name, slug: match.slug };
        await this.store.put(cacheKey, { info, fetchedAt: Date.now() });
        return info;
      }
    } catch (e) {
      this.log(`Couldn't look up the event name: ${(e as Error).message}`);
    }
    return cached?.info ?? { id: event, name: event, slug: event };
  }

  /** Posts [text] once per problem [kind] until that problem clears. */
  private async alert(kind: string, text: string): Promise<void> {
    const key = `alert:${kind}`;
    if (await this.store.get<boolean>(key)) return;
    try {
      await postToSlack(this.config.alertWebhookUrl ?? this.config.slackWebhookUrl, { text }, this.fetchImpl);
      await this.store.put(key, true);
    } catch (e) {
      this.log(`Couldn't send alert: ${(e as Error).message}`);
    }
  }

  private async clearAlert(kind: string, recoveredText: string | null): Promise<void> {
    const key = `alert:${kind}`;
    if (!(await this.store.get<boolean>(key))) return;
    await this.store.delete(key);
    if (recoveredText) {
      await postToSlack(this.config.alertWebhookUrl ?? this.config.slackWebhookUrl, { text: recoveredText }, this.fetchImpl).catch(
        (e: Error) => this.log(`Couldn't send recovery notice: ${e.message}`),
      );
    }
  }
}
