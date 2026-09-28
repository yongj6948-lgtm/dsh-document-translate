# Third-party notices

`dsh-document-translate` is licensed under the MIT License (see [LICENSE](LICENSE)).
It is an independent client that talks to other software over network APIs and
bundles none of the third-party source listed below. The notices here are
attribution for the projects this plugin depends on or is designed to work with.

## DocuTranslate

- **Project**: [github.com/xunbu/docutranslate](https://github.com/xunbu/docutranslate)
- **Author**: QinHan — `SPDX-FileCopyrightText: 2025 QinHan`
- **License**: Mozilla Public License 2.0 (MPL-2.0)

This plugin drives a DocuTranslate service over its HTTP API
(`/service/translate/file`, `/service/status/{id}`, `/service/download/{id}/{type}`, …).
It does **not** include, copy, link, or modify DocuTranslate source code, and it is
not a derivative work of it; the MPL-2.0 obligations attach to DocuTranslate itself,
not to this plugin. Thanks to QinHan for the service and for publishing it.

## Runtime dependencies (all MIT)

| Package | Purpose |
|---|---|
| [`marked`](https://github.com/markedjs/marked) | Markdown → HTML for the comparison page |
| [`@firecrawl/anydoc`](https://www.npmjs.com/package/@firecrawl/anydoc) | Container formats → Markdown extraction |
| [`@firecrawl/pdf-inspector`](https://www.npmjs.com/package/@firecrawl/pdf-inspector) | Local PDF classification/extraction |
| [`@deepseek-ai/schemastery`](https://www.npmjs.com/package/@deepseek-ai/schemastery) | Config schema validation |

## Peer dependencies

`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-credentials`, and
`@deepseek-ai/dsh-launch-environment` are provided by the DeepSeek Harness host and
carry their own licenses.