# Phase 7 — Human questions, approvals and safe resume

Status: implemented, 8 October 2026. Local/API/browser checks passed; live
provider acceptance remains incomplete after a 429. The verification slice
agreed after this plan was written is included below.

## Outcome

Submit a task through Postman, answer a missing-detail question, approve or reject
a concrete website action, and continue the same task/browser/checkpoint. The
agent must never invent attendee details or execute a marked submission before
approval. Phase 8 will independently verify action success.

The user has accepted the current phase checks and requested the next plan.
The last live result recorded in this conversation remains an incomplete Groq
run; this plan does not retrospectively mark that acceptance check as passed.

## Existing foundation

- Production graph and MemorySaver already exist; thread_id equals taskId.
- riskGate.js already interrupts before marked clicks, creates a proposal ID,
  fingerprints form/target details, and rechecks them before an approved click.
- runtime.js retains browser/checkpoint resources when an approval interrupts.
- AgentRun already supports needs_input, awaiting_approval and pendingInterrupt.
- Task API already supports creation, status and ordered traces.
- Groq and Gemini are selectable. No new provider or dependency is required.

## Files and functions

Keep the current agent folder arrangement: llm.js configures the model,
prompt.js contains prompts, graph.js wires named nodes, nodes/tools.js dispatches
tools, and tools/ contains their definitions. No new graph or node split is
needed. Use short named functions and blank lines between logical sections.

| File | Planned work |
| --- | --- |
| backend/src/agent/tools/control.js | Add ask_human and request_approval definitions beside remember/finish. Handlers pause using interrupt(), validate the resumed response, and return a bounded observation. |
| backend/src/agent/verification.js | Capture stable read-only baselines, derive the approved action and check actual records, receipts, inventory and unrelated changes. |
| backend/src/agent/nodes/verify.js | Run deterministic checks, then a separate structured read-only assessment of every criterion using the latest human clarifications. |
| backend/src/agent/tools/riskGate.js | Reuse approveClick/inspectAction. Present readable action details and preserve target/form fingerprint validation. Explicit approval requests may prepare a proposal, but cannot grant blanket permission to later clicks. |
| backend/src/agent/tools/browser.js | Preserve rejection/changed-proposal outcomes as clear observations so guard stops them; ensure an approved click executes once. |
| backend/src/agent/nodes/tools.js | Handle human-answer observations as matched ToolMessages; retain answered facts in task state/memory without treating answers as blanket approval. |
| backend/src/agent/runtime.js | Add resumeTask and a shared graph-stream execution path. Continue with Command({ resume: payload }) using the same thread and browser. Classify input versus approval interrupts and lock concurrent resumes. |
| backend/src/controllers/tasks.controller.js | Add answerTask, approveTask and rejectTask handlers with strict body/task-ID validation and existing response/error utilities. |
| backend/src/agent/routes/tasks.routes.js | Register POST /:id/answer, /:id/approve and /:id/reject. |
| backend/src/agent/prompt.js | Teach when to ask, how to use answers, how to assess budget/refund/overlap, and how to stop after rejection. |
| backend/src/agent/nodes/guard.js | Preserve error/action caps and finish-only turn; stop denied or uncertain submissions rather than suggesting another attempt. |
| backend/src/agent/runs.js | Reuse existing fields to persist/clear pendingInterrupt and keep trace sequence increasing across resumes. |
| backend/src/agent/state.js | Add only graph-state fields actually needed for human responses, if existing memory/messages are insufficient. No Mongoose schema change planned. |
| backend/src/agent/graph.js | Keep existing nodes/routes; document interrupt/resume behavior and update trace summaries as needed. |
| backend/README.md | Document request bodies, paused statuses, restart limitations and a complete Postman sequence. |
| backend/docs/phase7-langgraph-flow.svg | Maintain the Phase 7 graph diagram, distinguishing planned versus implemented behavior. |
| backend/tests/phase7.test.js | Testing only: deterministic tests against the production graph/runtime/API. No separate testing graph. |
| backend/scripts/verify-phase7.js | Testing only: explicit browser/isolated-database integration runner. Never reset the normal demo database. |
| backend/postman/phase7.collection.json | Importable task, status, answer, approve, reject and trace requests. |

Proposed runtime helper responsibilities:

- resumeTask(taskId, expectedType, response): require an active paused task,
  validate the interrupt identifier/type, reserve the resume lock, persist
  running status, and schedule continuation.
- Shared stream handler: start with initial state or resume with Command,
  persist node updates, classify pauses, append traces using one task-wide
  sequence counter, and clean up only terminal tasks.
- Human tool handlers: create one stable pending question/proposal per pause;
  perform no website mutation before interrupt. Reexecution on resume must not
  create a different question ID or proposal ID.

## Request contracts

POST /tasks remains {"task":"..."}, returning 202 with taskId.

GET /tasks/:id exposes one pendingInterrupt:

- needs_input: type=input, questionId, question, optional choices.
- awaiting_approval: type=approval, proposalId, action, event/booking identity,
  quantity, total/free status or refund, relevant policy/conflict and exact
  destination/form details available from the current page.

POST /tasks/:id/answer accepts {"questionId":"uuid","answer":"bounded text"}.
POST /tasks/:id/approve accepts {"proposalId":"uuid"}.
POST /tasks/:id/reject accepts {"proposalId":"uuid"}.

