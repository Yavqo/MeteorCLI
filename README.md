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

### Work on any folder with @

```text
› fix the failing tests in @~/code/api
+ ~/code/api added to your workspace
› what does @src/auth.ts do?
+ src/auth.ts attached
```

- `@folder` adds the folder to your **workspace** and shows the AI its layout. `@file` attaches the file's contents. Tab completes paths. Write spaces as `\ ` (Tab does this for you) or quote the path: `@"~/My Folder"`.
- Sunlight can read and change files inside your workspace folders: the folder you started in, plus any you added with `@`, `/add` or `--add-dir`. Anything **outside** them asks every time. That includes reads, and "always" doesn't apply. A symlink pointing outside doesn't count as inside.
- `/undo` puts back every file the last request changed, and deletes files it created. Commands the AI ran can't be undone, and Sunlight tells you when a request ran any.

### Also

- **Tools:** read, list, find files, search, write, edit, run commands (in any workspace folder), fetch URLs. Changing files, running commands and network access ask first (`y` / `n` / `a` for always). `-y` approves everything.
- **Input:** pasted text is sent as one message. End a line with `\` to keep typing on the next line.
- **Replies** render markdown: bold, inline code, headings, bullets, and code blocks with a gutter. Piped output (`-p`) stays plain markdown.
- **Long sessions** drop old tool output to stay under the size limit, and tell you once when they do. `/clear` starts fresh but keeps your folders.
- **Commands:** `/add <folder>`, `/folders`, `/undo`, `/usage`, `/clear`, `/yes`, `/help`, `/exit`.
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

