# Sunlight CLI

An AI coding agent for your terminal, powered by Yavqo AIHub. Users sign in with their Yavqo account. Nobody brings an API key.

## Install

```bash
curl -fsSL https://meteorcli.yavqo.com/install.sh | sh
```

Needs macOS or Linux with Node.js 20 or newer. It installs into `~/.sunlight` and `~/.local/bin`, with no sudo, and checks the download's SHA-256 before installing anything. Run the same command again to update.

## Use

```bash
sunlight login      # email and password of your Yavqo account
sunlight            # start a session
sunlight -p "explain this repo"
sunlight whoami     # account and token use
sunlight logout
```

- **Tools:** read, list, search, write, edit, run commands, fetch URLs. Anything that changes files, runs a command or uses the network asks first (`y` / `n` / `a` for always). `-y` approves everything.
- **Project notes:** put instructions in `SUNLIGHT.md` and Sunlight reads them at the start of each session.
- **Session:** `~/.sunlight/auth.json` (mode 600) holds the Supabase session. The password is never stored.

## How it works

```
sunlight CLI ──(Supabase session token)──▶ sunlight-chat Edge Function ──(AIHUB_API_KEY)──▶ AIHub deployment
                                              │ verifies the user, checks quota,
                                              │ forces the model and limits, records tokens
                                              ▼
                                      public.meteor_quotas
```

The AIHub key exists only as a secret on the Edge Function. The CLI contains the project URL and the publishable key, which are public by design.

Quota reuses the Meteor budget in `public.meteor_quotas`: a 5 hour window, 10,000,000 tokens by default, with a per-user `token_limit` override. Sunlight and Meteor draw from the same budget.

AIHub's chat API has no native tool-calling field, so tools travel as `<tool_call>` / `<tool_result>` text (see `src/protocol.ts`).

## Deploying the backend (once)

1. Apply `supabase/migrations/20261022000000_sunlight_cli_quota.sql` to the `yavqo` project.
2. Set the secret. Use a key from the AIHub project that owns the deployment:
   ```bash
   supabase secrets set AIHUB_API_KEY=yavqo_live_... --project-ref ikjugnimawkoatkbvpgk
   ```
   Optional: `AIHUB_DEPLOYMENT` (default `sunlighty-5cd7e4`), `AIHUB_BASE_URL`.
3. Deploy the function:
   ```bash
   supabase functions deploy sunlight-chat --project-ref ikjugnimawkoatkbvpgk
   ```

## Publishing a release

`https://meteorcli.yavqo.com` is a Vercel project built from this repo. `vercel.json` makes Vercel run `npm run release` and serve the `release/` folder: `install.sh`, `latest` (version, file name and SHA-256) and `sunlight-cli-<version>.tgz`.

To ship a new version: bump `version` in `package.json` and push to `main`. Vercel rebuilds and the install command picks it up within a minute.

One-time setup: import the repo in Vercel (framework preset "Other", the settings come from `vercel.json`), add the domain `meteorcli.yavqo.com` to the project, and point a `CNAME` for `meteorcli` at `cname.vercel-dns.com`. To host somewhere else, change the default `BASE_URL` at the top of `scripts/install.sh`. `npm run release` builds the same folder locally.

## Tests

```bash
npm test
```

Runs the CLI against a mock Yavqo (Supabase Auth plus the Sunlight API), the proxy's request handling with fake dependencies, and the installer against a local release server (bad checksum, cut-off download, hostile manifest, missing Node).

