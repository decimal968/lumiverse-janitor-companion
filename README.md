# JanitorAI Companion for Lumiverse

Frontend-only Spindle extension, no build step (`frontend.js` is the source).

- **Browse tab** – opens JanitorAI in its own window/tab and shows your Lumiverse address to paste into JAI Exporter 0.8.0 (Setup → Lumiverse → Set up Lumiverse…).
- **Imports tab** – lists characters sent by JAI Exporter (it posts a message into this page after importing) and lets you drop `.charx` / `.json` files manually. A **Chat** button opens each character.

JanitorAI itself can't be embedded in Lumiverse (Spindle blocks iframes), so it opens separately; the exporter does the transfer.
