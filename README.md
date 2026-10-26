# Secret Santa

A local web app for up to 30 people. No accounts. Each person joins with a name and a 4-digit PIN. If someone is already waiting, they are paired at random; otherwise they wait for the next person. Look up the same name and PIN later to see who you got.

## Run

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Environment

| Variable | Meaning |
| --- | --- |
| `PORT` | Server port (default `3000`) |
| `ALLOWED_IPS` | Comma-separated IPs. Empty means allow everyone. |
| `TRUST_PROXY` | Set to `1` if you are behind a reverse proxy and want `X-Forwarded-For` used for the allowlist. |
| `ADMIN_SECRET` | Required to reset the event. If unset, reset is disabled. |

Reset the draw:

```bash
curl -X POST http://localhost:3000/api/reset -H "x-admin-secret: YOUR_SECRET"
```

Pairings are stored in `data/event.json` (gitignored).
