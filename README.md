# Deck — site

The page for Deck: what is due, what is coming, and which email needs you.

This repository holds **only the page's code**. It contains no tasks, no email
and no credentials. The data lives in a separate private repository; the page
reads it in your browser using an access key that you paste in once per device
and that is stored only in that browser.

- Try it with sample data: open the site with `?demo` on the end of the address.
- No build step and no dependencies. `index.html` loads plain ES modules.
- `npm test` runs the logic tests (Node 22+).

| File | What it does |
|---|---|
| `app.js` | Draws the page and turns taps into operations |
| `model.js` | Turns the data files into what is on screen (pure, tested) |
| `ops.js` | Every change you can make, as a replayable operation (pure, tested) |
| `store.js` | Reads and saves through GitHub's API; offline queue; conflict replay |
| `capture-parse.js` | Understands "econ essay fri 5pm !high #econ" |
| `sw.js` | Lets the page open with no connection (network first, cache as fallback) |
