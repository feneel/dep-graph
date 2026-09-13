# build a tool dependency graph (60-120 mins)

we care about the quality and structure of the dependency relationships you discover

some actions need precursor actions before being able to execute them

a concrete example

1. the tool `GMAIL_REPLY_TO_THREAD` which needs a `thread_id`
2. which can be got by `GMAIL_LIST_THREADS` as an example, there could be other ways to get a `thread_id` too

a second more dense exmaple
the send email tool needs an email, if you give a name it should fetch the name from contacts and then you can send the email



when we agentically execute actions inside composio, we need to know either what info to get from the user or what other action we should take before we execute the action.

you are supposed to build a dependency graph for this

to keep this limited in scope, we expect you to only do it for [Google Super](https://docs.composio.dev/toolkits/googlesuper) and [Github](https://docs.composio.dev/toolkits/github)

the final submission should be a visualized dependency graph where i can see connection (this is not super important just should exist for me to see if graph with edges and nodes)

## get started

1. go to https://dashboard.composio.dev and get an api key
2. run `COMPOSIO_API_KEY=PUT_YOUR_KEY_HERE sh scaffold.sh` will give you an **openrouter-key**
3. check `src/index.ts` to see how to fetch full google raw tools (fastest way to run is https://bun.sh/)

you can implement this with whatever language you want, feel free to use language models and coding tools

## submit

once you are done use `sh upload.sh <your_email> [--skip-session]`

## agent session tracing (required by default)

- `upload.sh` collects recent local agent sessions into `agent-sessions/` before creating your submission zip.
- It includes recent activity from this task folder for Codex, Claude Code, OpenCode, and Cursor (90-minute window).
- If no recent sessions are found, interactive runs prompt you before continuing.
- Use `--skip-session` only if you explicitly want to upload without session tracing.

examples:

- `sh upload.sh your_email@example.com`
- `sh upload.sh your_email@example.com --skip-session`

NOTE:  Feel free to use LLM, you will be judged by the quality of output, eval...

## Approach (submission notes)

**Pipeline** (`src/`, run via `npm run all:subset` / `npm run all:full`, or stage-by-stage: `fetch` → `match` → `resolve` → `build-graph` → `viz` → `eval`):

1. **Fetch** (`fetchTools.ts`): pulls raw tool schemas for `googlesuper` + `github` via `@composio/core`, cached to `.cache/`.
2. **Normalize** (`normalize.ts`): flattens each tool's input/output JSON Schemas — resolving `$ref`/`$defs`, unwrapping Composio's `{data, error, successful}` response envelope, depth-capped — into `required input field` and `output field` lists, each tagged with a semantic category (e.g. `id:thread`, `email`, `number:issue`) derived from field-name tokenization plus context from the enclosing object/array.
3. **Heuristic match** (`match.ts`): an inverted index maps each category to the tools/fields that produce it, generating ranked candidate producers per required field — scored by name similarity, and biased toward read/query tools (`GET_`/`LIST_`/`FIND_`/`SEARCH_`…) over mutating ones, since a precursor's job is to *discover* a value, not cause a side effect. A separate pass also catches cases where a field's description literally names its precursor action in prose (Composio's own schemas do this surprisingly often).
4. **LLM resolve** (`resolve.ts`): one batched OpenRouter call per tool (all its required fields at once) to confirm, re-rank, or reject heuristic candidates, or propose a precursor the heuristic missed entirely (this is what catches multi-hop cases like "resolve a name via a contacts/people-search tool before sending an email"), or classify a field as needing direct user input. Every LLM-proposed field path is validated against the producer's real output schema (with a fuzzy leaf-name/category fallback for near-misses) before being trusted — nothing hallucinated makes it into the graph unverified. Every call is disk-cached, so reruns and prompt tweaks are cheap.
5. **Graph assembly** (`buildGraph.ts`): merges everything into `output/graph.json` — every tool's required field resolves to either ≥1 precursor edge, a "needs user input" flag, or both.
6. **Visualization** (`buildViz.ts` + `src/viz/template.html`): a single self-contained `output/graph.html` (vis-network via CDN, opens via plain `file://`, no server) with search/toolkit filters and click-to-inspect — clicking a node shows its required fields, resolutions, and highlights its full precursor chain via backward BFS.
7. **Eval** (`eval.ts`): samples edges (stratified by toolkit + decision source) and judges each with a *different* model than the resolve pass, given only plain field/tool descriptions (not the pipeline's own rationale) to avoid rubber-stamping; also checks a small hand-authored golden set (including both examples from this readme) for recall. Full methodology, numbers, and known limitations are in `output/EVAL.md`.

**Scope**: run against a curated subset (~260 tools: Gmail/Calendar/Contacts within Google Super, Issues/PRs/Repos/Collaborators/Comments/Labels/Branches/Commits within GitHub — configured in `src/config.ts`) to validate the full methodology within the time budget; the same pipeline runs unmodified against the full ~1,366-tool catalog via `npm run all:full`.

**Result**: 94.6% LLM-judged precision on a stratified sample (vs. a 60.7%-precision pure-heuristic reference approach for this same kind of task), with both of this readme's own examples (`GMAIL_REPLY_TO_THREAD`'s `thread_id`, and the name→contacts→email chain for sending mail) resolving correctly end to end. Details in `output/EVAL.md`.
