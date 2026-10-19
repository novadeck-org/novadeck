I looked through how sessions are handled today. Tokens are minted in `server/auth.ts` and checked separately in three route files, each with slightly different expiry handling, which is why the mobile client sometimes logs out early.

I'd like to move all of it behind one `verifySession` helper and have every route call that. The helper would refresh tokens that are within five minutes of expiring, so the mobile client stops seeing sudden logouts.

This touches `server/routes/account.ts`, `server/routes/billing.ts` and `server/routes/admin.ts`. I won't change the token format, so existing sessions keep working. I'll add tests for the refresh window before changing the routes.

One open question: admin routes currently accept tokens for up to 24 hours. Should they follow the same rule, or keep a shorter window?
