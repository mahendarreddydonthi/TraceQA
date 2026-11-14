# TraceQA v0.5

TraceQA is a requirement-driven testing agent for **web apps**. It reads your requirements (Markdown, Word, PDF or Jira), maps them to the pages of your app, explores the app in a real browser, writes a plain Playwright framework, runs it, repairs tests broken by UI changes, and traces every result and bug back to a requirement.

Scope is web only: desktop Chromium, Firefox and WebKit. Native mobile apps and mobile emulation are out of scope.

There are three ways in, and all three share the same project files:

- **The dashboard** (double-click `TraceQA Dashboard.cmd`, or `traceqa ui`). Everything can be done with buttons, from first-time setup to filing bugs, so nobody needs a terminal.
- **AI coding tools** (Claude Code, Codex, Cursor, Antigravity, any MCP client). TraceQA runs as an MCP server and the tool's own model does the reasoning, so no extra API key is needed.
- **The CLI** (`traceqa …`). Everyday steps need no AI. `explore`, `generate`, `heal --ai` and `agent` use TraceQA's built-in agent: Claude, any model on OpenRouter, or a local model in Ollama or LM Studio.

No requirements yet? TraceQA can also explore the app on its own, find bugs, and turn the flows that work into E2E tests.

The tests it writes are plain Playwright. They run with `npx playwright test`, with no AI involved.

## What's new

| Area | v0.1 | v0.2 | v0.3 | v0.4 | v0.5 |
|---|---|---|---|---|---|
| App analysis, requirements, mapping, framework, test runs, coverage report | ✅ | ✅ | ✅ | ✅ | ✅ |
| Exploration and test writing from AI coding tools (MCP) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Standalone AI agent: `explore`, `generate`, `agent`, `heal --ai` | – | ✅ | ✅ | ✅ | ✅ |
| Automatic healing of tests broken by UI changes (assertions are never touched) | – | ✅ | ✅ | ✅ | ✅ |
| Jira filing with evidence attached and duplicate detection | – | ✅ | ✅ | ✅ | ✅ |
| Live dashboard | – | view, run, heal, file | every action | every action | every action |
| Heal preview, Stop for any job, AI token use and cost | – | – | ✅ | ✅ | ✅ |
| AI providers | – | Anthropic | + OpenRouter | + Ollama, LM Studio (local) | all four |
| Requirement documents (Markdown, text, Word, PDF) | ID format only | ID format only | ID format only | converted to the ID format | **any format, read as they are** |
| Requirements from Jira issues (keys become requirement IDs) | – | – | – | ✅ | ✅ |
| Exploring without requirements: find bugs, automate the working flows as E2E tests | – | – | – | ✅ | ✅ |
| Mobile | – | out of scope | out of scope | out of scope | out of scope |

## Install (from this folder, until it is published to npm)

```bash
npm install
```

```bash
npx playwright install chromium
```

```bash
npm run build
```

Optionally `npm link` makes the `traceqa` command available everywhere. Otherwise run `node <path>/traceqa/dist/cli.js`.

## Use it on your app

The easiest way: open the dashboard in your project folder and follow the setup page.

```bash
traceqa ui --open
```

Or with the CLI:

```text
cd your-project
traceqa init --url https://staging.your-app.test --agents
copy .env.example .env               (then fill in a TEST account)
(put your requirement documents in requirements/ as they are: .md, .txt, .docx or .pdf, or: traceqa requirements import-jira)
traceqa analyze
traceqa requirements import
traceqa map
traceqa scaffold
```

Then pick how to work:

- **In an AI coding tool:** open the project and ask, for example, "Use TraceQA to test REQ-142."
- **From the CLI with AI:** set `ANTHROPIC_API_KEY` (or `OPENROUTER_API_KEY`, see below) in `.env`, then run e.g. `traceqa generate --gaps`.
- **Dashboard:** run `traceqa ui --open`.

## CLI

