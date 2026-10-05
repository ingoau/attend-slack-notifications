import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config";
import { buildPayload, render, signupVars, summaryVars } from "../src/message";
import { config, person } from "./helpers";

const event = { id: "evt_1", name: "Scrapyard <Sydney>", slug: "scrapyard" };

describe("templates", () => {
  it("fills placeholders and leaves unknown ones alone", () => {
    expect(render("{name} {nope} {count}", { name: "Ada", count: "3" })).toBe("Ada {nope} 3");
  });

  it("offers every documented placeholder", () => {
    const vars = signupVars(person("Ada", "Lovelace", { slack_user_id: "U012ABC" }), event, 7, "https://attend.test");
    expect(vars).toMatchObject({
      name: "Ada Lovelace",
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
      status: "complete",
      slack_id: "U012ABC",
      mention: "<@U012ABC>",
      count: "7",
      event: "Scrapyard &lt;Sydney&gt;",
      event_slug: "scrapyard",
      event_id: "evt_1",
      event_url: "https://attend.test/admin/scrapyard",
    });
  });

  it("falls back to the name when there's no valid Slack ID", () => {
    const vars = signupVars(person("Ada", "Lovelace", { slack_user_id: "<!here>" }), event, 1, "https://attend.test");
    expect(vars.mention).toBe("Ada Lovelace");
    expect(vars.slack_id).toBe("");
  });

  it("templates a full JSON payload, with {text} as the rendered message", () => {
    const cfg = config({
      MESSAGE_TEMPLATE: "{name} joined",
      SLACK_PAYLOAD_TEMPLATE: JSON.stringify({
        text: "{text}",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "*{name}* is #{count}" } }],
      }),
    });
    const payload = buildPayload(cfg, cfg.messageTemplate, signupVars(person("Ada", "L"), event, 5, "x"));
    expect(payload).toEqual({
      text: "Ada L joined",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Ada L* is #5" } }],
    });
  });

  it("renders the summary message", () => {
    const cfg = config();
    expect(buildPayload(cfg, cfg.summaryTemplate, summaryVars(4, event, 10, "x"))).toEqual({
      text: ":tada: *4* more people signed up for *Scrapyard &lt;Sydney&gt;*! That's *10* sign-ups so far.",
    });
  });
});

describe("config", () => {
  it("names every missing required setting", () => {
    expect(() => config({ ATTEND_TOKEN: "", SLACK_WEBHOOK_URL: " ", ATTEND_EVENT: "" })).toThrow(
      new ConfigError("Missing required setting(s): ATTEND_TOKEN, SLACK_WEBHOOK_URL, ATTEND_EVENT"),
    );
  });

  it("rejects an invalid payload template", () => {
    expect(() => config({ SLACK_PAYLOAD_TEMPLATE: "{nope" })).toThrow(/not valid JSON/);
  });

  it("parses lists and defaults", () => {
    const cfg = config({ ATTEND_EVENT: "a, b,,", SIGNUP_STATUSES: "Complete, in_progress", ATTEND_BASE_URL: "" });
    expect(cfg.events).toEqual(["a", "b"]);
    expect([...cfg.statuses]).toEqual(["complete", "in_progress"]);
    expect(cfg.attendBaseUrl).toBe("https://attend.hackclub.com");
    expect(cfg.maxMessagesPerPoll).toBe(5);
  });
});
