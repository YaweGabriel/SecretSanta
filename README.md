# Secret Santa

Create a Secret Santa basket with a host email and 4-digit PIN, choose a participant limit from 2 to 50, then share its short invite link. The host is not included in that limit. Guests join with their own name, and the host launches only after every place is filled. Each participant gets one match.

The basket URL is stored with the host details in Supabase. Set `PUBLIC_APP_URL` in production so stored links use the canonical public domain.

No accounts are required. Built for phones.

Run `npm run load:baskets` for a local concurrency check. It uses a mocked Supabase endpoint and does not create baskets in the linked database.