| Command | AI? | What it does |
|---|---|---|
| `traceqa init [--url] [--agents] [--npx]` | | Set up a project (and connect AI coding tools) |
| `traceqa status` | | What exists and the next step |
| `traceqa analyze [--max-pages n]` | | Crawl the app into `.traceqa/app-map.json` |
| `traceqa requirements import` | | Read every document in `requirements/` (any format), flag unclear criteria |
| `traceqa requirements import-doc <file> [--ai]` | `--ai` | Copy a Word (.docx), PDF, text or Markdown document into `requirements/` as it is and read it; `--ai` also reads it with AI |
| `traceqa requirements read-ai <file>` | ✓ | Read a document in `requirements/` with AI when the automatic reading misses things |
| `traceqa requirements import-jira [--jql …] [--max n]` | | Import Jira issues as requirements |
| `traceqa requirements clarify REQ-118 AC1 <text>` | | Save a testable wording agreed with the team |
| `traceqa map` | | Link requirements to pages |
| `traceqa scaffold [--no-install]` | | Create or refresh the Playwright framework in `e2e/` |
| `traceqa render` | | Re-render page objects and specs from the app map and saved tests |
| `traceqa explore --req REQ-142 [--charter …] [--headed]` | ✓ | Explore one requirement in a real browser; findings become draft bugs |
| `traceqa explore [--area /cart] [--sign-in] [--write-tests] [--max-flows n]` | ✓ | Explore the whole app without requirements; `--write-tests` saves the working flows as E2E requirements with tests (every flow it finds, or at most `n`) |
| `traceqa generate --req REQ-1 REQ-2 \| --gaps \| --all` | ✓ | Write one test per acceptance criterion, check each, run them |
| `traceqa agent "<task>"` | ✓ | Any task in plain words |
| `traceqa run [--req …] [--grep …] [--browser …]` | | Run tests, sort failures, draft bugs |
| `traceqa heal [--run] [--dry-run] [--ai]` | `--ai` | Repair tests broken by UI changes |
| `traceqa heal --apply <HEAL-id>` / `--reject <HEAL-id>` | | Apply or reject a fix proposed by `--dry-run` |
| `traceqa tests` | | List saved tests |
| `traceqa bugs list / show / approve / discard / reopen / file <id>` | | Review bugs; `file` creates the Jira issue |
| `traceqa report [--open]` | | Write the HTML coverage report |
| `traceqa ui [--port 4400] [--open]` | | Dashboard (127.0.0.1 only). Starts with setup in a new folder; uses the next free port if 4400 is taken |
| `traceqa mcp [--project dir]` | | Start the MCP server (AI tools run this) |

All commands accept `--project <dir>`. Otherwise the nearest folder with `traceqa.config.json` is used.

## Requirements

Requirements don't need a special format. Put your documents in `requirements/` as they are (Markdown, text, Word .docx or PDF, in sub-folders if you like) and TraceQA reads them in place. It never rewrites them.

How a document is read:

- **Sections become requirements.** Each heading with content under it is a requirement. Its bullet points, numbered items, table rows, Given/When/Then scenarios and "should / must / shows" sentences become acceptance criteria.
- **Context is skipped.** Introduction, scope, glossary, dependencies, references and similar sections are not requirements. "Acceptance criteria" or "Business rules" sub-headings are merged into the requirement above them.
- **Other shapes work too.** User stories ("As a …, I want …"), a plain numbered list, or a short brief of a few paragraphs.
- **IDs are optional.** If the document has IDs (`REQ-142`, `FR-12`, a Jira key), they are used. Otherwise TraceQA gives each requirement a stable `REQ-…` ID, kept in `.traceqa/requirement-ids.json` (commit it). Editing the document, or inserting a section, doesn't renumber the others.

If you want exact IDs and criteria, the strict form still works and always wins:

```markdown
# Checkout
## REQ-142 Valid coupon applies a discount
- AC1: SAVE10 takes 10% off the total
- AC2: Codes are not case-sensitive
```

**Read with AI** (a button on the document, `traceqa requirements read-ai <file>`, or your AI coding tool through `read_requirement_document` and `save_document_reading`) helps when a document is mostly prose and the automatic reading finds too little. The AI's reading is saved next to the document in `.traceqa/readings/`, uses the document's own words, keeps only IDs that appear in the document, and is marked "Read by AI" for review. The document itself is not changed. If the document changes later, TraceQA goes back to the automatic reading and marks the AI reading as out of date.

Where requirements come from:

