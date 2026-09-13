# Dependency Graph Evaluation

Generated: 2026-09-13T20:16:17.578Z
Scope: subset (264 tools, 230 edges)
Resolve model: google/gemini-2.5-flash · Judge model: openai/gpt-4o-mini

## Methodology

1. **Sample**: 37 edges drawn via stratified sampling across (destination toolkit × decision source: heuristic/llm/llm-proposed), so the eval isn't dominated by the easy cases.
2. **Independent judge**: each sampled edge is judged by openai/gpt-4o-mini — a *different* model than the one used to resolve edges (google/gemini-2.5-flash) — given ONLY the two tools' plain names/descriptions and the two field names/descriptions. It does **not** see the pipeline's own rationale, to avoid rubber-stamping.
3. **Golden-set recall**: 4 hand-authored expected relationships (including both examples from the task's own readme) are checked for presence in the graph, as a recall spot-check (the judge pass above only measures precision on what we *did* produce, not what we missed).

## Precision (LLM-judged sample, n=37)

| Verdict | Count | % |
|---|---|---|
| Correct | 32 | 86% |
| Partial | 0 | 0% |
| Incorrect | 5 | 14% |

**Overall precision score (correct + 0.5×partial): 86.5%**

A public reference implementation of this same task, using pure field-name heuristic matching with no LLM verification, self-reports 60.7% precision on GitHub's 893-tool catalog. For direct comparison, our heuristic-only subgraph (edges with `source: "heuristic"`, i.e. never touched by the LLM verification pass) vs. the full pipeline:

| | Edge count | Precision (of judged sample) |
|---|---|---|
| Heuristic-only edges | 190 | see "heuristic" row below |
| LLM-verified/proposed edges | 40 | see "llm"/"llm-proposed" rows below |

### Precision by decision source

| Source | n (in sample) | Correct | Partial | Incorrect |
|---|---|---|---|---|
| heuristic | 16 | 14 | 0 | 2 |
| llm-proposed | 16 | 13 | 0 | 3 |
| llm | 5 | 5 | 0 | 0 |

### Precision by toolkit

| Toolkit | n (in sample) | Correct | Partial | Incorrect |
|---|---|---|---|---|
| googlesuper | 18 | 16 | 0 | 2 |
| github | 19 | 16 | 0 | 3 |

## Golden-set recall: 75% (3/4)

| Expected relationship | Found? | Matched edge | Note |
|---|---|---|---|
| GOOGLESUPER_REPLY_TO_THREAD.thread_id | ✅ | GOOGLESUPER_FETCH_EMAILS → GOOGLESUPER_REPLY_TO_THREAD | readme's canonical example |
| GOOGLESUPER_SEND_EMAIL.recipient_email | ✅ | GOOGLESUPER_GET_CONTACTS → GOOGLESUPER_SEND_EMAIL | readme's name -> contacts -> email chain |
| GITHUB_ADD_ASSIGNEES_TO_AN_ISSUE.issue_number | ❌ | — | GitHub analogue: issue number from listing/creating issues |
| GITHUB_MERGE_A_PULL_REQUEST.pull_number | ✅ | GITHUB_FIND_PULL_REQUESTS → GITHUB_MERGE_A_PULL_REQUEST | GitHub analogue: PR number from listing PRs |

## Sample judgments (first 10)

- **GOOGLESUPER_LIST_CALENDARS.data.calendars[].id → GOOGLESUPER_PATCH_CALENDAR.calendar_id** (source: heuristic, confidence: 0.83) — **correct**: Tool A's output field provides the unique identifier needed for Tool B's input field.
- **GOOGLESUPER_LIST_SEND_AS.data.sendAs[].sendAsEmail → GOOGLESUPER_SETTINGS_SEND_AS_GET.send_as_email** (source: heuristic, confidence: 0.90) — **correct**: A's output field Y provides the exact email address needed for B's input field X.
- **GOOGLESUPER_EVENTS_GET.data.end → GOOGLESUPER_EVENTS_IMPORT.end** (source: heuristic, confidence: 1.00) — **correct**: A's output field 'data.end' provides the end time needed for B's input field 'end'.
- **GOOGLESUPER_FETCH_EMAILS.data.messages[].threadId → GOOGLESUPER_MODIFY_THREAD_LABELS.thread_id** (source: heuristic, confidence: 0.90) — **correct**: A's output field Y provides the thread ID needed for B's input field X.
- **GOOGLESUPER_FETCH_EMAILS.data.messages[].messageId → GOOGLESUPER_BATCH_DELETE_MESSAGES.messageIds** (source: heuristic, confidence: 0.83) — **correct**: A's output field Y provides the message IDs needed for B's input field X.
- **GOOGLESUPER_LIST_CALENDARS.data.calendars[].id → GOOGLESUPER_CALENDAR_LIST_DELETE.calendar_id** (source: heuristic, confidence: 0.83) — **correct**: Tool A's output field provides the calendar ID needed for Tool B's input field.
- **GOOGLESUPER_FETCH_EMAILS.data.messages[].threadId → GOOGLESUPER_REPLY_TO_THREAD.thread_id** (source: heuristic, confidence: 0.90) — **correct**: A's output field Y provides the required thread ID for B's input field X.
- **GOOGLESUPER_FETCH_EMAILS.data.messages[].threadId → GOOGLESUPER_FETCH_MESSAGE_BY_THREAD_ID.thread_id** (source: heuristic, confidence: 0.90) — **correct**: A's output field Y provides the required thread ID for B's input field X.
- **GOOGLESUPER_LIST_LABELS.data.labels[].id → GOOGLESUPER_BATCH_MODIFY_MESSAGES.removeLabelIds** (source: llm-proposed, confidence: 0.90) — **correct**: Tool A's output provides the required label IDs for Tool B's input.
- **GOOGLESUPER_CREATE_CALENDAR.data.id → GOOGLESUPER_CALENDAR_LIST_INSERT.id** (source: llm-proposed, confidence: 0.75) — **incorrect**: The output field Y provides a calendar ID, while input field X requires a calendar ID in email format.

## Known limitations

- The judge model is itself a fallible LLM, not ground truth — this is a relative quality signal, not a proof of correctness.
- No independent human-labeled test set exists for this exact task; the golden set here is small (n=4) and hand-authored by us, so it's a sanity check, not a rigorous recall measurement.
- Precision-only focus: we don't have a denominator for true recall (how many *real* dependencies exist across the full catalog that we failed to surface at all), only for the golden set.
- Output JSON Schemas are sometimes thin or fully opaque (`additionalProperties: true` with no declared fields, e.g. `GOOGLESUPER_SEARCH_PEOPLE`) — these tools can't contribute schema-derived candidate fields even when they clearly are relevant precursors in practice.
- Category matching is name/structure-based; it will occasionally conflate same-shaped-but-different-meaning fields (e.g. two different numeric IDs that happen to share a normalized root) — the LLM pass catches most of these but not all, especially at low candidate-confidence.
- Scope is currently "subset" — a curated subset, not the full ~1,366-tool catalog; edge quality on unfetched tools is unverified.
