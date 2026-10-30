# Hyperframes Composition Brief: Prismagram

## Objective
Create a short launch-style intro video for Prismagram.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 22 seconds (see "Timing as built" in brag-plan.md)

## Source Material
- Project root: `/home/kingvic/Documents/Prismagram`
- Primary files read: `desktop/src/index.html`, `desktop/src/styles.css`, `desktop/src/js/client.js`,
  `desktop/src/js/render.js` (diagram theme), `desktop/src/js/writes.js`, `README.md`, `site/index.html`
- Product name: Prismagram
- Tagline / strongest claim: "Your Prisma schema as a class diagram." + every write shows the SQL it runs
- Key UI to recreate: the dark editor with Prisma syntax colors; UML class boxes with green
  headers on the dotted canvas; the segmented Diagram / Data switch; the Data sidebar with row
  counts; the "Edit row" dialog with its "Runs" SQL preview; the "Row updated" toast.
- Copy that must appear verbatim:
  - "You wrote a schema."
  - "Prismagram draws it." / "Live, as you type."
  - "Then open the data."
  - "Every button shows its SQL."
  - `UPDATE "public"."users" SET "name" = 'Ada King' WHERE "id" = '…';`
  - "kingvic300.github.io/Prismagram"

## Creative Direction
- Tone preset: app-store
- Creative direction: crisp dev-tool launch film, dark UI, one blue accent
- Interpretation: clean slides and wipes, each feature held long enough to read, real UI recreated
- Angle: schema in, diagram out, data right there, with the SQL shown before it runs
- Hook: Prisma model typing itself in the dark editor under "You wrote a schema."
- Outro: logo, "Prismagram", "Prisma diagrams + your Postgres & MongoDB data", URL
- Avoid: generic SaaS language, abstract filler, redesigning the product's look

## Visual Identity
- Background: #0e0f11 (panels #141518, #1a1b1f, raised #212227)
- Text: #ededf0 (secondary #a5a6ae, muted #82838c)
- Accent: #5c9eff (solid buttons #3b6fe0), OK green #5fd39a
- Diagram: canvas #f4f5f4, dots #dde2dd, header #d5e8d4, stroke #2b2b2b
- Display font: Inter (bundled woff2); code font: JetBrains Mono (bundled woff2)
- Logo: `desktop/src/logo.svg`

## Storyboard
Contract: `brag-output/brag-plan.md`.
1. Hook: the schema — 0–3.7s — editor types a `model Post` block; "You wrote a schema."
2. Reveal: the diagram — 3.7–9.0s — User, Post, Comment boxes pop in, connectors draw with `1`/`0..*`
3. Flip to Data — 9.0–13.0s — switch slides to Data; sidebar rows users 19 / posts 4.2k / comments 19k; doc cards
4. Edit with the SQL shown — 13.0–17.9s — Edit row dialog, "Lovelace" → "King", UPDATE preview, click, toast
5. Outro — 17.9–21.0s — logo, name, tagline, URL

## Audio
- Audio role: warm upbeat bed with light UI accents
- Music: `happy-beats-business-moves-vol-11-by-ende-dot-app.mp3`, fade out over the last ~1.5s
- Music cue guidance: preset `assets/music/cues/...vol-11...music-cues.md`; strong cues 3.70s
  (diagram), 8.96s (switch), 17.91s (logo); box pops on every other beat (4.23, 5.28, 6.34)
- Audio-reactive treatment: none (app-store restraint; readability of dense UI text comes first)
- SFX: key ticks on typing, soft drops on box pops and sidebar rows, a switch on the mode flip,
  a mouse click on Update, a light glass tick on the toast, a bell on the logo
- Audio files are copied into `composition/assets/`.
