# Likeness

A word-chain puzzle. Travel from a starting word to a target word, one move at a time. Every move
costs one step — try to get there in as few as you can.

- **➕ Add a letter** anywhere in the previous word
- **➖ Delete a letter** anywhere in the previous word
- **🔁 Replace a letter** — swap any one letter for another
- **🔀 Anagram** — rearrange the same letters into a new word
- **🔄 Synonym** — swap to a word that means the same thing
- **🔊 Homophone** — swap to a word that sounds the same

When you finish, share an emoji trail of your journey and pass your target word to the next player
as their new start — the chain keeps going.

## Stack

- Pure static site: `index.html`, `styles.css`, `app.js`, `words.js`. No build step.
- Synonyms and homophones come from the
  [Datamuse API](https://www.datamuse.com/api/) (no API key required).
- Deployed via GitHub Pages from the `main` branch using
  `.github/workflows/pages.yml`.

## Local preview

Open `index.html` directly or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## GitHub Pages setup

1. Merge this branch into `main`.
2. In repo **Settings → Pages**, set **Source** to **GitHub Actions**.
3. The included workflow deploys on every push to `main`.

The site will be served at `https://<user>.github.io/likeness/`.

## URL parameters

- `?start=word` — start the next puzzle from `word` (used by share links).
- `?start=word&target=other` — share an exact puzzle.
