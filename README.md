# TraceQA v0.3

TraceQA is a requirement-driven testing agent for **web apps**. It reads your requirements, maps them to the pages of your app, explores the app in a real browser, writes a plain Playwright framework, runs it, repairs tests broken by UI changes, and traces every result and bug back to a requirement.

Scope is web only: desktop Chromium, Firefox and WebKit. Native mobile apps and mobile emulation are out of scope.

There are three ways in, and all three share the same project files:

- **The dashboard** (double-click `TraceQA Dashboard.cmd`, or `traceqa ui`). Everything can be done with buttons, from first-time setup to filing bugs, so nobody needs a terminal.
- **AI coding tools** (Claude Code, Codex, Cursor, Antigravity, any MCP client). TraceQA runs as an MCP server and the tool's own model does the reasoning, so no extra API key is needed.
- **The CLI** (`traceqa …`). Everyday steps need no AI. `explore`, `generate`, `heal --ai` and `agent` use TraceQA's built-in Claude agent with your Anthropic API key.

The tests it writes are plain Playwright. They run with `npx playwright test`, with no AI involved.

## What's new

| Area | v0.1 | v0.2 | v0.3 |
|---|---|---|---|
| App analysis, requirements, mapping, framework, test runs, coverage report | ✅ | ✅ | ✅ |
| Exploration and test writing from AI coding tools (MCP) | ✅ | ✅ | ✅ |
| Standalone AI agent in the CLI: `explore`, `generate`, `agent`, `heal --ai` | – | ✅ | ✅ |
| Automatic healing of tests broken by UI changes (assertions are never touched) | – | ✅ | ✅ |
| Jira filing with evidence attached and duplicate detection | – | ✅ | ✅ |
| Live dashboard | – | view, run, heal, file | **every action**, see below |
| Heal preview with apply or reject per fix | – | – | ✅ |
| Stop any running job; AI token use and cost per job | – | – | ✅ |
| OpenRouter as the AI provider (Claude or any tool-calling model) | – | – | ✅ |
| Mobile | – | out of scope | out of scope |

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
(add requirement files under requirements/)
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
| `traceqa requirements import` | | Read `requirements/*.md`, flag unclear criteria |
| `traceqa requirements clarify REQ-118 AC1 <text>` | | Save a testable wording agreed with the team |
| `traceqa map` | | Link requirements to pages |
| `traceqa scaffold [--no-install]` | | Create or refresh the Playwright framework in `e2e/` |
| `traceqa render` | | Re-render page objects and specs from the app map and saved tests |
| `traceqa explore --req REQ-142 [--charter …] [--headed]` | ✓ | Explore one requirement in a real browser; findings become draft bugs |
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

## The standalone AI agent

`explore`, `generate`, `agent` and `heal --ai` run a Claude tool-use loop over the same tools the MCP server offers.

