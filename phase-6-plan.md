# Phase 6 plan — Production MatchPilot graph and task API

Prepared: 7 October 2026. Status: implemented; final live API acceptance blocked by provider quota/availability.

## Outcome

A natural-language, read-only task starts through Postman, runs in the background,
uses Gemini to choose generic browser/database tools, and returns a grounded
answer with an ordered trace. This is the production LangGraph, not a temporary
proof graph. Phases 7 and 8 extend this same graph with human resume endpoints and
independent action verification.

Production graph diagram: `backend/docs/phase6-langgraph-flow.svg`.
Its solid paths describe Phase 6; dashed amber paths explicitly describe later
Phase 7/8 additions. The solid routes now match the implemented production graph. Dashed routes
remain future extensions. The full live acceptance check has not passed yet.

The target is to work through Phases 6, 7 and 8 today, in that order. Their completion
still depends on actual tests and Gemini/API availability; do not claim all three
are complete merely to meet the time target. Keep scope on the core agent flows.

## Starting point and scope

- MatchDay manual booking/RSVP, cancellation, waitlist and profile actions work.
- Eight generic Playwright tools, isolated contexts, snapshots, current refs,
  screenshot evidence and approval fingerprints already exist.
- `allowedUrl` again rejects operator/API routes and encoded page paths.
- `createLLM()` exists; the production graph, state, runs, nodes, data/control tools
  are placeholders. Agent HTTP currently exposes health only.
- `AgentRun` already has task/status/goal/criteria/plan/memory/steps/interrupt/result
  fields. Use these fields; no model or shared-utility changes are planned.
- Reuse installed Gemini, LangChain, LangGraph, Zod, Playwright and Mongoose.
  No new dependency, environment/secret edit or website redesign is planned.
- Use mock time from page/config for every business rule. Technical durations may
  use a monotonic process clock; they are not business time.
- No direct database mutation tool and no special-purpose `bookTicket` AI tool.

## Readable AI file organization

Use the user's QuicSplit reference files for writing style and responsibilities,
not business logic. Keep grouped imports, named functions, short helpful comments,
explicit tool lists/binding and chained graph construction. Separate input checks,
model calls, response handling and state updates with meaningful blank lines.

Keep the existing `src/agent/` folder and `graph.js` filename. Do not create a
second `langgraph.js` or rename everything to `ai/`. The four familiar roles are:

| Familiar role | This project's file | Why |
| --- | --- | --- |
| Graph wiring and routing | `agent/graph.js` | Existing planned graph file; named routing functions and clear chained edges |
| Model configuration | `agent/llm.js` | Existing Gemini client factory; add bounded request handling |
| Prompt functions | `agent/prompt.js` (new) | One obvious place for system, understanding and planning prompts |
| Tool definitions | `agent/tools/browser.js`, `db.js`, `control.js`; registry in `tools/index.js` | Browser code already exists; keep explicit schemas/descriptions beside handlers |

The graph has more responsibilities than the earlier two-node example, so node
bodies remain in the already-created `nodes/` files. `graph.js` imports named nodes
and shows the workflow without hundreds of lines of node implementations. Add only
`runtime.js` for live task/session execution, plus a task controller/router for HTTP.
These splits are disclosed here before implementation.

## Files and functions

`~` implement/extend an existing file; `+` add a file. Function names below are the
proposed public/helper names; adjust only when implementation evidence warrants it
and document the final names in the project map.

### Graph, state and prompts

