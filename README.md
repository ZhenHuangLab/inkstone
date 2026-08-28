<div align="center">

# Inkstone · 「砚」

**Export your chatgpt.com and claude.ai conversations to Obsidian-friendly Markdown — one click, in the page, fully local.**

*An inkstone grinds raw pigment into ink for writing. Inkstone helps you grind raw model output into ink for your notes.*

[![release](https://img.shields.io/github/v/release/ZhenHuangLab/inkstone)](https://github.com/ZhenHuangLab/inkstone/releases/latest)
[![downloads](https://img.shields.io/github/downloads/ZhenHuangLab/inkstone/total)](https://github.com/ZhenHuangLab/inkstone/releases)
[![license](https://img.shields.io/github/license/ZhenHuangLab/inkstone)](./LICENSE)
[![greasyfork](https://img.shields.io/greasyfork/v/586688)](https://greasyfork.org/scripts/586688)

**English** · [简体中文](./README.zh-CN.md)

</div>

<p align="center">
  <a href="https://www.tampermonkey.net/"><b>① Install Tampermonkey</b></a>
  &nbsp;→&nbsp;
  <a href="https://github.com/ZhenHuangLab/inkstone/releases/latest/download/inkstone.user.js"><b>② Install Inkstone</b></a>
  &nbsp;→&nbsp;
  <b>③ Open chatgpt.com or claude.ai, hit ⤓</b>
</p>

---

## Why Inkstone

Your ChatGPT history holds real work, but getting it into a vault is painful. The official export is a raw JSON dump: tool and system messages are stripped (Canvas and code-interpreter output simply aren't there), some attachments have already expired server-side, math arrives in `\( \)` delimiters Obsidian won't render, and web-search citations turn into private-use Unicode garbage. Copy-pasting by hand doesn't scale past ten conversations, let alone a thousand.

Inkstone runs inside the page and fetches conversations through the same backend API the app itself uses, then converts everything locally in your browser — nothing ever leaves the page. The result is Markdown that reads natively in Obsidian: real headings per turn, `$` / `$$` math, resolved citations, downloaded images, clean frontmatter.

## Supported sites

| | ChatGPT | Claude |
| --- | --- | --- |
| Export current conversation | ✅ | ✅ |
| Batch / export-all | ✅ | ⏳ not yet enabled |
| Incremental sync | ✅ | ⏳ not yet enabled |
| Rich documents | Canvas patch replay | Artifact fold-up to final version |
| Thoughts / tool traces | ✅ opt-in | ✅ opt-in |
| Attachments | images and files downloaded | images downloaded, documents linked, text extractions inlined |

**Why no batch export on Claude yet?** It isn't missing, it's switched off. The pager,
watermark, concurrency pool and protective abort are all in place and unit-tested — but
there is no measured rate-limit profile for Claude yet. The ChatGPT numbers only became
trustworthy after 344 + 432 real conversations. Until comparable evidence exists, the cost
of a wrong guess lands on your account, and that isn't a call a default-on switch should
make. See [`docs/claude-adapter-feasibility.md`](./docs/claude-adapter-feasibility.md).

## Screenshots

| Panel UI | Advanced settings |
| -------- | ----------------- |
| ![Panel UI](./.github/assets/ui.png) | ![Advanced settings](./.github/assets/advanced-settings.png) |

| Batch export all | Multi-select export |
| ---------------- | ------------------- |
| ![Batch export all](./.github/assets/all-export.png) | ![Multi-select export](./.github/assets/multi-export.png) |

| Export directly to Obsidian | Keep thoughts / tool traces |
| --------------------------- | --------------------------- |
| ![Export directly to Obsidian](./.github/assets/export-to-obsidian.png) | ![Keep thoughts / tool traces](./.github/assets/keep-thoughts-and-tool-traces.png) |

| Keep math & links | Keep attachments & images |
| ----------------- | ------------------------- |
| ![Keep math & links](./.github/assets/keep-formula-and-link.png) | ![Keep attachments & images](./.github/assets/keep-attachments-and-images.png) |

## Features

### Conversion quality

- `# User` / `# ChatGPT` top-level headings separate turns; headings inside messages are demoted one level (H1–H6)
- `\( \)` / `\[ \]` → `$` / `$$` math-delimiter conversion (code-block aware); currency `$` escaped
- **Citations restored**: web-search citations become inline `[source](url)` links plus a `# Sources` section at the end; file citations become filename notes; anything unresolvable is stripped — no garbled markers, ever
- Chain-of-thought and tool traces (code-interpreter code, search queries, run output) are wrapped in collapsed callouts and **not written by default** — opt in via advanced settings ("write thoughts" / "write tool traces"), or `--thoughts` / `--tool-traces` in the CLI
- Unknown content types are preserved verbatim inside collapsed callouts — nothing is ever silently dropped
- Frontmatter: `title / chat_id / url / project / created / updated / model / tags`

### Attachments

- Every image in a conversation is downloaded into an attachments subfolder next to the notes (default `conversations/attachments/`, inlined with Obsidian `![[wikilink]]`)
- User-uploaded files ≤ 2 MB are downloaded and linked; larger ones get a placeholder note
- Folder layout is customizable in settings: the notes subfolder (default `conversations`, nestable as `a/b`, empty = vault root) and the attachments subfolder (default `attachments`, relative to the notes folder, empty = same level as notes). Attachment links are strict relative paths, so GitHub and VS Code previews work too
- A "download attachments" toggle: turn it off for text-only export with drastically fewer requests

### Projects

Conversations inside ChatGPT **Projects** are covered by every scope. The main conversation-list endpoint only returns the flat sidebar "Chats" list, so Inkstone treats Chats and every project as separate paged streams and k-way merges them by `update_time` — one list in true recency order, deduplicated by id. Project conversations get a `project:` frontmatter field and a `chatgpt.com/g/<gizmo-id>/c/<id>` URL, and are labelled with the project name in the multi-select list.

The multi-select list also has a **source** dropdown — All / Chats / one specific project — so a single project's conversations are one click away instead of a scroll through everything.

### Incremental sync

A watermark records each conversation's `update_time`, so re-exports only fetch what changed (can be disabled; the panel has a "reset incremental state" button). The heavy full grab only ever happens once.

### Raw JSON export

Besides Markdown, Inkstone exports a **raw JSON zip** — data insurance, and the source of converter fixtures.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Click [the latest inkstone.user.js](https://github.com/ZhenHuangLab/inkstone/releases/latest/download/inkstone.user.js) — the script header carries an update URL, so future releases auto-update

Or GreasyFork: [inkstone](https://greasyfork.org/scripts/586688)

Or build from source:

```bash
bun install
bun run build        # → dist/inkstone.user.js, drag it into Tampermonkey
```

## Usage

Open chatgpt.com or claude.ai (logged in) → click the **⤓ button** in the top bar → pick **Markdown zip** or **raw JSON zip** → unzip into your Obsidian vault.

- On Claude only **current conversation** is offered; the batch options are hidden, not disabled
- The button position is switchable (panel → advanced settings): next to Share in the top bar, or a glass button beside the input box
- The UI follows the host page's appearance automatically (light/dark + accent color)
- Exports are cancelable; a single failed conversation never aborts the run — failures are summarized in `_failures.json`

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

Note for claude.ai: its CSP may block the dev-server script, so verify Claude-side changes
against a real `bun run build` artifact loaded into Tampermonkey rather than `bun run dev`.

Architecture: `src/core/` is site-agnostic (IR, renderer, throttled fetcher) and
`src/sites/<site>/` holds everything that knows one provider's endpoints, fields and DOM.
Adding a site means adding an adapter, not touching the orchestration. See `PLAN.md` § P5.

## Roadmap

Batch export on Claude once its rate-limit profile has actually been measured, an MV3 browser extension (no Tampermonkey, store release), and Gemini support. Already done: the multi-site adapter architecture, Claude single-conversation export, incremental sync, direct-write to an Obsidian vault, settings panel, Canvas patch replay, Artifact fold-up, and the offline CLI. Details in [PLAN.md](./PLAN.md) (Chinese).

## License

[GPL-3.0](./LICENSE)

## Related Links

[LINUX DO](https://linux.do)