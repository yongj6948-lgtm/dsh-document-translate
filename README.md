# dsh-document-translate

DeepSeek Harness plugin that adds an explicit **`translate_document`** tool. It runs the whole
document-translation workflow: submit the file to a [DocuTranslate](https://github.com/) service,
write the translated copy, build a two-column source/translation comparison, and run an **automatic
review** through a subagent so translation problems reach a human instead of shipping silently.

See [`AGENTS.md`](AGENTS.md) for the recon record, decisions, and roadmap.

## What it does

```
translate_document
  1. DocuTranslate draft        POST /service/translate/file → poll → download
  2. Extract reviewable text    @firecrawl/anydoc (+ @firecrawl/pdf-inspector for PDFs)
  3. Two-column comparison      <name>.translated.compare.html
  4. Automatic review           ctx.subagents → structured findings
  5. Return                     { draft, comparison, verdict, issueCount }
                                findings tell the human what to fix; the plugin never edits
```

Formats: `auto`, `markdown_based`, `txt`, `json`, `xlsx`, `docx`, `srt`, `epub`, `html`, `ass`,
`pptx` — everything DocuTranslate supports. Use `insertMode: append` / `prepend` for a bilingual
copy instead of a replacement.

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
[`examples/cordis.local.patch.yml`](examples/cordis.local.patch.yml) for a full deployment layer.

```yaml
- id: document-translate
  name: 'dsh-document-translate'
  config:
    baseURL: 'http://127.0.0.1:8010'
    targetLang: '简体中文'
    llmBaseURL: 'https://api.deepseek.com/v1'
    llmModelId: 'deepseek-chat'
    llmApiKeyEnv: 'DOCUTRANSLATE_LLM_API_KEY'
    review: true
    reviewProvider: vllm          # an llm-pi-ai route
    reviewModel: 'your-model'
```

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8010` | DocuTranslate endpoint (env: `DOCUTRANSLATE_SERVICE_URL`) |
| `targetLang` | `简体中文` | Default target language (env: `DOCUTRANSLATE_TO_LANG`) |
| `workflowType` / `insertMode` / `separator` | `auto` / `replace` / newline | Workflow, bilingual mode, separator |
| `requestTimeoutMs` / `taskTimeoutMs` / `pollIntervalMs` | `120000` / `1800000` / `2000` | Timeouts and poll interval |
| `llmBaseURL` / `llmModelId` / `llmProvider` | unset | Translation LLM forwarded to DocuTranslate (mode A) |
| `llmApiKeyEnv` | `DOCUTRANSLATE_LLM_API_KEY` | Credential reference resolved through `ctx.credentials` |
| `review` | `true` | Run the automatic review |
| `subagentProvider` | `spawn` | Subagent provider running the review child |
| `reviewProvider` / `reviewModel` | unset | LLM route/model for the review child (unset inherits the caller) |
| `convertEngine` | — | `identity` / `mineru` / `docling` / `mineru_deploy` |
| `outputDir` | unset | Empty writes `<stem>.translated.<ext>` beside the source |

### Translation LLM (A+B)

- **A** — the plugin resolves `llmApiKeyEnv` through the Harness credential seam and forwards
  `base_url` / `model_id` / `api_key` per request.
- **B** — when those fields are unset, DocuTranslate falls back to its own `.env`
  (`DOCUTRANSLATE_BASE_URL` / `API_KEY` / `MODEL_ID`). Keep `DOCUTRANSLATE_ENV_FORCE_OVERRIDE=false`
  so the plugin's values win when present.

### Review LLM

The review child runs through the harness LLM service, so its route must be a registered provider.
`@deepseek-ai/dsh-llm-pi-ai` is mounted dormant by the base bundle; declare an OpenAI-compatible
route for your endpoint (the example layer shows a local vLLM route) and point `reviewProvider` at
it. Without the subagent service or a matching route, review fails loudly rather than silently
skipping.

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
- **Positional block alignment** — the comparison pairs blocks by index. Both sides come from the
  same DocuTranslate parse pipeline, so sequences normally match; a kind mismatch is surfaced in the
  view rather than hidden, but a document whose translation merges or splits blocks can misalign.
- **Native extractors** — `@firecrawl/anydoc` and `@firecrawl/pdf-inspector` ship platform-specific
  binaries (darwin arm64/x64, linux gnu/musl arm64/x64, win32 x64). A platform without one cannot
  convert container formats; PDFs also lose their scanned/text classification. Text formats still
  work.
- **Scanned PDFs** — pages that need OCR are reported as such; their text cannot be reviewed.
- **In-memory task state** — DocuTranslate keeps tasks in memory; a service restart invalidates
  `task_id` values recorded in sessions.
- **Plaintext LAN transport** — deploy the service on a trusted network or behind TLS.