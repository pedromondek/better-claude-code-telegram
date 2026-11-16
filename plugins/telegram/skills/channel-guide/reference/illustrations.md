# Visual ideas on Telegram

The channel instructions say whether illustrations are on and whether each one is checked before sending. With illustrations off, describe the idea in words and offer a screenshot only when the user asks for one.

## When

- Every visual idea goes to the user before it is built: a new screen, a layout change, a loading state, a toast, the timing of an animation, a change of state.
- Show it on screenshots of the real app (or of a mock of it), never as a description alone.

## The board

- One image compares today with each proposal: a "Today" section, then one section per proposal, (a), (b), (c), each with one sentence on its effect.
- Each section shows the states that matter (closed, hovered, open), a 2x close-up when the element is small, and a label above each card.
- A red outline (#e11d48, 4 px, drawn in the page) marks the affected area in every state, today and in each proposal.
- The options live in the image: the question and its buttons name them by letter, without describing them again.

## The capture script

The page capture named in SKILL.md takes a spec file, opens the page in the Chromium of Playwright, writes the files and prints one path per line. Write the spec and the captures in the scratchpad.

```json
{
  "url": "http://localhost:3000/settings",
  "out": "shots",
  "width": 1280,
  "height": 800,
  "scale": 2,
  "shots": [
    { "name": "today-closed", "outline": "#menu", "clip": "header" },
    { "name": "today-open", "steps": [{ "click": "#menu" }, { "wait": 300 }], "outline": ".dropdown" },
    { "name": "a-closed", "css": ".search { display: block }", "outline": ".search", "clip": "header" }
  ],
  "videos": [
    { "name": "a-open", "css": ".search { display: block }", "steps": [{ "click": ".search" }], "outline": ".search", "clip": "header", "seconds": 2 }
  ],
  "board": {
    "name": "board",
    "title": "Search in the header",
    "context": "Today the search hides inside the menu.",
    "sections": [
      { "heading": "Today", "cards": [{ "shot": "today-closed", "label": "Closed" }, { "shot": "today-open", "label": "Open" }] },
      { "heading": "(a) Fixed search", "effect": "The search is always in view.", "cards": [{ "shot": "a-closed", "label": "Closed", "caption": "New field" }] }
    ]
  }
}
```

- `url`: a URL, or an HTML file relative to the spec. A shot may have its own `url`, such as the mock of a proposal.
- `css`: mocks a proposal on the real page without touching its code.
- `steps`: `click`, `hover`, `wait` (ms) and `script` (JavaScript run in the page), in order, before the outline.
- `outline`: one selector or a list. `clip` crops to one element with a margin, `fullPage` takes the whole page, and without both the visible part is taken.
- `width`, `height` and `scale` default to 1280, 800 and 2. A capture taller than 2560 px at its scale is split into numbered parts (`name-1.png`, `name-2.png`).
- `board` writes `<name>.png` from the shots, in the order of its sections.

## Movement

- A transition changes size and content, and every change of state in a proposal is animated.
- With illustrations that include video, movement goes as a video: a `videos` entry records half a second of the state before, then its steps, and writes an H.264 MP4 and a sheet of 6 frames (`<name>-sheet.png`). It needs ffmpeg.
- With prints only, show the states in sequence on the board.

## Before sending

When the instructions ask to check each one, open every PNG and every sheet first:

- the outline is on the right element;
- nothing is cut;
- the sheet shows the movement, with no frozen or blank frames;
- no personal data and no secret is on the screen (an account, an e-mail, a token). Retake with a test account, or hide it with `css`.

A secret never goes on a screenshot, checked or not.