All resume endpoints return 202 once continuation is accepted. The server
constructs approved=true/false; callers cannot use the answer endpoint to inject
an approval payload. Reject extra fields and malformed bodies (400), absent
tasks (404), and mismatched/stale/nonpaused/concurrently resumed requests (409).
No GET request advances execution.

## Flow

1. Controller accepts task; runtime starts existing graph.
2. understand → makePlan → agent chooses ask_human for genuine ambiguity or
   required missing attendee/contact details.
3. Tool interrupts; runtime saves needs_input, retains browser/checkpoint and
   exposes the question. No additional model requests run while paused.
4. /answer validates the question and resumes the same thread. The response
   becomes a tool observation; agent continues with the existing context.
5. Agent inspects the event/form and fills it using existing browser tools.
6. A marked browser click triggers the existing risk gate and exposes a
   concrete proposal. request_approval must converge on this same action gate,
   not create reusable permission detached from a target/form fingerprint.
7. /approve resumes; gate rechecks unchanged details, then executes the click.
   /reject resumes into a denied-action outcome and stops without a mutation.
8. Tool result → guard → agent, or terminal cleanup. A changed proposal or
   uncertain submission stops without blind retry.
9. Action finish routes through the agreed verification slice before completion.
   Only consistent records and supported criteria allow done. Failed checks stop;
   automatic repair loops and the separate evidence endpoint remain Phase 8.

No tier selector is added. Paid matches retain one price and free screenings
retain zero-cost entry. Existing waitlist/profile workflows use the same gates.

## Implementation order

1. Read existing approval/browser tests and run the current regression suite.
2. Add strict human tool contracts and stable interrupt payloads.
3. Refactor runtime stream handling minimally for start/resume, persistent
   trace ordering and a per-task resume lock; preserve rate limiting and cleanup.
4. Add answer/approve/reject controllers/routes and status classification.
5. Update prompts and guard feedback for ambiguity, attendee details, budgets,
   policy text and time overlaps. Do not hardcode event IDs or task cases.
6. Add deterministic API/graph tests, then real browser/DB checks.
7. Run one bounded live LLM interaction when provider availability permits.
8. Update README, Postman collection, project overview and SVG to match the
   implemented result. Record passed versus blocked checks accurately.

## Tests

- Ambiguous event → question → answer → same task/thread/browser continues.
- Missing attendee details produce a question; no fabricated contact data.
- Approval pause performs zero mutations; changed form/target fails approval.
- Approve executes at most one intended submission; duplicate/concurrent
  resumes cannot replay it. Test race while continuation is in progress and
  stale resume after completion or a subsequent pause.
- Answer cannot approve; approve cannot answer; wrong identifiers/types fail.
- Reject leaves booking/inventory/outbox unchanged and does not retry the action.
- Quantity recovery produces an updated form and a new concrete proposal.
- Zero-refund cancellation clearly exposes refund before approval.
- Overlapping booking asks for explicit confirmation using site/mock-clock
  records; never guesses a conflict from titles or dates alone.
- Paid booking, free RSVP, cancellation, waitlist and profile update all pass
  through their marked action gates.
- Question/approval pauses consume no additional model requests or action turns
  until resumed. Resources remain while paused and close on terminal/shutdown.
- Traces remain strictly ordered across multiple pauses; pendingInterrupt clears
  on resume/terminal completion. Restart fails old paused runs honestly because
  current MemorySaver/browser resources cannot be restored across processes.
- Provider errors, step cap, repeat detection and final-turn restrictions remain
  enforced. No model, field, shared utility or environment changes are planned.

Use the production graph with scripted responses for deterministic coverage.
Integration tests require an explicitly approved isolated test database/reset;
read-only checks can use the normal demo. Capture DB state before/after negative
cases and count mutations for approved cases. Formatting and affected existing
tests must pass before the bounded live check.

## End product

A Postman-driven agent that asks understandable questions, waits without running
in the background, resumes the same task, requests concrete approvals, and never
replays an approved or rejected submission. The initial verification slice checks
one approved action independently; Phase 8 extends evidence and bounded repair.

## Implementation record — 8 October 2026

The agreed verification slice was brought forward: verification.js captures
read-only baselines and derives approved action details; nodes/verify.js checks
the records and runs a separate structured goal assessment. Action finish now
routes through verify before complete. Initial scope is one persisted action
per task with terminal failure on inconsistent evidence; repair loops and the
evidence endpoint remain later work. No separate testing graph was created.

ask_human, request_approval, answer/approve/reject API, stable question/proposal
identifiers, same-thread/browser resume, ordered traces, bounded clarifications,
duplicate-resume locking and shutdown/persistence race handling are implemented.
The risk gate's form destination fallback was corrected: an explicit button
override wins, otherwise the form action is fingerprinted and checked.

68 regression tests, nine Chromium tool tests and nine isolated real
browser/API/database scenarios passed. Tests cover questions, paid/free actions,
refunds, waitlist, profile, overlapping events, rejection, changed details,
missing/inconsistent records, duplicate resumes and cleanup.

The single capped live provider check used seven requests and failed with 429
at the agent node before approval. That is not a live acceptance pass; no further
retry was made. Only MatchDay_phase5_test was reset/modified by action checks;
the normal demo, credentials, models and shared utilities were untouched.

Current diagram: backend/docs/phase7-langgraph-flow.svg.
Postman collection: backend/postman/phase7.collection.json.
