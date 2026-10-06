export interface Env {
  POLLER: DurableObjectNamespace<import("./poller").Poller>;

  // Secrets
  ATTEND_TOKEN?: string;
  SLACK_WEBHOOK_URL?: string;
  ALERT_WEBHOOK_URL?: string;
  ADMIN_KEY?: string;

  // Vars
  ATTEND_EVENT?: string;
  ATTEND_BASE_URL?: string;
  SIGNUP_STATUSES?: string;
  MESSAGE_TEMPLATE?: string;
  SUMMARY_TEMPLATE?: string;
  SLACK_PAYLOAD_TEMPLATE?: string;
  MAX_MESSAGES_PER_POLL?: string;
  ANNOUNCE_EXISTING?: string;
}

export interface Config {
  attendBaseUrl: string;
  seedToken: string;
  events: string[];
  /** Roster statuses that count as signed up; empty means every status on the roster. */
  statuses: Set<string>;
  slackWebhookUrl: string;
  alertWebhookUrl: string | null;
  messageTemplate: string;
  summaryTemplate: string;
  /** Parsed SLACK_PAYLOAD_TEMPLATE, if set. Its strings are templates. */
  payloadTemplate: unknown | null;
  maxMessagesPerPoll: number;
  /** On the very first poll, announce everyone already signed up instead of staying quiet. */
  announceExisting: boolean;
}

export const DEFAULT_MESSAGE_TEMPLATE =
  "new signup :yay:\ntotal signups: {count}";
export const DEFAULT_SUMMARY_TEMPLATE =
  "new signups :yay: x{new_count}\ntotal signups: {count}";

export class ConfigError extends Error {}

/**
 * An optional setting's value, or undefined when it's unset. The Deploy to Cloudflare form won't
 * accept a blank secret, so `default` and `none` also mean "not set".
 */
export const optional = (value: string | undefined): string | undefined => {
  const v = value?.trim();
  return v && !/^(default|none)$/i.test(v) ? v : undefined;
};

const list = (value: string | undefined): string[] =>
  (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const truthy = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test((value ?? "").trim());

export function loadConfig(env: Env): Config {
  const missing: string[] = [];
  const seedToken = env.ATTEND_TOKEN?.trim() ?? "";
  const slackWebhookUrl = env.SLACK_WEBHOOK_URL?.trim() ?? "";
  const events = list(env.ATTEND_EVENT);
  if (!seedToken) missing.push("ATTEND_TOKEN");
  if (!slackWebhookUrl) missing.push("SLACK_WEBHOOK_URL");
  if (events.length === 0) missing.push("ATTEND_EVENT");
  if (missing.length) throw new ConfigError(`Missing required setting(s): ${missing.join(", ")}`);

  let payloadTemplate: unknown | null = null;
  const payloadJson = optional(env.SLACK_PAYLOAD_TEMPLATE);
  if (payloadJson) {
    try {
      payloadTemplate = JSON.parse(payloadJson);
    } catch (e) {
      throw new ConfigError(`SLACK_PAYLOAD_TEMPLATE is not valid JSON: ${(e as Error).message}`);
    }
  }

  const max = Number.parseInt(env.MAX_MESSAGES_PER_POLL ?? "", 10);

  return {
    attendBaseUrl: (optional(env.ATTEND_BASE_URL) ?? "https://attend.hackclub.com").replace(/\/+$/, ""),
    seedToken,
    events,
    statuses: new Set(list(optional(env.SIGNUP_STATUSES)).map((s) => s.toLowerCase())),
    slackWebhookUrl,
    alertWebhookUrl: optional(env.ALERT_WEBHOOK_URL) ?? null,
    messageTemplate: optional(env.MESSAGE_TEMPLATE) ?? DEFAULT_MESSAGE_TEMPLATE,
    summaryTemplate: optional(env.SUMMARY_TEMPLATE) ?? DEFAULT_SUMMARY_TEMPLATE,
    payloadTemplate,
    maxMessagesPerPoll: Number.isFinite(max) && max > 0 ? max : 5,
    announceExisting: truthy(env.ANNOUNCE_EXISTING),
  };
}
