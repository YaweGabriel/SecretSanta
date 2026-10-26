# Secret Santa

Collect up to 30 names first. Matching happens later. No accounts — each person uses a name and a 4-digit PIN. Built for phones.

Data lives in [Supabase](https://mfkvitmdctpcqrkdfsrj.supabase.co).

## Setup

1. Copy `.env.example` to `.env`.
2. In the Supabase project, open **Project Settings > API** and paste the **service role** key into `SUPABASE_SERVICE_ROLE_KEY`.
3. Set `ADMIN_SECRET` (used to draw names and reset).
4. In the Supabase **SQL Editor**, run [`supabase/migrations/20261026100000_init_secret_santa.sql`](supabase/migrations/20261026100000_init_secret_santa.sql).
5. Install and start:

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## How it works

- People join from the **Join** tab.
- When everyone is in, the host opens **Host**, enters the secret, and taps **Draw names**. Each person is assigned someone else to buy for.
- People open **Match**, enter the same name and PIN, and see who they got.

## Environment

| Variable | Meaning |
| --- | --- |
| `SUPABASE_URL` | Project URL (`https://mfkvitmdctpcqrkdfsrj.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only secret. Never put this in the browser. |
| `ADMIN_SECRET` | Host password for draw and reset |
| `PORT` | Server port (default `3000`) |
| `ALLOWED_IPS` | Comma-separated IPs. Empty means allow everyone. |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy |
