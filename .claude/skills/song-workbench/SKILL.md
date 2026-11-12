---
name: song-workbench
description: Edit, extend or arrange a Song Workbench song file (a .project.json saved from the Song Workbench music editor). Use when the user shares such a file, or asks to add or change parts (bass, drums, pads, melodies, harmonies), chords, tempo, time signature, sections or structure of a song they are building there.
---

# Song Workbench songs

Song Workbench is a browser music editor. A song is one JSON file: bars with tempo and time-signature
blocks, tracks of notes, a chord lane, a chord palette and scales. The user saves it with
**song menu -> Save a song file** and opens your result with **song menu -> Open a song file**.

You change a song by writing **edit operations** (a JSON array) and applying them with the bundled
script. Do not edit the song JSON by hand: the script validates every operation and keeps the file consistent.

## Steps

1. Read the song: `node scripts/song.mjs describe SONG.json`
   It prints structure, tempo and signature blocks, sections, tracks, the chord palette, the chord
   lane bar by bar, and the scales that fit. Add `--bars 9-16` to also list every note in those bars;
   do this for the bars you are about to write against, not the whole song.
2. Read the operations reference once: `node scripts/song.mjs guide`
3. Write the operations to a file, e.g. `ops.json`, then apply:
   `node scripts/song.mjs apply SONG.json ops.json -o SONG.edited.project.json`
   It prints one line per operation (`done:` or `SKIPPED:` with the reason). Fix skipped operations and apply
   again to the original file. Exit code 2 means some were skipped; 1 means nothing was written.
4. Check your work: `describe` the edited file (with `--bars` where you wrote notes) and confirm it says what you intended.
5. Give the user the edited file and say in plain words what changed. You cannot hear the result, so say so,
   and ask them to listen. `node scripts/song.mjs midi FILE` writes a MIDI file if they want one.

## Counting

Bars and beats count from 1. A beat is what you would tap. `division` says how a beat divides:
2 is straight, 3 is a triplet feel, so 2 beats dividing in 3 is 6/8 and its beat positions are
1, 1.3333, 1.6667, 2, 2.3333, 2.6667. Note lengths are in beats. Pitches are names like `E2`, `C#4`
(middle C is `C4`) or MIDI numbers.

## Making good changes

- Prefer `generate` and `transform` operations to long hand-written note lists. Generators follow the
  chord lane and each bar's signature. If the harmony should change, change the chord lane first
  (`set_chords`), then generate.
- When you write notes by hand, stay inside a scale that fits (listed by `describe`) unless asked for
  something else, keep them inside each bar's length, and give them shape: mostly stepwise motion,
  rests, repetition with small changes. Read the notes already in those bars first so the new part answers them.
- Change only what was asked. Generators and `clear` replace what a track holds in those bars, so name
  a new track for a new part instead of overwriting one the user made.
- Keep new parts in a sensible register (bass E1-E3, pads and chords around C3-C5, melodies C4-C6) and
  at a volume that supports the song (0.5-0.8).
- Do not guess at things only the user can judge by ear, such as whether a tempo change was intended. Ask.

## Files

- `scripts/song.mjs`: the command line described above
- `lib/`: the editor's own song model, tools and operations (copied from the editor; do not edit)