| File | Functions / exports | Responsibility |
| --- | --- | --- |
| `~ agent/state.js` | `AgentState`, `createInitialState(taskId, task)` | Annotation state and initial defaults: task, goal, criteria, assumptions, plan, memory, messages, latest snapshot, pending tool, step count, repeat history, finish flag, verification rounds, status and result |
| `~ agent/graph.js` | `createAgentGraph(dependencies)`, `routeAfterAgent(state)`, `routeAfterGuard(state)` | Construct the production graph with MemorySaver; route tool/no-tool, continuation, finish and failure explicitly |
| `+ agent/prompt.js` | `getUnderstandPrompt(context)`, `getPlanPrompt(context)`, `getAgentPrompt(state)` | Request structured interpretation/planning and one tool per turn; state browser-only actions, read-only DB, mock time and no invented details |
| `~ agent/llm.js` | `createLLM()`, `invokeModel(model, input, options)`, `isTransientModelError(error)` | Keep temperature zero; bounded timeout/backoff for provider 429/5xx, at most four attempts; no duplicate provider-level retry stack |
| `~ agent/nodes/understand.js` | `understand(state, config)` | Structured `{ goal, successCriteria, assumptions, taskKind }`; distinguish discovery/read tasks from requested mutations without inventing missing facts |
| `~ agent/nodes/plan.js` | `plan(state, config)` | Produce a short high-level step list using generic tools; no task-specific branches |
| `~ agent/nodes/agent.js` | `callAgent(state, config)`, `buildAgentMessages(state)` | Bind available tools, provide compact context, require exactly one call; one missing-call nudge, then a guard-visible failure observation |
| `~ agent/nodes/tools.js` | `runTool(state, config)`, `toolObservation(result)` | Dispatch only registered tool names, append a matched ToolMessage, update snapshot/memory/finish intent, and preserve interrupts rather than swallowing them |
| `~ agent/nodes/guard.js` | `guard(state)`, `repeatKey(tool, args, url)` | Count attempts, warn at three identical consecutive calls, fail at five or MAX_STEPS; handle unknown/multiple tools and uncertain mutation observations safely |
| `~ agent/nodes/complete.js` | `complete(state, config)` | Build a terminal read-only answer or honest failure, preserve trace/evidence pointers and close the browser session |
| `agent/nodes/verify.js` | Remains reserved for Phase 8 | No fake verifier or unconditional success stub in Phase 6 |

`createAgentGraph` accepts explicit model/tool dependencies so tests can use the
same production graph with a scripted model. Tests must not construct a second
parallel graph implementation.

Exactly-one-tool enforcement happens in code: reject multiple calls as an
observation without executing any of them. A missing call gets one nudge; repeated
plain replies cannot bypass guard/finish routing. Supply matching tool-call IDs
in ToolMessages. Memory keys/values and observation/history sizes are bounded.

### Data/control tools and run persistence

| File | Functions / exports | Responsibility |
| --- | --- | --- |
| `~ agent/tools/db.js` | `createDbTool(userId)`, `validateQuery(input)`, `validateFilter(filter, fields)`, `serializeRecords(records)` | Generic `db_query` with strict Zod schema, allowlisted fields/collections/operators, bounded results and safe serializable observations |
| `~ agent/tools/control.js` | `createControlTools()`, `remember({key,value})`, `finish({summary})` | Define generic memory and finish intents; tools node applies them to state rather than letting the model mutate arbitrary state |
| `~ agent/tools/index.js` | `createTaskTools(manager, taskId, userId)` plus existing exports | Explicit browser + DB + control tool list and name lookup, bound to the trusted task/account |
| `~ agent/runs.js` | `createRun(taskId, task)`, `recordProgress(taskId, update)`, `appendTrace(taskId, entry)`, `readRun(taskId)`, `readTrace(taskId)` | Create/read/update AgentRun records and ordered node/tool trace entries using existing model fields |

Initially allow the implemented site collections: `users`, `matches`, `bookings`,
`waitlist`, `outbox`, `config`. Do not pretend the optional `issues` collection or
future features exist. Reject `agent_runs` access through the model's data tool.

Read restrictions:

- Accept only `find`-style reads, not arbitrary collection methods or pipelines.
- Validate filters recursively with explicit field/operator/depth limits. Support
  only the needed comparison, bounded `$in`, logical and safe literal-search forms;
  reject `$where`, `$expr`, updates, JavaScript, dotted/prototype keys and unsupported
  nested shapes. Do not pass an arbitrary model-authored object straight to Mongo.
- Limit result count (default 10, maximum 20), bounded strings/response bytes and
  allowed projection fields. Validate numeric/date/ID values against their field
  type; serialize ObjectIds and dates consistently.
- Use bounded literal case-insensitive search instead of unrestricted regex
  execution. Adapt location spelling through observations/model reasoning, not
  hardcoded task handlers or location alias branches.
- Bind private records to the configured account: users by own ID, bookings and
  waitlist by own userId, outbox by account email. Combine trusted scope with the
  validated filter so caller fields cannot override it. Event/config reads are
  public within this fictional world.
- No database writes from `db_query`. AgentRun persistence is trusted runtime
  bookkeeping, not an LLM-exposed tool.

Trace entries contain sequence, node, concise decision/action summary, tool name,
validated args, bounded observation, status and duration. Do not store private
chain-of-thought, keys, provider raw errors or environment contents. Trace summaries
explain what happened; they are not hidden model reasoning.

### Runtime and HTTP

