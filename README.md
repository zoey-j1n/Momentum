# Momentum

Catch up on a Slack thread without reading it.

Run the **Catch up with Momentum** message shortcut on any thread. About a minute later, your dashboard shows what was discussed, what was decided, which action items are yours, and drafted follow-ups. Nothing is posted to Slack until you approve it, and when it is, it posts under your own name.

## How it works

1. You run the shortcut on a message in a thread. Slack sends the request to Momentum, which records it and replies right away.
2. A background job reads the thread, asks Claude for a summary, action items, and draft follow-ups, and saves the result.
3. You open the dashboard, edit a draft if you want, confirm who owns each action item, and click Approve & send.
4. Momentum posts the approved message to the thread, exactly once.

## Tech stack

- Next.js, React, TypeScript
- Postgres with Prisma 7, including a job queue in a Postgres table
- Claude via the Anthropic SDK (Haiku by default)
- Slack Web API and Sign in with Slack
- Notion API for meeting notes
- Vercel, Neon, and cron-job.org in production

## Run it locally

You need Node 22, Docker, a Slack workspace you can install apps in, and an Anthropic API key.

```bash
docker compose up -d        # Postgres
cp .env.example .env        # fill in the values
npm install
npx prisma migrate deploy
npm run dev                 # web app on http://localhost:3000
npm run worker              # background jobs, in a second terminal
npm run tunnel              # public URL so Slack can reach you
```

Then create a Slack app from `slack/manifest.json`, point its URLs at your tunnel, install it, and copy the tokens into `.env`. The variables are explained in `.env.example`.

To try it without Slack, set `SLACK_USE_FAKE_READER=1` and run `npx tsx scripts/enqueue-sample.ts`.

## Commands

```bash
npm run dev          # web app
npm run worker       # background jobs
npm test             # tests
npx prisma studio    # browse the database
```
