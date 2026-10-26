# Secret Santa

Collect up to 30 names first. Matching happens later. No accounts. Built for phones.

Data lives in [Supabase](https://mfkvitmdctpcqrkdfsrj.supabase.co).

## Setup

1. Copy `.env.example` to `.env`.
2. Paste the project **anon** (publishable) key into `SUPABASE_ANON_KEY`.
3. Set `ADMIN_SECRET` if you will draw names from `/api/draw`.
4. `npm install` and `npm start`.

Open [http://localhost:3000](http://localhost:3000) and add names.

## Environment

| Variable | Meaning |
| --- | --- |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | Publishable/anon key |
| `ADMIN_SECRET` | Host secret for drawing and reset |
| `PORT` | Server port (default `3000`) |