- **Your documents**, added to the folder, uploaded in the dashboard (Requirements → Upload document), or with `traceqa requirements import-doc`. Old `.doc` files need saving as .docx first. Scanned PDFs need OCR first. In PDFs, larger text becomes headings.
- **The dashboard editor**, for Markdown and text files, with a live preview of what TraceQA understands.
- **Jira** (Requirements → Import from Jira, `traceqa requirements import-jira`, or the `import_jira_requirements` MCP tool):
  - Uses the Jira site and credentials from the Jira settings. The default query is the open stories of the project; set `jira.requirementsJql` to change it.
  - Each issue becomes a requirement with its Jira key as the ID, grouped by component. Acceptance criteria come from an "Acceptance criteria" section in the description (bullets, or Given/When/Then scenarios), or from a custom field (`jira.acceptanceCriteriaField`, e.g. `customfield_10035`).
  - Jira Cloud and Data Center are both supported. Results go to `requirements/jira/<project>.md`, which is replaced on every sync, so edit requirements in Jira.

## Exploring without requirements

Explorer → **Explore the app…** (or `traceqa explore` without `--req`) lets the agent browse the app like an exploratory tester:

- It visits the main pages and flows, tries edge cases (empty, invalid and long input, going back, repeating actions), and watches console errors and failed requests.
- It records real problems as draft bugs with screenshots.
- With **Also automate the flows it finds** (`--write-tests`), it saves each flow that works today as an E2E requirement (`E2E-001` …) in `requirements/discovered-flows.md`, writes a test per criterion, and runs them.
- **Flows to automate** is optional. Leave it empty to automate every working flow the exploration finds, or enter a number (`--max-flows n`) to stop after that many, most important first. A long run can reach the AI turn limit (Settings → AI agent).
- While it runs, the job page shows where it is (Getting ready → Exploring the app → Automating flows → Running the new tests → Summary), what it is doing right now in plain words (for example “Clicking the button "Add to cart"”), running counts (steps, pages, problems, flows, tests), a timeline of every action, and the latest browser screenshot. The command line prints a heading for each phase.

These flows describe what the app does now, not what it should do. Confirm them with the team; the dashboard marks them "Discovered".

## The standalone AI agent

`explore`, `generate`, `agent`, `heal --ai` and the dashboard's AI buttons run a tool-use loop over the same tools the MCP server offers. Pick the provider in the dashboard under Settings → AI agent, or with `ai.provider` in `traceqa.config.json`:

| Provider | `ai.provider` | Model setting | Key | Cost |
|---|---|---|---|---|
| Anthropic (Claude API) | `anthropic` (default) | `ai.model`, default `claude-opus-5-5` | `ANTHROPIC_API_KEY` | Billed; estimate from list prices |
| OpenRouter | `openrouter` | `ai.openrouter.model`, default `anthropic/claude-opus-5.5` | `OPENROUTER_API_KEY` | Billed; the exact charge OpenRouter reports |
| Ollama (on this computer) | `ollama` | `ai.ollama.model`, e.g. `qwen3` | none | Free |
| LM Studio (on this computer) | `lmstudio` | `ai.lmstudio.model` | `LMSTUDIO_API_KEY`, only if its server requires one | Free |

For every provider:

- **Effort and turns:** effort is `ai.effort` (default `high`; not used by local models) and the turn limit is `ai.maxTurns` (default 60).
- **Unattended:** the agent never approves, discards, files or deletes anything, and never clarifies requirements. Those tools are not offered to it. It skips unclear requirements and says so in its summary.
- **Cost:** every run shows its token use. Paid providers show the cost and need a confirm in the dashboard. Start with one requirement to see what a run costs.
- **Stopping:** Ctrl+C in the CLI, or Stop in the dashboard, ends the run cleanly and closes any exploration browser.

### Anthropic

