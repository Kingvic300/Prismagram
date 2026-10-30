# Brag Plan: Prismagram

## What is this app?
A desktop app that draws your `schema.prisma` as a UML class diagram while you type, and then
lets you browse, query and edit the real PostgreSQL, Supabase, Neon or MongoDB data behind it.

## The angle
"Schema in, diagram out, data right there." The product's trick is that the diagram is live:
type a model and a green-headed class box appears with its relation lines. Then one click on
the Diagram / Data switch turns the same app into a database client, and every edit button
shows the exact SQL it will run. Specific to Prismagram: Prisma syntax, UML compartments,
multiplicities like `0..*`, and a real `UPDATE ... WHERE "id" = ...` preview.

## Hook (first 2-3 seconds)
A dark code editor with Prismagram's syntax colors. `model Post {` types itself out with key
ticks, followed by `author User @relation(...)`. Over it, big type: "You wrote a schema."
The viewer recognizes Prisma code instantly.

## Key moments (the middle)
- The diagram draws itself on the light dotted canvas: `User`, `Post`, `Comment` class boxes
  pop in one by one with green headers and field compartments, then the connectors draw with
  `1` and `0..*` labels. Line: "Prismagram draws it. Live."
- The segmented Diagram / Data switch slides to Data. The sidebar fills table by table with
  row counts (users 19, posts 4.2k, comments 19k) and document cards appear.
- Edit a row: the dialog shows the JSON, `"Ada Lovelace"` becomes `"Ada King"`, and the "Runs"
  box updates to `UPDATE "public"."users" SET "name" = 'Ada King' WHERE "id" = '…';`. Click
  Update, toast "Row updated". Line: "Every button shows its SQL."

## Outro / punchline
Logo, "Prismagram", "Prisma diagrams + your Postgres & MongoDB data. Free and open source.",
and `kingvic300.github.io/Prismagram`. Small platform line: Linux · macOS · Windows.

## User flow worth showing
1. Type a Prisma model in the editor (entry).
2. Watch the class diagram appear and connect (key result).
3. Switch to Data, open `users`, edit a row and see the SQL it runs (second flow, result: toast).

## Tone
- Preset: app-store
- Creative direction: crisp dev-tool launch film, dark UI, one blue accent
- Interpretation: clean feature reveals, slides and smooth wipes, confident holds; real UI
  recreated in HTML, no jokes forced, no generic SaaS language.

## Format: landscape — 1920x1080
## Duration: 22 seconds

## Visual identity (from the project)
- Background: #0e0f11 (panels #141518 / #1a1b1f, raised #212227)
- Accent: #5c9eff (solid buttons #3b6fe0)
- Text: #ededf0 (secondary #a5a6ae, muted #82838c)
- Diagram canvas: #f4f5f4 with #dde2dd dots; class header #d5e8d4, stroke #2b2b2b
- Syntax: keyword #c792ea, type #7dd3fc, attribute #f9a8d4, string #a5e075, comment #5c6779
- Display font: Inter (bundled variable font, desktop/src/fonts/inter.woff2)
- Body / code font: JetBrains Mono (desktop/src/fonts/jetbrains-mono.woff2)
- Strongest visual element: the UML class boxes with green headers on the dotted canvas, and
  the sliding Diagram / Data switch. Logo: desktop/src/logo.svg.

## Share copy (draft)
Type a Prisma model, get a live UML diagram. Flip to Data and edit your Postgres or MongoDB rows, with the exact SQL shown before it runs. Prismagram is free and open source.

## Audio direction
- Role: warm, upbeat bed with light UI accents
- Music: happy-beats-business-moves-vol-11 (114.84 BPM)
- Music treatment: start at 0, around -16 dB under SFX, fade out over the last 1.5s
- Music cue guidance: preset read. Strong cues 3.70s (diagram reveal), 8.96s (switch to
  Data), 17.91s (logo). Beat grid ~0.52s apart; box pop-ins and sidebar rows can land on
  every other beat (≈1.05s) where they carry text, every beat for non-text accents.
- Audio-reactive treatment: none
- SFX posture: moderate, motion-matched: key ticks while typing, soft pops for class boxes,
  a click for the switch and the Update button, a light chime for the toast.
- Audio-coupled moments: typed hook, box pop sequence, switch click, sidebar rows, update
  click + toast.
- Restraint rule: no whooshes on every cut; nothing louder than the music on the outro.

## Storyboard

### Scene 1 — Hook: the schema — 3.7s
Dark editor pane (gutter line numbers, JetBrains Mono, syntax colors). Types:
`model Post {` / `  id       Int    @id` / `  author   User   @relation(fields: [authorId], references: [id])` / `}`.
Overlay headline, large Inter: "You wrote a schema." (holds ≥1.5s).
Sequential/interaction: yes — code types out line by line.
Audio intent: curiosity, quick start. Audio-coupled idea: soft key ticks with the typing.
Transition mood: clean slide → canvas pushes in from the right at 3.70s.

### Scene 2 — Reveal: the diagram — 5.3s (3.7–9.0)
Light dotted canvas. Class boxes `User`, `Post`, `Comment` pop in one by one (~1.05s apart),
each with a green header and `+id: Int` style rows. Connectors draw between them with
`1` and `0..*` labels. Caption on the left: "Prismagram draws it." then "Live, as you type."
Sequential/interaction: yes — 3 boxes, then lines.
Audio intent: satisfaction. Audio-coupled idea: a soft pop per box.
Transition mood: smooth wipe → Scene 3.

### Scene 3 — Flip to Data — 4.0s (9.0–13.0)
App chrome top bar with the segmented switch "Diagram | Data"; the thumb slides to Data on
the 8.96s cue. Sidebar: connection "Sovra · PostgreSQL", then rows appear: users 19,
posts 4.2k, comments 19k. Main area: two document cards (`email: "ada@example.com"`, ...).
Caption: "Then open the data."
Sequential/interaction: yes — switch click, sidebar rows one by one (each held).
Audio intent: lift. Audio-coupled idea: click on switch, light tick per row.
Transition mood: slide → Scene 4.

### Scene 4 — Edit with the SQL shown — 4.9s (13.0–17.9)
"Edit row" dialog over the dimmed app: JSON with `"name": "Ada Lovelace"` changing to
`"Ada King"`; the "Runs" box shows the UPDATE statement in blue mono. Cursor clicks Update,
toast "Row updated" with green dot. Caption: "Every button shows its SQL."
Sequential/interaction: yes — text edit, cursor click, toast.
Audio intent: confidence. Audio-coupled idea: typing ticks on the edit, click, small chime.
Transition mood: soft crossfade → outro on 17.91s.

### Scene 5 — Outro — 3.1s (17.9–21.0)
Logo scales in, "Prismagram" in Inter 650, line "Prisma diagrams + your Postgres & MongoDB
data", small "Free and open source · Linux · macOS · Windows", URL in accent blue.
Sequential/interaction: none. Audio intent: resolve; music fades.
Transition mood: hold to end.

**Music mood for this video:** upbeat
**Audio summary:** a bright business-beats bed under typing ticks and soft UI pops, landing the logo on the 17.91s strong beat and fading out.

## Timing as built
Composition check asked for longer holds on the SQL preview and the toast, so the edit scene
starts at 12.2s, the UPDATE statement holds 13.5–17.1s, the toast shows at 17.3s, and the outro
lands on the 18.44s beat (instead of the 17.91s strong cue). Total 22s.
