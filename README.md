# WARDOGS leaderboard on GitHub

A leaderboard for the Adria/Balkan [GGG] Official WARDOGS server that runs
entirely on GitHub, for free. No PC or server of your own has to stay on.

- **GitHub Actions** runs `scripts/update.mjs` every 20 minutes. It reads the
  player list from the server's RCON API and adds every finished match to each
  player's totals (20 kills in one match + 10 in the next = 30).
- **GitHub Pages** shows `docs/index.html`, which reads the stats files the
  script saves in `docs/data/`.

The RCON password is stored as a GitHub secret. It is never in the code or on
the page.

## Setup (once, about 10 minutes)

1. **Create a repository** on github.com, for example `wardogs-stats`.
   Make it **public** (GitHub Pages is free for public repos).

2. **Upload these files** keeping the folders:
   ```
   .github/workflows/update-stats.yml
   scripts/update.mjs
   docs/index.html
   README.md
   ```
   On the repo page: *Add file > Upload files*, then drag the whole folder in.
   The `.github` folder is hidden on Windows; if it does not upload, create
   the file by hand with *Add file > Create new file* and the name
   `.github/workflows/update-stats.yml`, then paste the contents.

3. **Add the password**: *Settings > Secrets and variables > Actions >
   New repository secret*
   - Name: `WARDOGS_PASSWORD`
   - Value: your RCON password

   Optional, on the *Variables* tab of the same page (only if they differ
   from the defaults): `WARDOGS_HOST` (default `165.217.136.30`),
   `WARDOGS_PORT` (default `9001`), `WARDOGS_TITLE`.

4. **Turn on the page**: *Settings > Pages > Build and deployment*
   - Source: *Deploy from a branch*
   - Branch: `main`, folder `/docs`, then *Save*.

5. **Run the first update**: *Actions* tab > *Update WARDOGS stats* >
   *Run workflow*. If GitHub asks you to enable workflows, click the button.

After a minute or two the page is live at
`https://<your-github-name>.github.io/<repo-name>/`.

## How it behaves

- The **Leaderboard** stays empty until the first match ends. The
  **Current match** tab shows the match being tracked.
- A match is counted when the next one starts: map change, server restart,
  match clock reset, or the scoreboard resetting on the same map.
- Players who leave keep the stats they had at the last update before they
  left. Because updates are 20 minutes apart, kills made after the last update
  of a match (or by someone who joins and leaves between two updates) are not
  counted.
- GitHub often starts scheduled runs a few minutes late. That is normal.

## Useful actions

- **Update now**: Actions > Update WARDOGS stats > Run workflow.
- **Count the current match immediately**: same button, tick *Count the current
  match now*.
- **Change the interval**: edit the `cron:` line in
  `.github/workflows/update-stats.yml`. `"7,27,47 * * * *"` is every 20 min;
  `"7,37 * * * *"` would be every 30 min. GitHub does not allow less than 5.
- **See errors**: Actions tab, open a run. A wrong password makes the run fail
  (red), so you notice it.
- **Back up the stats**: everything is in `docs/data/` and in the git history.
  `totals.json` holds every player's all-time totals.

## Keep in mind

- GitHub disables scheduled workflows in a public repo after 60 days with no
  activity. The script's own commits should count as activity, but check the
  Actions tab now and then. If it says the workflow was disabled, click
  *Enable workflow*.
- RCON uses plain HTTP, so the password travels unencrypted between GitHub
  and the game server. This is how the WARDOGS RCON API works with any tool.
- The stats files are public in the repo (names, Steam IDs, kills, deaths,
  cash); they contain no password.