`ANTHROPIC_API_KEY` from `.env` or the environment; the SDK also accepts `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile. Requests opt in to the API's server-side refusal fallback (`fallbacks: "default"`): if the model declines a request for policy reasons, the API retries on its default fallback model.

### OpenRouter

```json
"ai": {
  "provider": "openrouter",
  "effort": "high",
  "openrouter": { "model": "anthropic/claude-opus-5.5", "dataCollection": "deny", "zdr": false }
}
```

- **Models:** any OpenRouter model that supports tool calling. The dashboard's model picker lists them with their prices, from OpenRouter's public model list.
- **How it's called:**
  - OpenRouter's chat completions API, streamed. `ai.effort` is sent as `reasoning.effort`, and reasoning is passed back on tool calls, as OpenRouter requires.
  - Claude models also get prompt caching and room for 64k output tokens; other models keep their own limits.
- **Privacy:**
  - `dataCollection: "deny"` (the default) only routes to providers that don't store or train on your data.
  - `zdr: true` limits it further to Zero Data Retention endpoints.
  - If no provider for your model matches, the job says so and points to these settings.
- **Differences from Anthropic:** the server-side refusal fallback isn't available. Models other than Claude may follow TraceQA's instructions less reliably, so try one requirement first.

### Ollama and LM Studio (local models)

```json
"ai": { "provider": "ollama", "ollama": { "model": "qwen3", "baseUrl": "http://localhost:11434", "contextLength": 32768 } }
"ai": { "provider": "lmstudio", "lmstudio": { "model": "qwen2.5-7b-instruct", "baseUrl": "http://localhost:1234/v1" } }
```

- **Privacy and cost:** nothing leaves the computer, and there is no cost.
- **Ollama:**
  - TraceQA uses Ollama's native chat API, so it can set the context window (`contextLength`, default 32k). Ollama's own default is too small for TraceQA's tools and page snapshots.
  - Settings → AI agent → Check connection lists the installed models and marks which support tools.
- **LM Studio:** start the server in LM Studio's Developer tab (or `lms server start`), and load the model with a context length of 32k or more. LM Studio loads a downloaded model on first use.
- **Choosing a model:** pick one with tool calling (Qwen, Llama 3.1+ and Mistral have native support). Small models often lose track in long multi-step tasks; larger models do better.
- **Errors:** Ollama or LM Studio not running, a model not pulled, and a model without tool support each give a plain message.

## Healing

`traceqa heal` (or the `heal_tests` MCP tool, or the dashboard button) works like this:

1. It finds tests whose latest failure is **test-broken**, meaning an action could not find its element.
2. It replays each test in a browser.
3. Where an action's locator no longer matches, it swaps in the clearest match on the live page (for example "Apply" → "Apply coupon"). It refuses to guess between close candidates.
4. It re-runs the test. If that doesn't help, the original test is put back.
5. It refreshes the app map, so page objects pick up the new element.

Only action steps are ever changed, never assertions, so healing cannot hide a real app bug. Every heal is recorded in `.traceqa/heals/`, and the changed spec files show up in your git diff for review.

To review fixes before anything changes, preview them (`traceqa heal --dry-run`, or "Preview only" in the dashboard). Each proposed fix then shows the old and new locator, and you apply or reject it one by one. Applying re-runs the test, and if the heal doesn't help, the original test is put back.

## Jira

Add this to `traceqa.config.json`:

```json
"jira": { "baseUrl": "https://yourcompany.atlassian.net", "projectKey": "SHOP" }
```

Optional keys: `issueType` (default `Bug`), `auth` (`basic` or `bearer`), `emailEnv`, `tokenEnv`, `labels`. Put `JIRA_EMAIL` and `JIRA_API_TOKEN` in `.env`. In CI you can instead set `JIRA_BASE_URL` and `JIRA_PROJECT_KEY` as environment variables.

`traceqa bugs file BUG-07` (or the dashboard button, or the `file_bug` MCP tool when you ask your AI tool to) does the following:

- Searches for an open issue labelled for the same requirement criterion (`tqa-REQ-142-AC3`).
- If there is none, creates an issue with steps, expected and actual in Jira's rich-text format, and attaches up to 10 evidence files.
- If there is one, comments on it and attaches the two newest screenshots instead of creating a duplicate.

Nothing is filed without an explicit command.

## Dashboard

Open it by double-clicking `TraceQA Dashboard.cmd` (Windows) or `TraceQA Dashboard.command` (macOS) in the project folder, or with `traceqa ui --open`. `traceqa init` creates the launchers. It serves one page at `http://127.0.0.1:4400`, or the next free port.

Everything the CLI does can be done here, except starting the MCP server:

