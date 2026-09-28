# dsh-document-translate

DeepSeek Harness plugin that adds an explicit **`translate_document`** tool. It runs the
deterministic part of the document-translation workflow — submit to a [DocuTranslate](https://github.com/)
service, write the translated copy, extract both sides as Markdown, and render a two-column
comparison — then hands the agent a **review brief**. The agent delegates that brief to its own
`subagent` tool, so the review model and provider are the profile's normal subagent configuration,
not a plugin concern.

The plugin's internal design record, recon notes, and roadmap live in a local,
unpublished `AGENTS.md` alongside the repository.

## What it does

```
translate_document          (this plugin)
  1. DocuTranslate draft     POST /service/translate/file → poll → download
  2. Extract both sides      @firecrawl/anydoc (+ @firecrawl/pdf-inspector for PDFs)
  3. Two-column comparison   <name>.translated.compare.html
  4. Return                  draft, comparison, extracted Markdown, reviewBrief
       ↓
subagent                    (the calling agent, immediately)
  5. Review the two Markdown files against the checklist in the brief
  6. Findings reach the conversation; a human decides what to change
```

The plugin never reviews and never edits the translation. Findings live in the conversation, not in
the comparison page.

Formats: `auto`, `markdown_based`, `txt`, `json`, `xlsx`, `docx`, `srt`, `epub`, `html`, `ass`,
`pptx` — everything DocuTranslate supports. Use `insertMode: append` / `prepend` for a bilingual
copy instead of a replacement.

**PDFs** are read locally by `@firecrawl/pdf-inspector` and submitted as Markdown, so DocuTranslate's
conversion engines (mineru/docling) are never involved and the original PDF is left untouched. The
result is a translated **Markdown** document plus the comparison view, not a re-typeset PDF.
Scanned/image-only PDFs are refused for now.

## Install

```sh
# From a checkout on this machine
dsh plugin --profile <name> add ./dsh-document-translate

# From GitHub (sources are built on install by the `prepare` script)
dsh plugin --profile <name> add github:<you>/dsh-document-translate#<sha>
```

A git install first fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`; copy the exact key pnpm
prints into the profile's `pnpm-workspace.yaml` and re-run:

```yaml
allowBuilds:
  "dsh-document-translate@github:<you>/dsh-document-translate#<sha>": true
```

Allowlisting means executing the package's code at install time — pin a commit SHA and only allow
sources you trust. To avoid the allowance entirely, publish to npm (`lib/` built at publish) or ship
a `pnpm pack` tarball.

## Configure

Every field is a live (`volatile`) Config field, editable from the built-in Plugins page or a
`cordis.yml` layer. There are no hardcoded endpoints. See
[`examples/cordis.example.patch.yml`](examples/cordis.example.patch.yml) for a deployment layer
(copy it to `examples/cordis.local.patch.yml`, which is git-ignored, and fill in your own endpoints).

```yaml
- id: document-translate
  name: 'dsh-document-translate'
  config:
    baseURL: 'http://127.0.0.1:8010'
    targetLang: '简体中文'
    llmBaseURL: 'https://api.deepseek.com/v1'
    llmModelId: 'deepseek-chat'
    llmApiKeyEnv: 'DOCUTRANSLATE_LLM_API_KEY'
```

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8010` | DocuTranslate endpoint (env: `DOCUTRANSLATE_SERVICE_URL`) |
| `targetLang` | `简体中文` | Default target language (env: `DOCUTRANSLATE_TO_LANG`) |
| `workflowType` / `insertMode` / `separator` | `auto` / `replace` / newline | Workflow, bilingual mode, separator |
| `requestTimeoutMs` / `taskTimeoutMs` / `pollIntervalMs` | `120000` / `1800000` / `2000` | Timeouts and poll interval |
| `llmBaseURL` / `llmModelId` / `llmProvider` | unset | Translation LLM forwarded to DocuTranslate (mode A) |
| `llmApiKeyEnv` | `DOCUTRANSLATE_LLM_API_KEY` | Credential reference resolved through `ctx.credentials` |
| `convertEngine` | — | `identity` / `mineru` / `docling` / `mineru_deploy` |
| `outputDir` | unset | Empty writes `<stem>.translated.<ext>` beside the source |
| `showProgress` | `true` | Show a live progress row while translating (see below) |

### Progress

A foreground tool has no progress channel in dsh, so while `translate_document` polls the service it
registers a lightweight **unowned** `ctx.jobs` job purely as a display surface. The Web client's job
list renders its live progress line (`45% 翻译中`) and expandable output panel. The job is unowned on
purpose: `dsh-tool-jobs` sends no completion notice for an unowned job, so the tool still returns its
normal synchronous result and the conversation gets no spurious "read your job output" message. When
no job registry is present, the surface is simply absent. Set `showProgress: false` to disable it.

### Translation LLM (A+B)

- **A** — the plugin resolves `llmApiKeyEnv` through the Harness credential seam and forwards
  `base_url` / `model_id` / `api_key` per request.
- **B** — when those fields are unset, DocuTranslate falls back to its own `.env`
  (`DOCUTRANSLATE_BASE_URL` / `API_KEY` / `MODEL_ID`). Keep `DOCUTRANSLATE_ENV_FORCE_OVERRIDE=false`
  so the plugin's values win when present.

### Review

Nothing to configure here. The plugin returns a `reviewBrief`; the agent calls its normal `subagent`
tool with it, so whichever provider/model the profile's subagent uses does the review. The brief
tells the reviewer which two Markdown files to read and what to check (omissions, mistranslations,
terminology, format/placeholders, untranslated leftovers).

## Artifacts

For a source `dir/sample.md` translated to `dir/sample.translated.md`:

| File | Purpose |
|---|---|
| `sample.translated.md` | The translated copy (extension follows the workflow) |
| `sample.compare…` → `sample.translated.compare.html` | Two-column source/translation view |
| `sample.source.md` | Source extracted to Markdown, read by the reviewer |
| `sample.translated.md` | Translation extracted to Markdown, read by the reviewer |

## Development

```sh
export PATH="$PATH:<node bin>"
npm install                      # installs the declared @deepseek-ai peers
npm run build                    # tsc -> lib/
npm test                         # build, then node --test tests/*.test.ts
node scripts/live-smoke.mjs      # needs a reachable DocuTranslate service
```

## Known Limitations and Deferred Work

- **Foreground only** — the tool polls in the calling execution; background jobs (`ctx.jobs`) and
  progress injection are planned for M2.
- **Progress is display-only** — `showProgress` publishes a live row through `ctx.jobs` for a UI that
  renders a job list (the Web client). It does not stream progress into the model's turn: the tool
  still blocks until the translation finishes and then returns its full result.
- **Review is a model step** — the tool description requires the agent to delegate immediately, but
  nothing enforces it; an agent that ignores the instruction returns a translation with no review.
- **Positional block alignment** — the comparison pairs blocks by index. Both sides come from the
  same DocuTranslate parse pipeline, so sequences normally match; a kind mismatch is surfaced in the
  view rather than hidden, but a translation that merges or splits blocks can misalign.
- **Native extractors** — `@firecrawl/anydoc` and `@firecrawl/pdf-inspector` ship platform-specific
  binaries (darwin arm64/x64, linux gnu/musl arm64/x64, win32 x64). A platform without one cannot
  convert container formats or classify PDFs; text formats still work.
- **Scanned PDFs are not supported** — a `Scanned` or `ImageBased` PDF is refused with a clear error;
  OCR first and convert to docx/md if needed. A partially scanned (`Mixed`) PDF proceeds, but the
  pages pdf-inspector flags for OCR are reported in the brief and the comparison page.
- **PDF output is Markdown, not a PDF** — the original PDF is never rewritten; there is no
  layout-preserving re-typeset. That would need PDF layout analysis and in-place overlay.
- **In-memory task state** — DocuTranslate keeps tasks in memory; a service restart invalidates
  `task_id` values recorded in sessions.
- **Plaintext LAN transport** — deploy the service on a trusted network or behind TLS.