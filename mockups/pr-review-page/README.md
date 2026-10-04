# PR review page mockup

The agreed design for issue #273, built on PR #266. This branch is a reference and is never merged.

## Open it

Open `index.html` in a browser, or run `lavish-axi index.html` to review it the way users will. The page needs a network connection only for web fonts and the Mermaid script.

## Rebuild it

```sh
bun install
bun build.ts   # writes index.html, about 8 seconds
```

`build.ts` reads `pr266.patch` and runs `git show` for each changed file at the PR head (`9b0411b`) and the merge base, so the repository must have that history (`git fetch origin`).

## What is real and what is invented

| Real, from PR #266 | Invented for the mockup |
| --- | --- |
| Title, author, commit, and description | Tandem's verdict line |
| The diff and every file's contents | The three draft comments (`c1` to `c3`) and their concerns |
| Line numbers, including expanded lines | The "Overall concerns" entry |
| | The diagram, the tour's chapters, and its 11 stops |

The invented parts stand in for what the reviewer will produce once its output gains a tour (see #273).

## Where things are in `build.ts`

- `parsePatch`: unified diff to rows with old and new line numbers.
- `drafts`, `concerns`, `diagram`, `chapters`, `tour`: the stand-in reviewer output. Tour stops find their lines by text with `stepAt`, so they survive small edits.
- Shiki setup (`createHighlighter`, `TOKEN_CLASS`): highlighting at build time with one-letter token classes.
- `gapRow`, `EXPAND_BUDGET`, `nearHtml`: hidden-line rows and the 40 lines embedded nearest each change.
- The `html` template: the page, its styles (the shared `src/pages/tandem.css` is inlined), and its script: tour, popovers, suggestions, the finish dialog, and the `window.lavish.queuePrompt` submission.

## Lavish notes

- Lavish annotates clicks on anything that isn't a native control. Links, diagram boxes, and line-number cells carry `data-lavish-action` so their clicks reach the page.
- Never give an element the `mermaid` class. Lavish turns it into an editable whiteboard. The diagram renders with `mermaid.render` into a plain container.
- With Lavish's chat open the page is about 800px wide. Check every layout change at that width.