| Page | Actions |
|---|---|
| Setup (folder without a project) | App address, sign-in, test account, connect AI coding tools |
| Overview | Next step with its button, a button per pipeline step, coverage report |
| Requirements | Create, edit, upload, trash requirement files with a live check; import; map; clarify |
| App map | Analyze or re-analyze |
| Explorer | Each session as a step-by-step timeline with screenshots (click to enlarge and page through), problems marked at the step where they were found, console errors and failed requests |
| Tests | Two views. **By requirement:** each test with the criterion it proves, its steps (actions and checks), latest result and failure reason, and the spec file with the test's own code highlighted. **All tests:** every test in the framework in one list, including Playwright tests written by hand, whether or not they are linked to a requirement, filtered by result and by link, and searchable. Run or remove single tests |
| Runs & heals | Results filtered by outcome and searchable; each failure explains its verdict and shows the error and screenshots; run by requirement, title or browser; heal, or preview and apply or reject each fix |
| Bugs | Edit, approve, discard, reopen, file in Jira |
| AI agent | Explore, write tests, or any task in plain words |
| Jobs | Live progress for AI jobs (phase, current action, counts, activity timeline, latest screenshot), the agent's summary with linked IDs, full technical log, token use and approximate cost, Stop |
| Settings | App address, browsers, sign-in, safety rules, AI provider (Anthropic or OpenRouter) with model, effort, key and privacy, Jira, connect AI coding tools |

How it works:

- **Jobs:** long actions run as jobs, one at a time in order, so they never fight over the browser or the framework. Output streams live; Stop ends the test process and its browsers. History is kept in `.traceqa/jobs/`.
- **Same engine:** jobs call the same tool list as the MCP server, so results match what your AI coding tool would get.
- **Secrets:** passwords, tokens and the API key are written to `.env` and never sent back to the page. Only "set" or "not set" is shown.
- **AI:** every AI button opens a confirm with the model, turn limit and recent spend. The server refuses AI jobs that were not confirmed.
- **Undo-friendly:** removing a test, discarding a bug, filing in Jira and trashing a requirement file all ask first. Trashed files go to `.traceqa/trash/`.
- **Local only:** it listens only on 127.0.0.1 and rejects requests with a non-local Host header (DNS rebinding). Changes need a same-origin request with an `X-TraceQA` header, and the page can't be framed by other sites. Only evidence under `.traceqa/` and `e2e/results/` is served; config and `.env` never are. Don't expose it on a network: it has no sign-in yet.

## MCP tools

`status`, `analyze_app`, `import_requirements`, `import_requirement_document`, `read_requirement_document`, `save_document_reading`, `import_jira_requirements`, `clarify_requirement`, `map_requirements`, `get_requirement`, `get_page`, `explore_start`, `explore_action`, `explore_snapshot`, `explore_record_finding`, `explore_end`, `save_discovered_flow`, `scaffold_framework`, `save_test`, `list_tests`, `remove_test`, `run_tests`, `heal_tests`, `review_heal`, `list_bugs`, `get_bug`, `update_bug`, `file_bug`, `report`. Prompts: `test_requirement`, `triage_failures`.

Tools are defined once in `src/tools/registry.ts`, and the MCP server and the CLI agent both use that list. Tests are saved as structured steps, and TraceQA renders the code from fixed templates, so the framework looks the same whichever AI wrote the test.

## Project files

```
your-project/
├── traceqa.config.json     base URL, browsers, auth, safety rules, ai, jira
├── .env                    test account, API keys (never commit)
├── requirements/           your documents in any format (.md, .txt, .docx, .pdf); jira/ (synced), discovered-flows.md
├── e2e/                    the generated Playwright framework (commit this)
├── TraceQA Dashboard.cmd / .command   double-click to open the dashboard
└── .traceqa/
    ├── app-map.json, requirements.json, requirement-ids.json, traceability.json, tests.json   (commit)
    ├── readings/                                                         AI readings of documents (commit)
    ├── bugs/, heals/
    ├── sessions/, runs/, evidence/, report/, jobs/, trash/, doc-cache/   (git-ignored)
```

## Try it on the Demo Store

See [../examples/demo-store/README.md](../examples/demo-store/README.md). It covers the two planted bugs, a redesigned UI to watch healing, and a fake Jira server.

## Development

```bash
npm test
```

```bash
npm run smoke
```

`npm run smoke` needs the Demo Store running on port 4173. `scripts/mock-jira.mjs` is a stand-in for the Jira REST API, for trying `bugs file` without a real Jira.
