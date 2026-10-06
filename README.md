# attend-slack-notifications

A Cloudflare Worker that watches a [Hack Club Attend](https://github.com/hackclub/attend) event and
posts to Slack whenever someone new signs up, with the running total:

> new signup :yay:<br>
> total signups: 42

- Polls Attend every 5 minutes using a **mobile token**, and **rotates the token automatically**
  before it expires, so it keeps working indefinitely.
- Messages are fully configurable with environment variables, up to complete Block Kit payloads.
- Free-plan friendly: one cron trigger and one SQLite-backed Durable Object. Nothing to provision.
- Stores no personal data: people are remembered only as truncated SHA-256 hashes.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ingoau/attend-slack-notifications)

## Setup

### 1. Get the two secrets

**An Attend mobile token.** The easiest way is [BetterAttend](https://github.com/ingoau/better-attend):
**Settings → Developer → Copy a new mobile token**. That runs a separate Hack Club sign-in and copies
a brand-new token, independent of the app's own session (give it a name like "Slack notifications"
so you can recognise it in Attend's device list). The account needs to be able to view participants
for the event (event admin, ops, limited or safeguarding lead, a series member, or a global admin).

**A Slack incoming webhook URL.** Create a Slack app (or use an existing one), enable
[Incoming Webhooks](https://api.slack.com/messaging/webhooks), and add a webhook for the channel you
want. It looks like `https://hooks.slack.com/services/T…/B…/…`.

### 2. Deploy

Nothing in the repo needs editing: every setting, credentials included, is stored on Cloudflare
(secrets are encrypted there and never touch git). Pick one of these:

**With Wrangler, from a plain clone** (no fork, no GitHub account needed):

```sh
git clone https://github.com/ingoau/attend-slack-notifications
cd attend-slack-notifications
npm install
npx wrangler login

npx wrangler deploy                        # creates the worker
npx wrangler secret put ATTEND_TOKEN       # each one prompts for the value
npx wrangler secret put SLACK_WEBHOOK_URL
npx wrangler secret put ATTEND_EVENT       # the slug from attend.hackclub.com/admin/<slug>
npx wrangler secret put ADMIN_KEY          # optional, enables /status, /poll, /test, /reset
```

Settings take effect immediately, with no redeploy. To update later: `git pull && npx wrangler deploy`.
Your settings are kept.

**From the Cloudflare dashboard, building straight from GitHub:** Workers & Pages → Create →
Import a repository → pick this repo. Then add the settings under the
worker's **Settings → Variables and Secrets**. Cloudflare redeploys on every push, and settings
added in the dashboard survive redeploys (`keep_vars` in `wrangler.jsonc`).

**One click:** the **Deploy to Cloudflare** button above copies this repo into your GitHub account,
asks for each setting, and deploys. It also asks for `MESSAGE_TEMPLATE` and `SUMMARY_TEMPLATE`:
leave them blank for the default messages, or write your own using the [placeholders](#placeholders).

On its first run the worker quietly records everyone already signed up, so you won't get a flood of
messages for existing sign-ups. Every person who appears after that gets announced.

## Configuration

Set each of these with `npx wrangler secret put <NAME>`, or in the Cloudflare dashboard under the
worker's **Settings → Variables and Secrets** (as a secret or a plain-text variable; the worker reads
both the same way). Use a secret for anything sensitive. Changes apply on the next poll, with no
redeploy needed.

| Name | Default | What it does |
| --- | --- | --- |
| `ATTEND_TOKEN` | **required** | Attend mobile token. Only used to start (see [Token rotation](#token-rotation)). |
| `SLACK_WEBHOOK_URL` | **required** | Where sign-ups are posted. |
| `ATTEND_EVENT` | **required** | Event slug or ID. Comma-separate to watch several events. |
| `MESSAGE_TEMPLATE` | `new signup :yay:` / `total signups: {count}` (two lines) | One message per new sign-up. |
| `SUMMARY_TEMPLATE` | `new signups :yay: x{new_count}` / `total signups: {count}` (two lines) | Used when more people signed up at once than `MAX_MESSAGES_PER_POLL`. |
| `SLACK_PAYLOAD_TEMPLATE` | – | A whole Slack message as JSON (e.g. Block Kit). See below. |
| `MAX_MESSAGES_PER_POLL` | `5` | Most messages sent per event per poll. Past this, the last message summarizes the rest. |
| `SIGNUP_STATUSES` | everyone on the roster | Comma-separated statuses that count as signed up, e.g. `complete` to only announce people who finished registering. Statuses: `invited`, `in_progress`, `awaiting_guardian`, `complete`. |
| `ANNOUNCE_EXISTING` | `false` | Announce everyone already signed up on the first run instead of recording them silently. |
| `ATTEND_BASE_URL` | `https://attend.hackclub.com` | For self-hosted Attend instances. |
| `ADMIN_KEY` | – | Enables the admin endpoints. |
| `ALERT_WEBHOOK_URL` | `SLACK_WEBHOOK_URL` | Where problems (expired token, inaccessible event) are reported. |

The poll interval is the cron in `wrangler.jsonc` → `triggers.crons` (every 5 minutes by default).

### What counts as a sign-up

The worker reads the event's roster (`GET /api/v1/events/:event/participants/roster`), which lists
everyone registered for the event except withdrawn and rejected participants. Anyone who appears there
for the first time (and matches `SIGNUP_STATUSES`, if set) is a new sign-up, and `{count}` is how many
people on the roster match. People who withdraw and come back aren't announced twice.

With `SIGNUP_STATUSES=complete`, people are announced when they finish registering rather than when
they're first invited, and `{count}` counts completed registrations.

### Placeholders

| Placeholder | Example |
| --- | --- |
| `{name}` | `Ada Lovelace` (preferred name, then last name) |
| `{first_name}`, `{last_name}` | `Ada`, `Lovelace` |
| `{mention}` | `<@U012ABC>` (a Slack mention) if Attend knows their Slack ID, otherwise their name |
| `{slack_id}` | `U012ABC`, or empty |
| `{email}` | `ada@example.com` |
| `{status}` | `invited`, `in_progress`, `awaiting_guardian` or `complete` |
| `{count}` | Total sign-ups including this person |
| `{new_count}` | (summary only) how many people the summary covers |
| `{event}`, `{event_slug}`, `{event_id}` | `Scrapyard Sydney`, `scrapyard`, … |
| `{event_url}` | `https://attend.hackclub.com/admin/scrapyard` |

Values from Attend are escaped, so a participant can't sneak `<!channel>` or links into your channel.

### Full payloads (Block Kit)

Set `SLACK_PAYLOAD_TEMPLATE` to a JSON Slack message. Every string in it is a template, and `{text}` is
the rendered `MESSAGE_TEMPLATE` / `SUMMARY_TEMPLATE` (handy for the notification fallback text):

```json
{
  "text": "{text}",
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "{text}" },
      "accessory": {
        "type": "button",
        "text": { "type": "plain_text", "text": "Open in Attend" },
        "url": "{event_url}"
      }
    }
  ]
}
```

The same payload template is used for single and summary messages; placeholders that don't apply
render as empty strings.

## Token rotation

Attend mobile tokens are valid for 14 days. In a token's last 3 days Attend adds
`X-Token-Refresh-Recommended: true` to responses, and the worker then calls
`POST /api/v1/session/refresh` for a new 14-day token. Attend **revokes the old token immediately**,
so the worker saves the new token in its Durable Object (strongly consistent storage) before doing
anything else, and polls are serialized so two can never rotate at once.

This means the `ATTEND_TOKEN` secret goes stale after the first rotation. That's expected: it's only
the starting point. The worker remembers which secret its current token came from, and **if you
change the `ATTEND_TOKEN` secret it switches to the new one**. So if the token is ever lost (the
worker was paused for over two weeks, the session was revoked in Attend, …) the worker posts an alert
to Slack once, and you fix it by issuing a new token and running `npx wrangler secret put ATTEND_TOKEN` (or updating it in the
dashboard).

## Admin endpoints

Set the `ADMIN_KEY` secret to enable these. Authenticate with `Authorization: Bearer <ADMIN_KEY>` or
`?key=<ADMIN_KEY>`. Without `ADMIN_KEY` they return 404.

| Endpoint | |
| --- | --- |
| `GET /status` | Last poll result, token expiry, and how many people are recorded per event. |
| `POST /poll` | Poll now instead of waiting for the cron. |
| `POST /test` | Send a sample message using your current templates, without touching Attend. |
| `POST /reset` | Forget who's been announced; the next poll records everyone again silently. |

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" https://attend-slack-notifications.<you>.workers.dev/test
```

Logs are in the Cloudflare dashboard (Workers → attend-slack-notifications → Logs), or live with
`npx wrangler tail`.

## Development

```sh
npm install
npm test            # unit tests (vitest), against a fake Attend + Slack
npm run typecheck
cp .dev.vars.example .dev.vars   # fill in secrets, then:
npm run dev         # wrangler dev; trigger a poll with curl localhost:8787/__scheduled
```

| File | |
| --- | --- |
| `src/index.ts` | Worker entry: cron trigger and admin endpoints |
| `src/poller.ts` | The Durable Object holding the token and the seen list |
| `src/poll.ts` | One poll: diff the roster, post to Slack, rotate the token, alerts |
| `src/attend.ts` | Attend API client and token rotation |
| `src/message.ts` | Templates and placeholders |
| `src/config.ts` | Environment variables |
