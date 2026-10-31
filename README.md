# JanitorAI Companion for Lumiverse

Frontend-only Spindle extension, no build step (`frontend.js` is the source).

- **Open beside Lumiverse** – opens janitorai.com in its own popup window on the right ~45% of your screen. It is a normal top-level window, so the JAI Exporter browser extension runs on it unchanged. (JanitorAI can't be iframed: Spindle blocks raw iframes, and the site is unlikely to allow framing anyway.)
- **Import exported cards** – drop the `.charx` / `.json` files JAI Exporter produces. The card is posted to Lumiverse's `/api/v1/characters/import` and the avatar to `/api/v1/characters/:id/avatar` (the same calls the Datacat extension makes). A **Chat** button appears after import.

Notes
- Gallery images inside a `.charx` and base64 `extensions.assets` are not imported (they would bloat the request); the row tells you how many were skipped.
- The exporter is a desktop Chrome/Edge extension; it won't run in a phone browser.
- Edit `github` / `homepage` in `spindle.json` to your repo URL before installing from Git.

Install: push these three files to a GitHub repo, then Lumiverse → Extensions → install from Git repository. No permissions are requested.
