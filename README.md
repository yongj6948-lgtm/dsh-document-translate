# dsh-document-translate

DeepSeek Harness plugin that adds an explicit **`translate_document`** tool backed by a
[DocuTranslate](https://github.com/) service on the LAN. The tool uploads one file, waits for the
service's translation workflow to finish, and writes the translated copy beside the source.

Current state: **M1 complete** — plugin skeleton, HTTP client, tool registration, and a live smoke
script. See [`AGENTS.md`](AGENTS.md) for the full recon record, design decisions, and roadmap.

## What it provides

| Contribution | Kind | Backed by |
|---|---|---|
| `translate_document` | `ctx.tools` | DocuTranslate `POST /service/translate/file` + status/download |

Workflows: `auto`, `markdown_based`, `txt`, `json`, `xlsx`, `docx`, `srt`, `epub`, `html`, `ass`,
`pptx`. Use `insertMode: append` / `prepend` for a bilingual copy instead of a replacement.

## Configure

`cordis.yml` (or a profile patch layer):

```yaml
- id: document-translate
  name: 'dsh-document-translate'
  config:
    baseURL: 'http://127.0.0.1:8010'
    targetLang: '简体中文'
    insertMode: replace        # replace | append | prepend
    # A-side LLM parameters; leave unset to use the service's own defaults (B-side).
    llmBaseURL: 'https://api.deepseek.com/v1'
    llmModelId: 'deepseek-chat'
    llmProvider: deepseek
    llmApiKeyEnv: DOCUTRANSLATE_LLM_API_KEY
```

| Field | Default | Env fallback | Meaning |
|---|---|---|---|
| `baseURL` | `http://127.0.0.1:8010` | `DOCUTRANSLATE_SERVICE_URL` | DocuTranslate endpoint |
| `targetLang` | `简体中文` | `DOCUTRANSLATE_TO_LANG` | Default target language |
| `workflowType` | `auto` | — | Default workflow |
| `insertMode` | `replace` | — | Bilingual output when `append`/`prepend` |
| `separator` | newline | — | Separator for `append`/`prepend` |
| `requestTimeoutMs` | `120000` | — | Per-request HTTP timeout |
| `taskTimeoutMs` | `1800000` | — | Overall task timeout |
| `pollIntervalMs` | `2000` | — | Status poll interval |
| `llmBaseURL` / `llmModelId` / `llmProvider` / `llmThinking` | unset | — | Forwarded to DocuTranslate when set |
| `llmApiKeyEnv` | `DOCUTRANSLATE_LLM_API_KEY` | same name | Credential reference resolved through `ctx.credentials` |
| `convertEngine` | — | — | `identity` / `mineru` / `docling` / `mineru_deploy` |
| `outputDir` | unset | — | Empty writes `<stem>.translated.<ext>` beside the source |

### LLM configuration (A+B)

- **A** — the plugin resolves `llmApiKeyEnv` through the Harness credential seam and forwards
  `base_url` / `model_id` / `api_key` per request.
- **B** — when those fields are unset, DocuTranslate falls back to its own `.env`
  (`DOCUTRANSLATE_BASE_URL` / `API_KEY` / `MODEL_ID`). Keep `DOCUTRANSLATE_ENV_FORCE_OVERRIDE=false`
  so the plugin's values win when present.

## Development

```sh
export PATH="$PATH:/home/user/.nvm/versions/node/v24.21.0/bin"
npm install --legacy-peer-deps   # @deepseek-ai/* packages carry workspace peers
npm run build                    # tsc -> lib/
npm test                         # build, then node --test tests/*.test.ts
node scripts/live-smoke.mjs      # needs a reachable DocuTranslate service
```

`scripts/live-smoke.mjs` runs the no-LLM parse path by default. Set
`DOCUTRANSLATE_TEST_LLM_BASE_URL` / `_API_KEY` / `_MODEL_ID` to also run a real translation.

## Known Limitations and Deferred Work

- **Foreground only** — the tool polls in the calling execution; background jobs (`ctx.jobs`) and
  progress injection are planned for M2.
- **No side-by-side preview yet** — bilingual files are produced by `insertMode`, but the two-column
  HTML view is M3.
- **In-memory task state** — DocuTranslate keeps tasks in memory; a service restart invalidates
  `task_id` values recorded in sessions.
- **Plaintext LAN transport** — the service is reached over HTTP on the trusted network; a
  service-side API key of its own is not yet configured.