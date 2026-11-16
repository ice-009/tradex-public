# Security

Tradex runs on your own machine and keeps a Market Data Hub API key in your local `.env`, and your account and trade journal in its SQLite database. If you find a way those could leak (a route that exposes a token, a missing auth check, an injection), please report it privately:

- Use GitHub's **Report a vulnerability** button on the repository's Security tab (private advisory), or
- contact the maintainers through their GitHub profile.

Please include steps to reproduce. We'll acknowledge the report and coordinate a fix before anything is disclosed.

## Keeping your own setup safe

- Never commit `.env`, `*.db` or `.cache/`. They're git-ignored by default.
- `HUB_KEY` in `.env` reads market data from your hub. Treat it like a password, and revoke it on the hub (`npm run hub -- keys …`) if it ever leaks. Give Tradex a key with read scopes only (`history,live,fo`), never `admin`.
- Tradex holds no broker credentials and doesn't place orders (the hub owns the broker login). Still, don't expose a running instance to the internet without putting it behind your own authentication and HTTPS.
