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
  ":tada: *{name}* just signed up for *{event}*! That's *{count}* sign-ups so far.";
export const DEFAULT_SUMMARY_TEMPLATE =
  ":tada: *{new_count}* more people signed up for *{event}*! That's *{count}* sign-ups so far.";

export class ConfigError extends Error {}

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
  if (env.SLACK_PAYLOAD_TEMPLATE?.trim()) {
    try {
      payloadTemplate = JSON.parse(env.SLACK_PAYLOAD_TEMPLATE);
    } catch (e) {
      throw new ConfigError(`SLACK_PAYLOAD_TEMPLATE is not valid JSON: ${(e as Error).message}`);
    }
  }

  const max = Number.parseInt(env.MAX_MESSAGES_PER_POLL ?? "", 10);

  return {
    attendBaseUrl: (env.ATTEND_BASE_URL?.trim() || "https://attend.hackclub.com").replace(/\/+$/, ""),
    seedToken,
    events,
    statuses: new Set(list(env.SIGNUP_STATUSES).map((s) => s.toLowerCase())),
    slackWebhookUrl,
    alertWebhookUrl: env.ALERT_WEBHOOK_URL?.trim() || null,
    messageTemplate: env.MESSAGE_TEMPLATE?.trim() || DEFAULT_MESSAGE_TEMPLATE,
    summaryTemplate: env.SUMMARY_TEMPLATE?.trim() || DEFAULT_SUMMARY_TEMPLATE,
    payloadTemplate,
    maxMessagesPerPoll: Number.isFinite(max) && max > 0 ? max : 5,
    announceExisting: truthy(env.ANNOUNCE_EXISTING),
  };
}