| File | Functions | Responsibility |
| --- | --- | --- |
| `+ agent/runtime.js` | `startTask(task)`, `executeTask(taskId, state)`, `getActiveTask(taskId)`, `closeTask(taskId)`, `closeRuntime()` | Own shared production graph/checkpointer and per-task sessions; run background streams, persist completed-node updates and handle terminal failure/cleanup |
| `+ controllers/tasks.controller.js` | `createTask(req,res)`, `getTask(req,res)`, `getTaskTrace(req,res)` | Validate HTTP input, start the task and return accepted/status/trace responses using existing asyncHandler/apiError/apiResponse |
| `+ agent/routes/tasks.routes.js` | Router registrations | Wire POST `/tasks`, GET `/tasks/:id`, GET `/tasks/:id/trace` |
| `~ agent/index.js` | Existing `startAgent()` and middleware | Mount task routes, keep health accurate, add sanitized API error/404 handling and runtime shutdown cleanup |

POST accepts one bounded nonempty task string and returns HTTP 202 with task ID
and current status promptly. Await initial run creation before returning so GET
cannot race against a nonexistent record. Do not await an entire Gemini task in
the request handler. Reject invalid body shapes and malformed IDs clearly.

Use `thread_id = taskId` consistently and retain the same context/checkpointer
while paused. Detect interrupt stream events and persist `awaiting_approval` with
the real proposal. Phase 7 exposes answer/approve/reject endpoints; do not expose
an unvalidated shortcut in Phase 6. No task may execute a marked click before
approval, even though resume endpoints are not available yet.

Persist after completed graph nodes in the runtime, not as a pre-interrupt side
effect inside the tools node. Resumed nodes re-execute; logging/control dispatch
must not replay a prior website mutation. Use ordered per-task trace writes and
ensure background rejections become failed task records rather than unhandled
process errors. A technical process restart cannot restore browser/checkpoint
sessions; mark or explain interrupted unfinished persisted runs on startup rather
than claiming Mongo traces alone enable restart-resume.

## Exact graph flow and later extensions

Phase 6:

```text
START → understand → plan → agent
agent → tools   (exactly one valid tool call)
agent → agent   (one nudge for no tool)
agent → guard   (still no tool / invalid multiple-call observation)
tools → guard
guard → agent      (continue)
guard → complete   (read-only finish or failure / step/repeat limit)
complete → END
```

Approval still occurs inside the real browser click tool. The graph pauses before
its marked click; that run is not terminal and its session remains alive. Phase 6
can prove the production pause using test-only resume calls, while Phase 7 wires
human HTTP endpoints to the same checkpoint. Resume does not create a new task.

Phase 8 changes the finish branch to `guard → verify`, with `verify → complete`
on pass/exhaustion and `verify → agent` for at most two bounded repair rounds.
Phase 7 adds questions/approval HTTP handling, not a replacement graph.

Phase 6 `finish` is not proof of a persisted action. A grounded read-only task can
end done; an action task cannot be declared successful until Phase 8 independent
verification exists. If it reaches finish early, record an honest failure with the
phase limitation instead of inventing an “unverified done” status. Preserve existing
AgentRun status enums.

## Implementation order

1. Inspect current installed LangGraph/Gemini APIs and official docs. Establish
   the current regression baseline and readable file skeletons.
2. Implement safe `db_query` and run persistence first; check allowlists, ownership,
   serialization, ordered trace updates and failure behavior.
3. Define state, prompt functions and bounded model invocation. Test structured
   understand/plan output and invalid provider responses with a scripted model.
4. Implement named production nodes and graph routing. Use an explicit registry,
   one tool per turn, ToolMessages, compact context and guard limits.
5. Implement runtime and task controller/routes; stream nodes in the background,
   persist status/trace and clean up resources on every terminal path.
6. Run deterministic read-only tasks through the production graph and task API.
   Exercise a marked click pause without an unauthorized mutation.
7. Migrate Phase 5 graph callers to the production graph with scripted model
   dependencies, then remove the redundant testing graph and its old diagram.
8. Run actual Gemini discovery against the seeded website/account, including a
   location spelling variation. Inspect API status, trace and returned source facts.
9. Update README, phase checklist, production SVG and project map with actual
   implemented functions/results. Stop before Phase 7 implementation unless it
   has been separately authorized.

## Testing graph cleanup

There are two earlier graph proofs:

- Phase 1 `graphSmoke()` and its test/script command are redundant now that the
  stronger Phase 5 browser approval checks exist. Remove that code now as the
  user requested; keep Mongo/browser/Gemini smoke functions intact.
