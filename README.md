# dsh-document-translate

DeepSeek Harness plugin that adds an explicit **`translate_document`** tool backed by a
[DocuTranslate](https://github.com/) service. The tool uploads one file, waits for the service's
translation workflow to finish, and writes the translated copy beside the source.

Current state: **M1 complete** — plugin skeleton, HTTP client, tool registration, a live smoke
script, and a verified real translation. See [`AGENTS.md`](AGENTS.md) for the recon record,
decisions, and roadmap.

## What it provides

| Contribution | Kind | Backed by |
|---|---|---|
| `translate_document` | `ctx.tools` | DocuTranslate `POST /service/translate/file` + status/download |

Workflows: `auto`, `markdown_based`, `txt`, `json`, `xlsx`, `docx`, `srt`, `epub`, `html`, `ass`,
`pptx`. Use `insertMode: append` / `prepend` for a bilingual copy instead of a replacement.

## Install

```sh
dsh plugin --profile <name> add ./dsh-document-translate
dsh --profile <name> --dump-config | grep -A3 document-translate
dsh --profile <name>
```

## Configure

Nothing is hardcoded: every field below is a live (`volatile`) Config field, editable from the
built-in Plugins/settings page or from a `cordis.yml` layer. The bundle only inserts the plugin row;
point it at your service and translation LLM from your profile's `cordis.patch.yml` (see
[`examples/cordis.local.patch.yml`](examples/cordis.local.patch.yml)):

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
| `llmBaseURL` / `llmModelId` / `llmProvider` | unset | — | Forwarded to DocuTranslate when set |
| `llmApiKeyEnv` | `DOCUTRANSLATE_LLM_API_KEY` | same name | Credential reference resolved through `ctx.credentials` |
| `convertEngine` | — | — | `identity` / `mineru` / `docling` / `mineru_deploy` |
| `outputDir` | unset | — | Empty writes `<stem>.translated.<ext>` beside the source |

### Translation LLM (A+B)

- **A** — the plugin resolves `llmApiKeyEnv` through the Harness credential seam and forwards
  `base_url` / `model_id` / `api_key` per request. Store the key once with `dsh` (or leave it to the
  launch environment); no secret enters this repository.
- **B** — when those fields are unset, DocuTranslate falls back to its own `.env`
  (`DOCUTRANSLATE_BASE_URL` / `API_KEY` / `MODEL_ID`). Keep `DOCUTRANSLATE_ENV_FORCE_OVERRIDE=false`
  so the plugin's values win when present.

The thinking mode is intentionally left at DocuTranslate's default (disabled); it is not a plugin
option.

## Development

```sh
export PATH="$PATH:<node bin>"
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
- **Plaintext LAN transport** — deploy the service on a trusted network or behind TLS; the service's
  own optional API key is not yet exposed by this plugin.