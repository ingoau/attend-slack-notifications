import type { Config } from "./config";
import type { RosterEntry } from "./attend";

/** Placeholder values. Every value is already safe to drop into Slack mrkdwn. */
export type Vars = Record<string, string>;

/**
 * Escapes the characters Slack treats as control sequences, so a participant named
 * `<!channel>` can't ping the whole channel and `<https://evil|click me>` stays text.
 */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Replaces `{key}` with `vars[key]`. Unknown keys are left as written. */
export function render(template: string, vars: Vars): string {
  return template.replace(/\{([a-z_]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] ?? "") : match,
  );
}

/** Renders every string inside a parsed JSON value. */
export function renderDeep(value: unknown, vars: Vars): unknown {
  if (typeof value === "string") return render(value, vars);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, vars)]));
  }
  return value;
}

export interface EventInfo {
  id: string;
  name: string;
  slug: string;
}

const SLACK_ID = /^[UW][A-Z0-9]{2,}$/;

/** Every placeholder a template can use, blank where it doesn't apply. */
function baseVars(event: EventInfo, count: number, attendBaseUrl: string): Vars {
  return {
    name: "",
    first_name: "",
    last_name: "",
    email: "",
    status: "",
    slack_id: "",
    mention: "",
    count: String(count),
    new_count: "",
    event: escapeSlack(event.name),
    event_slug: escapeSlack(event.slug),
    event_id: escapeSlack(event.id),
    event_url: `${attendBaseUrl}/admin/${encodeURIComponent(event.slug)}`,
  };
}

export function displayName(p: RosterEntry): string {
  const name = [p.first_name, p.last_name].map((s) => s?.trim()).filter(Boolean).join(" ");
  return name || "Someone";
}

export function signupVars(p: RosterEntry, event: EventInfo, count: number, attendBaseUrl: string): Vars {
  const name = escapeSlack(displayName(p));
  const slackId = p.slack_user_id && SLACK_ID.test(p.slack_user_id) ? p.slack_user_id : "";
  return {
    ...baseVars(event, count, attendBaseUrl),
    name,
    first_name: escapeSlack(p.first_name?.trim() || displayName(p)),
    last_name: escapeSlack(p.last_name?.trim() ?? ""),
    email: escapeSlack(p.email ?? ""),
    status: escapeSlack(p.status ?? ""),
    slack_id: slackId,
    mention: slackId ? `<@${slackId}>` : name,
  };
}

export function summaryVars(newCount: number, event: EventInfo, count: number, attendBaseUrl: string): Vars {
  return {
    ...baseVars(event, count, attendBaseUrl),
    new_count: String(newCount),
  };
}

/**
 * Builds the webhook body. With SLACK_PAYLOAD_TEMPLATE the whole JSON payload is templated
 * (and `{text}` is the rendered MESSAGE_TEMPLATE / SUMMARY_TEMPLATE); otherwise it's `{ text }`.
 */
export function buildPayload(config: Config, template: string, vars: Vars): unknown {
  const text = render(template, vars);
  if (config.payloadTemplate == null) return { text };
  return renderDeep(config.payloadTemplate, { ...vars, text });
}
