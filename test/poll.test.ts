import { describe, expect, it } from "vitest";
import { Poller } from "../src/poll";
import { config, FakeWorld, MemoryStore, person } from "./helpers";

const quiet = () => {};

function setup(overrides = {}) {
  const world = new FakeWorld();
  const store = new MemoryStore();
  const run = () => new Poller(config(overrides), store, world.fetch, quiet).run();
  return { world, store, run };
}

describe("polling", () => {
  it("records existing sign-ups silently on the first run, then announces new ones", async () => {
    const { world, run } = setup();
    world.roster = [person("Ada", "Lovelace"), person("Grace", "Hopper")];

    const first = await run();
    expect(first.events[0]).toMatchObject({ ok: true, count: 2, seeded: true, messagesSent: 0 });
    expect(world.slackMessages).toHaveLength(0);

    world.roster.push(person("Linus", "Torvalds"));
    const second = await run();
    expect(second.events[0]).toMatchObject({ ok: true, count: 3, newSignups: 1, messagesSent: 1 });
    expect(world.slackTexts).toEqual([
      ":tada: *Linus Torvalds* just signed up for *Scrapyard Sydney*! That's *3* sign-ups so far.",
    ]);

    await run();
    expect(world.slackMessages).toHaveLength(1);
  });

  it("can announce everyone on the first run", async () => {
    const { world, run } = setup({ ANNOUNCE_EXISTING: "true" });
    world.roster = [person("Ada", "Lovelace"), person("Grace", "Hopper")];
    await run();
    expect(world.slackTexts.map((t) => t.match(/\*(\d+)\* sign-ups/)?.[1])).toEqual(["1", "2"]);
  });

  it("counts only the configured statuses", async () => {
    const { world, run } = setup({ SIGNUP_STATUSES: "complete" });
    world.roster = [person("Ada", "Lovelace")];
    await run();

    world.roster.push(person("Grace", "Hopper", { status: "invited" }));
    await run();
    expect(world.slackMessages).toHaveLength(0);

    world.roster[1]!.status = "complete";
    await run();
    expect(world.slackTexts).toEqual([
      ":tada: *Grace Hopper* just signed up for *Scrapyard Sydney*! That's *2* sign-ups so far.",
    ]);
  });

  it("summarizes bursts beyond the per-poll limit", async () => {
    const { world, run } = setup({ MAX_MESSAGES_PER_POLL: "3" });
    await run();
    world.roster = ["A", "B", "C", "D", "E", "F"].map((n) => person(n, "Test"));
    await run();
    expect(world.slackTexts).toEqual([
      ":tada: *A Test* just signed up for *Scrapyard Sydney*! That's *1* sign-ups so far.",
      ":tada: *B Test* just signed up for *Scrapyard Sydney*! That's *2* sign-ups so far.",
      ":tada: *4* more people signed up for *Scrapyard Sydney*! That's *6* sign-ups so far.",
    ]);
  });

  it("retries people whose message failed to send", async () => {
    const { world, run } = setup();
    await run();
    world.roster = [person("Ada", "Lovelace")];
    world.slackStatus = 500;
    const failed = await run();
    expect(failed.events[0]).toMatchObject({ ok: false });

    world.slackStatus = 200;
    await run();
    expect(world.slackTexts).toHaveLength(1);
    expect(world.slackTexts[0]).toContain("Ada Lovelace");
  });

  it("doesn't announce the same person twice when their email changes case", async () => {
    const { world, run } = setup();
    world.roster = [person("Ada", "Lovelace")];
    await run();
    world.roster = [person("Ada", "Lovelace", { email: "ADA@example.com" })];
    await run();
    expect(world.slackMessages).toHaveLength(0);
  });

  it("escapes Slack control sequences in names", async () => {
    const { world, run } = setup();
    await run();
    world.roster = [person("<!channel>", "& co")];
    await run();
    expect(world.slackTexts[0]).toContain("*&lt;!channel&gt; &amp; co*");
  });

  it("stores no emails", async () => {
    const { world, store, run } = setup();
    world.roster = [person("Ada", "Lovelace")];
    await run();
    expect(JSON.stringify([...store.seen.values()].map((s) => [...s]))).not.toContain("example.com");
  });
});

describe("token rotation", () => {
  it("rotates when Attend recommends it and keeps using the new token", async () => {
    const { world, store, run } = setup();
    world.recommendRefresh = true;

    const report = await run();
    expect(report.tokenRefreshed).toBe(true);
    expect(world.refreshCalls).toBe(1);
    expect(world.validTokens.has("seed-token")).toBe(false);
    expect((await store.loadToken())?.token).toBe("rotated-1");

    const next = await run();
    expect(next.events[0]?.ok).toBe(true);
    expect(next.tokenRefreshed).toBe(false);
    expect(world.refreshCalls).toBe(1);
  });

  it("rotates proactively when the stored token is close to expiry", async () => {
    const { world, store, run } = setup();
    await run();
    const token = (await store.loadToken())!;
    await store.saveToken({ ...token, expiresAt: new Date(Date.now() + 864e5).toISOString() });

    const report = await run();
    expect(report.tokenRefreshed).toBe(true);
  });

  it("alerts once when the token is rejected, and recovers when a new secret is set", async () => {
    const { world, store } = setup();
    const poll = (token: string) => new Poller(config({ ATTEND_TOKEN: token }), store, world.fetch, quiet).run();

    await poll("seed-token");
    world.validTokens.clear();

    const failed = await poll("seed-token");
    expect(failed.error).toMatch(/rejected/);
    await poll("seed-token");
    expect(world.slackTexts).toHaveLength(1);
    expect(world.slackTexts[0]).toMatch(/stopped/);

    world.validTokens.add("fresh-token");
    const recovered = await poll("fresh-token");
    expect(recovered.adoptedNewToken).toBe(true);
    expect(recovered.events[0]?.ok).toBe(true);
    expect(world.slackTexts[1]).toMatch(/working again/);
  });
});
