<div align="center">

# Inkstone

**Batch-export your entire chatgpt.com history to Obsidian-friendly Markdown — one click, in the page, fully local.**

*An inkstone grinds raw pigment into ink for writing. Inkstone grinds GPT's raw output into ink for your notes — stone to stone（砚 ↔ Obsidian）.*

[![release](https://img.shields.io/github/v/release/ZhenHuangLab/inkstone)](https://github.com/ZhenHuangLab/inkstone/releases/latest)
[![downloads](https://img.shields.io/github/downloads/ZhenHuangLab/inkstone/total)](https://github.com/ZhenHuangLab/inkstone/releases)
[![license](https://img.shields.io/github/license/ZhenHuangLab/inkstone)](./LICENSE)
<!-- TODO: GreasyFork badge once published: [![greasyfork](https://img.shields.io/greasyfork/v/SCRIPT_ID)](https://greasyfork.org/scripts/SCRIPT_ID) -->

**English** · [简体中文](./README.zh-CN.md)

</div>

<p align="center">
  <a href="https://www.tampermonkey.net/"><b>① Install Tampermonkey</b></a>
  &nbsp;→&nbsp;
  <a href="https://github.com/ZhenHuangLab/inkstone/releases/latest/download/inkstone.user.js"><b>② Install Inkstone</b></a>
  &nbsp;→&nbsp;
  <b>③ Open chatgpt.com, hit ⤓</b>
</p>

<p align="center"><sub>The script carries its own update URL — new releases install themselves.</sub></p>

---

## Why Inkstone

Your ChatGPT history holds real work, but getting it into a vault is painful. The official export is a raw JSON dump: tool and system messages are stripped (Canvas and code-interpreter output simply aren't there), some attachments have already expired server-side, math arrives in `\( \)` delimiters Obsidian won't render, and web-search citations turn into private-use Unicode garbage. Copy-pasting by hand doesn't scale past ten conversations, let alone a thousand.

Inkstone runs inside chatgpt.com and fetches conversations through the same backend API the app itself uses, then converts everything locally in your browser — nothing ever leaves the page. The result is Markdown that reads natively in Obsidian: real headings per turn, `$` / `$$` math, resolved citations, downloaded images, clean frontmatter.

<!-- TODO: screenshots — panel UI + an exported note inside Obsidian -->

## Features

### Conversion quality

- `# User` / `# ChatGPT` top-level headings separate turns; headings inside messages are demoted one level (H1–H6)
- `\( \)` / `\[ \]` → `$` / `$$` math-delimiter conversion (code-block aware); currency `$` escaped
- **Citations restored**: web-search citations become inline `[source](url)` links plus a `# Sources` section at the end; file citations become filename notes; anything unresolvable is stripped — no garbled markers, ever
- Chain-of-thought and tool traces (code-interpreter code, search queries, run output) are wrapped in collapsed callouts and **not written by default** — opt in via advanced settings ("write thoughts" / "write tool traces"), or `--thoughts` / `--tool-traces` in the CLI
- Unknown content types are preserved verbatim inside collapsed callouts — nothing is ever silently dropped
- Frontmatter: `title / chat_id / url / created / updated / model / tags`

### Attachments

- Every image in a conversation is downloaded into an attachments subfolder next to the notes (default `conversations/attachments/`, inlined with Obsidian `![[wikilink]]`)
- User-uploaded files ≤ 2 MB are downloaded and linked; larger ones get a placeholder note
- Folder layout is customizable in settings: the notes subfolder (default `conversations`, nestable as `a/b`, empty = vault root) and the attachments subfolder (default `attachments`, relative to the notes folder, empty = same level as notes). Attachment links are strict relative paths, so GitHub and VS Code previews work too
- A "download attachments" toggle: turn it off for text-only export with drastically fewer requests

### Incremental sync

A watermark records each conversation's `update_time`, so re-exports only fetch what changed (can be disabled; the panel has a "reset incremental state" button). The heavy full grab only ever happens once.

### Raw JSON export

Besides Markdown, Inkstone exports a **raw JSON zip** — data insurance, and the source of converter fixtures.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Click [the latest inkstone.user.js](https://github.com/ZhenHuangLab/inkstone/releases/latest/download/inkstone.user.js) — the script header carries an update URL, so future releases auto-update

<!-- TODO: GreasyFork install link once published -->

Or build from source:

```bash
bun install
bun run build        # → dist/inkstone.user.js, drag it into Tampermonkey
```

## Usage

Open chatgpt.com (logged in) → click the **⤓ button left of the Share button** in the top bar → pick **Markdown zip** or **raw JSON zip** → unzip into your Obsidian vault.

- The button position is switchable (panel → advanced settings): next to Share in the top bar, or a glass button beside the input box
- The UI follows ChatGPT's appearance settings automatically (light/dark + accent color)
- Exports are cancelable; a single failed conversation never aborts the run — failures are summarized in `_failures.json`

## ⚠️ Rate limits & account safety

> [!WARNING]
> Sustained high-frequency fetching can trip ChatGPT's **account-level anti-abuse measures**: older conversations progressively return 429 → 404 and the conversation list gets truncated, recovering only after several hours. Inkstone's default pacing is deliberately conservative — **do not make it faster.**

Inkstone ships a full mitigation stack (learned the hard way): global request spacing, adaptive slowdown on 429 that never speeds back up, a ~25 s breather every ~80 requests, three distinct 429 classes (with `Retry-After` → global cooldown; headerless → fast per-item give-up; consecutive across URLs → short cooldown), a final low-speed retry pass over failed items, and a protective abort when failures pile up.

Two ways to keep request volume down: incremental sync means you only pay for the full grab once, and turning off attachment downloads reduces requests drastically.

## Offline CLI

The zero-risk alternative: convert ChatGPT's **official export zip** entirely offline — it never touches the backend API.

```bash
bun run offline <export.zip | extracted-dir> [-o outdir]
  [--thoughts] [--tool-traces] [--no-assets]
  [--link-style wikilink|markdown] [--heading-mode demote|strip]
  [--notes-dir <name>] [--attachments-dir <name>]
```

The output layout matches the userscript's. Caveat: the official zip only contains visible user/assistant messages — tool/system payloads (Canvas, code interpreter) are stripped by OpenAI, and some referenced attachments are already expired server-side (placeholders are left in their place).

## Development

```bash
bun install
bun run dev          # vite-plugin-monkey prints a one-time install URL; edits hot-reload
bun test             # converter unit tests (pure TS, no browser needed)
bun run typecheck
bun run build
```

## Roadmap

MV3 browser extension (no Tampermonkey, store release) and Claude / Gemini support. Already done: incremental sync, direct-write to an Obsidian vault, settings panel, Canvas patch replay, and the offline CLI. Details in [PLAN.md](./PLAN.md) (Chinese).

## License

[GPL-3.0](./LICENSE)