- `tests/helpers/phase5-harness.js` is actively imported by `phase5-browser.js` and
  `verify-phase5.js`. Do not delete it while those imports still exist. During
  Phase 6, replace its graph usage with the production `createAgentGraph` and a
  scripted model/test caller, retaining the approval/rejection/changed-target
  assertions. Then delete the harness and historical Phase 5 SVG and remove their
  active documentation references. No replacement throwaway LangGraph.

The temporary retention is a dependency requirement, not an approval requirement.
Removal was explicitly requested; no additional deletion permission is needed for
these specified obsolete artifacts. Do not remove unrelated tests or browser tools.

## Files reserved for verification only

Proposed new testing files: `tests/phase6.test.js`,
`tests/helpers/phase6-model.js` (scripted model responses), and
`scripts/verify-phase6.js` (explicit real-Gemini task/trace probe).
They are testing-only, not extra production agent implementations. Reuse guarded
fixture/test-world patterns where possible; any new isolated DB reset requires
explicit approval and must refuse the normal demo database.

## Tests and acceptance criteria

### Deterministic checks

- Existing website and browser suites stay green after graph migration.
- db_query rejects writes/unsupported operators/collections/prototype keys,
  excessive depth/result size and invalid IDs/dates; private scope cannot be
  overridden. Negative queries produce no site-record changes.
- Structured model output validation, unavailable/unknown/multiple/no tools,
  one nudge, correct tool-call IDs, bounded history and memory.
- Gemini transient retry cap and non-transient immediate failure, using mocked
  provider errors; no real delay-heavy tests or provider calls in npm test.
- Step cap, repeat warning/failure, finish routing and generous recursion backstop.
- A browser success banner alone cannot mark an action task done in Phase 6.
- Run creation, ordered traces, status after nodes, sanitized errors and failure
  persistence; POST 202, GET status/trace, malformed and nonexistent task handling.
- Concurrent tasks keep browser state, memories, traces and approvals separate.
- Production-graph pause preserves the browser; rejection/changed proposal/duplicate
  resume assertions survive removing the Phase 5 graph implementation.
- Read-only completion and failures close sessions. Shutdown closes paused sessions.
  A paused task is not cleaned up as though it had completed.

### Explicit live verification

Run a real Gemini discovery task through the HTTP API: e.g. find upcoming cricket
matches in Bangalore within a stated ticket budget. Also try Bengaluru and inspect
how the agent uses site/DB observations to handle the alternate spelling. Do not
hardcode matching answers, seeded IDs or error strings in the agent.

Compare the returned events/prices/status against actual records, inspect ordered
trace entries and assert no site collection writes. Run records and screenshot
files are expected bookkeeping. The normal demo need not be reset to a pristine
seed to validate its current read-only facts.

Real Gemini calls use the existing configured credentials without exposing them.
If quota/network access prevents a live check, report that limitation; scripted
passes alone do not establish real Gemini integration.

### End product

- Production graph and proposed SVG agree with implemented nodes and routing.
- POST/GET task and trace API works, ready for Phase 7 resume endpoints.
- Grounded read-only natural-language discovery works with real Gemini.
- Browser tools are reused; direct DB actions remain prohibited.
- Temporary Phase 5 graph is removed after successful production-test migration.
- Actual results, function names and limits are documented; no commits/pushes
  or unrelated model/config/frontend changes.

## Implementation record — 7 October 2026

- The planning function remains `plan()` in `nodes/plan.js`; its graph node is
  `makePlan` because LangGraph disallows collision with the `plan` state channel.
- Added Gemini schema adaptation/binding helpers in `llm.js`: execution still
  uses strict original tools, while Gemini receives supported inclusive bounds.
- `db_query.filter` is bounded JSON text to provide a concrete Gemini schema.
- Added `recoverRuns()` for lost in-memory checkpoints and `createAgentApp()` /
  `createRuntime()` injection for testing the production behavior.
- Removed the Phase 5 testing graph/SVG after migrating browser/action checks to
  `tests/helpers/production-approval.js`, a caller of the real production graph.
- Regression/browser/isolated action checks pass. A real Gemini production-graph
  task found the Bangalore ODI at INR 800. Full live HTTP discovery for both
  Bangalore/Bengaluru is blocked by the provider's exhausted 20-request daily quota.
  The live acceptance item remains open. The user authorized Gemini 3.6 Flash
  for testing through a process-only override; all three attempts returned
  overloaded 503 before tools ran. `.env` and credentials were not edited.
