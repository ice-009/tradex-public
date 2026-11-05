# Security

Tradex runs on your own machine and stores broker credentials in your local `.env` and SQLite database. If you find a way those could leak (a route that exposes a token, a missing auth check, an injection), please report it privately:

- Use GitHub's **Report a vulnerability** button on the repository's Security tab (private advisory), or
- contact the maintainers through their GitHub profile.

Please include steps to reproduce. We'll acknowledge the report and coordinate a fix before anything is disclosed.

## Keeping your own setup safe

- Never commit `.env`, `*.db` or `.cache/`. They're git-ignored by default.
- The Fyers TOTP secret and PIN in `.env` can log in to your trading account. Treat them like your password, and revoke the API app in the Fyers dashboard if they ever leak.
- Tradex doesn't place orders, but a Fyers access token can. Don't expose a running instance to the internet without putting it behind your own authentication and HTTPS.