- **Provider:** `ai.provider` is `anthropic` (default, the Claude API) or `openrouter`. Change it in the dashboard under Settings → AI agent, or in `traceqa.config.json`.
- **Model:** for Anthropic, `ai.model` (default `claude-opus-5-5`). For OpenRouter, `ai.openrouter.model` (default `anthropic/claude-opus-5.5`). Effort is `ai.effort` (default `high`) and the turn limit is `ai.maxTurns` (default 60), for both.
- **Credentials:** `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` from `.env` or the environment. With Anthropic, the SDK also accepts `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile.
- **Refusal fallback (Anthropic):** requests opt in to the API's server-side fallback (`fallbacks: "default"`). If the model declines a request for policy reasons, the API retries on its default fallback model.

### OpenRouter

```json
"ai": {
  "provider": "openrouter",
  "effort": "high",
  "openrouter": { "model": "anthropic/claude-opus-5.5", "dataCollection": "deny", "zdr": false }
}
```

- **Models:** any OpenRouter model that supports tool calling. The dashboard's model picker lists them with their prices, using OpenRouter's public model list.
- **How it's called:** OpenRouter's chat completions API, streamed. TraceQA sends `ai.effort` as `reasoning.effort` and passes reasoning back on tool calls, as OpenRouter requires. For Claude models it also turns on prompt caching and allows 64k output tokens; other models keep their own limits.
- **Privacy:** `dataCollection: "deny"` (the default) only routes to providers that don't store or train on your data. `zdr: true` limits it further to Zero Data Retention endpoints. If no provider for your model matches, the job says so and points to these settings.
- **Cost:** OpenRouter reports the exact charge for each request; jobs and the CLI show that total instead of an estimate.
- **Differences from Anthropic:** Anthropic's server-side refusal fallback isn't available through OpenRouter. Models other than Claude may follow TraceQA's instructions less reliably, so try one requirement first.
- **Errors:** a rejected key (401), no credits (402), an unknown model, or no matching provider each produce a plain message. Busy or failing providers (429, 5xx) are retried twice.
- **Unattended:** the agent never approves, discards, files or deletes anything, and never clarifies requirements. Those tools are not offered to it. It skips unclear requirements and says so in its summary.
- **Cost:** every AI run is billed to your Anthropic account. Start with one requirement (`--req`) to see the cost. Each run prints its token use and an approximate cost from list prices (Opus 5.5, Sonnet 5.5, Fable 5.1 and Opus 5; other models show tokens only). Your Anthropic Console has the exact bill.
- **Stopping:** Ctrl+C in the CLI, or Stop in the dashboard, ends the run cleanly and closes any exploration browser.

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
| Requirements | Upload requirement documents (Word, PDF, text, Markdown); create, edit, trash requirement files with a live check; import; map; clarify |
| App map | Analyze or re-analyze |
| Explorer | AI exploration with live screenshots |
| Framework | Create or refresh the framework, re-render, run or remove single tests |
| Runs & heals | Run by requirement, title or browser; heal, or preview and apply or reject each fix |
| Bugs | Edit, approve, discard, reopen, file in Jira |
| AI agent | Explore, write tests, or any task in plain words |
| Jobs | Full live output, token use and approximate cost, Stop |
| Settings | App address, browsers, sign-in, safety rules, AI provider (Anthropic or OpenRouter) with model, effort, key and privacy, Jira, connect AI coding tools |

### Uploading requirement documents

**Upload documents** on the Requirements page takes `.docx`, `.pdf`, `.txt` and `.md` files (up to 20 MB each, several at once). Each one is converted to a Markdown file in `requirements/` with the same name, imported, and mapped to pages. Markdown is kept as written. For the other formats:

- A heading or line that starts with an ID such as `REQ-142` becomes a requirement, and its bullets or numbered items become acceptance criteria. Sub-headings such as "Acceptance criteria" under a requirement are dropped, so the criteria stay with it.
- Other headings become feature names.
- Word tables with an ID column (for example `ID | Title | Description | Acceptance criteria`) become one requirement per row.
- PDFs need a text layer, so scanned PDFs can't be read. Lines broken by the page width are joined again, and page numbers are dropped.
- If a file of the same name exists, the dashboard asks first, and the old version goes to `.traceqa/trash/`.
- If no requirement is found, nothing is saved: the converted text opens in the file editor so you can add the IDs.

**Upload document** on the Files page converts a file the same way, but opens it in the editor to check before saving.

How it works:

- **Jobs:** long actions run as jobs, one at a time in order, so they never fight over the browser or the framework. Output streams live; Stop ends the test process and its browsers. History is kept in `.traceqa/jobs/`.
- **Same engine:** jobs call the same tool list as the MCP server, so results match what your AI coding tool would get.
- **Secrets:** passwords, tokens and the API key are written to `.env` and never sent back to the page. Only "set" or "not set" is shown.
- **AI:** every AI button opens a confirm with the model, turn limit and recent spend. The server refuses AI jobs that were not confirmed.
- **Undo-friendly:** removing a test, discarding a bug, filing in Jira and trashing a requirement file all ask first. Trashed files go to `.traceqa/trash/`.
- **Local only:** it listens only on 127.0.0.1 and rejects requests with a non-local Host header (DNS rebinding). Changes need a same-origin request with an `X-TraceQA` header, and the page can't be framed by other sites. Only evidence under `.traceqa/` and `e2e/results/` is served; config and `.env` never are. Don't expose it on a network: it has no sign-in yet.

## MCP tools

`status`, `analyze_app`, `import_requirements`, `clarify_requirement`, `map_requirements`, `get_requirement`, `get_page`, `explore_start`, `explore_action`, `explore_snapshot`, `explore_record_finding`, `explore_end`, `scaffold_framework`, `save_test`, `list_tests`, `remove_test`, `run_tests`, `heal_tests`, `review_heal`, `list_bugs`, `get_bug`, `update_bug`, `file_bug`, `report`. Prompts: `test_requirement`, `triage_failures`.

Tools are defined once in `src/tools/registry.ts`, and the MCP server and the CLI agent both use that list. Tests are saved as structured steps, and TraceQA renders the code from fixed templates, so the framework looks the same whichever AI wrote the test.

## Project files

```
your-project/
├── traceqa.config.json     base URL, browsers, auth, safety rules, ai, jira
├── .env                    test account, API keys (never commit)
├── requirements/*.md       REQ-… headings with AC bullets
├── e2e/                    the generated Playwright framework (commit this)
├── TraceQA Dashboard.cmd / .command   double-click to open the dashboard
└── .traceqa/
    ├── app-map.json, requirements.json, traceability.json, tests.json   (commit)
    ├── bugs/, heals/
    ├── sessions/, runs/, evidence/, report/, jobs/, trash/               (git-ignored)
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
