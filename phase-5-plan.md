# Phase 5 implementation plan — Browser tools and action approval

Prepared: 6 October 2026. Implemented and verified: 7 October 2026.

## Goal and starting point

Give MatchPilot reliable, generic browser tools that can operate the completed
MatchDay website. Prove tool operation and approval enforcement with deterministic
scripts before involving Gemini.

Phase 4 already provides the demo session, profile, booking/free RSVP,
cancellation/refunds, waitlist, and inbox. Its four persisted-action buttons carry
`data-risk="irreversible"`. Tests passed against an approved isolated database;
the user's normal MatchDay seed remains intact. The port-4000 server was restarted
with nodemon and its real session/profile/ticket links were verified.

Existing `agent/tools/browser.js`, `snapshot.js`, and `riskGate.js` are Phase 5
placeholders. Playwright, Chromium, Zod, LangChain Core, and LangGraph are already
installed. Reuse them, existing configuration, and the tested interrupt/resume
pattern. No dependency, model, shared-utility, frontend, or site-controller changes
are planned. Keep the clear spacing requested by the user.

Sources: `phases.md` Phase 5, `MatchPilot_plan_v2.md` sections 9–11 and 16,
`Rules.MD`, and subsequent single-price/profile scope decisions.

## What will be implemented

### 1. Browser session lifecycle

- Create one isolated browser context and page per task, tracked in a Map by
  task ID. A shared Chromium process may host those contexts; cookie/history/page
  state must never cross task boundaries.
- Resolve the main seeded user during setup and set its `uid` cookie before
  browsing. The agent does not need to click Open demo session each run. This
  one identity lookup is setup, not an exposed database tool or mutation shortcut.
- Honor configured `SITE_URL` and `HEADLESS`. Do not edit `.env`. Browser tests use
  headless mode explicitly and the already-installed local Chromium.
- Preserve context/page while a task is paused. Close task resources on success,
  failure, or explicit cleanup; close all contexts/browser on harness shutdown.
- Handle duplicate task setup, unknown/closed sessions, startup failure, and
  repeated cleanup predictably. Prevent concurrent tool executions on one task.
- Validate task IDs before using them in evidence paths. Use a bounded safe
  character set and reject traversal rather than interpolating arbitrary paths.

### 2. Compact snapshots with element references

Implement `snapshot.js` to return a structured snapshot plus a readable text
representation containing:

```text
URL: http://127.0.0.1:4000/matches/...
TITLE: India vs Australia — ODI · MatchDay
SITE TIME: 10 Oct 2026, 2:00 pm IST
ALERTS: (none)
PAGE TEXT: <trimmed visible main content>
ELEMENTS:
[21] link "Back to event"
[22] input "Number of tickets" value="1" type=number
[23] input "Attendee name" value="Demo Student"
[24] checkbox "I confirm the event..." checked=false
[25] button "Confirm booking" risk=irreversible
```

- Discover visible links, buttons, inputs, selects, textareas, and role-buttons
  in the main document. Exclude hidden controls; explicitly identify disabled
  controls and reject attempts to act on them.
- Include labels/accessibility names, control type, current values, checked state,
  select options, link destinations, and risk attributes. Never expose a password
  value if a future page contains one.
- Include alerts and the site-time banner separately so trimming main text cannot
  hide an error or the current business clock. Use bounded output and state when
  content is truncated.
- Assign `data-ref` values from a monotonically increasing per-task counter.
  Each fresh snapshot replaces the active reference map. Old numbers cannot be
  reused for a different element, even after revisiting the same URL.
- Track document changes and element identity. A reference must still point to
  the same live element in the current document; missing/detached/replaced refs
  return a clear observation telling the caller to take another snapshot.
- Snapshots describe current rendered state, not raw HTML or hidden application
  state. No site-specific CSS selectors are exposed as tools to the later LLM.

### 3. Eight browser tools and contracts

All tools are bound to the current task's session. Task selection is controlled
by the caller/harness, not by a model-supplied arbitrary task ID. Validate inputs
with Zod and expose LangChain-compatible definitions for later graph integration.

| Tool | Arguments | Result |
|---|---|---|
| `browser_goto` | `url` | Navigate to allowed MatchDay URL; return fresh snapshot |
| `browser_snapshot` | none | Read current page and build fresh refs |
| `browser_click` | `ref` | Validate target; run risk gate; click; fresh snapshot |
| `browser_fill` | `ref`, `text` | Fill a supported editable control; fresh snapshot |
| `browser_select` | `ref`, `option` | Select a valid option; fresh snapshot |
| `browser_check` | `ref`, `checked` | Check/uncheck a checkbox; fresh snapshot |
| `browser_back` | none | Go back within allowed history; fresh snapshot |
| `browser_screenshot` | `label` | Save screenshot under task evidence directory; return path |

- Tool results report success/error, a concise observation, and the current
  snapshot when available. Validation alerts are observations, not exceptions
  silently swallowed or translated into success.
- Validate control type and option membership before acting. Reject hidden,
  disabled, read-only, missing, stale, and unsuitable targets clearly.
- Refresh after page-changing/input actions; future calls use only the returned
  current refs. Screenshot can report the latest state without needlessly changing
  refs when no page state changed.
- Use bounded waits for navigation/rendering and clear timeout observations.
  MatchDay is server-rendered: wait for navigation where appropriate and for a
  usable document, rather than relying on arbitrary sleeps/network-idle forever.
- Never automatically replay a submitted booking/cancellation/profile/waitlist
  click when its outcome is uncertain. Report uncertainty and inspect the new page
  instead. Any bounded retries are limited to safe reads or unexecuted actions.
- Screenshots use sanitized labels and safe filenames, under
  `backend/evidence/<taskId>/`. No files are written outside that root.

### 4. Navigation boundaries

- Permit only the configured MatchDay origin and website routes needed for the
  current flows: discovery/details/forms, bookings/tickets, inbox, profile, and
  demo-session navigation.
- Block other origins, credential-bearing URLs, non-HTTP URLs, agent API routes,
  and operator `/admin/clock` access. Normalize/validate paths so encoded paths
  or relative-path tricks cannot bypass the restriction.
- Enforce this at browser request/navigation level as well as in `goto`, covering
  link clicks, redirects, back navigation, and popups. Block unsupported popups;
  retain the single owned task page.
- Do not expose arbitrary JavaScript execution, raw HTTP POST, selectors, or
  direct database writes. Form submissions occur through visible page controls.

### 5. Approval gate and action binding

- `browser_click` inspects the actual target's current risk attribute immediately
  before acting. A marked action cannot execute through the tool without approval.
- Before `interrupt()`, do only read-only work: inspect the target, URL, action
  destination, and form values. Do not click, submit, or write site records.
- Pause with an approval payload describing the action, element, page, form
  details, and displayed price/refund where available. Use visible evidence;
  do not invent an amount the page does not show.
- Bind approval to task ID, document/element identity, page URL, form destination,
  target, and submitted form values. On resume, recompute and compare this
  fingerprint before clicking.
- If the form, target, navigation, or visible material action details changed,
  invalidate approval and require a fresh proposal. Approval for one booking
  must not authorize a cancellation, profile save, or another task's action.
- Reject malformed resume values. A rejection returns a visible observation
  without clicking and consumes the pending proposal. A new proposal needs a
  fresh approval; the harness must not automatically retry the rejected action.
- Consume approval once, before executing the intended click. Prevent duplicate
  or concurrent execution/resume from causing multiple submissions.
- Cover all current marked controls: Confirm booking, Cancel booking,
  Join waitlist, and Save profile. This is protection for this known mock site;
  heuristic risk recognition for arbitrary third-party sites remains outside scope.

### 6. JavaScript dialogs

- Install the page dialog handler at session creation.
- Accept a cancellation confirmation only when it belongs to the current approved
  click. Otherwise dismiss it and return the outcome clearly.
- Keep approval state active only for that originating action's execution window;
  clear it in `finally`, including on timeout/failure.
- Preserve the form confirmation checkbox. It confirms form intent but does not
  substitute for the agent tool's approval gate.

### 7. Small LangGraph verification harness

- Build a testing-only graph using `MemorySaver`, `interrupt()`, and `Command`.
  Use the same `thread_id = taskId` for start/resume.
- Check installed exports/current official API documentation before implementing
  the harness. Reuse the proven Phase 1 pattern; do not invent an agent loop.
- Prove that resuming re-executes the interrupted node safely: no mutation occurs
  before the interrupt, and the approved click executes afterward at most once.
- Keep the browser session alive across the pause; do not refresh refs or mutate
  forms during normal resume setup.
- Drive the site with the eight tools and returned refs, not hidden selectors or
  controller calls. Deterministic harness code may choose an element by its
  snapshot label; it then invokes the generic tool using that ref.

## File structure

`+` new; `~` implement/modify an existing placeholder. Keep responsibilities
separate without creating an unnecessary framework.

```text
backend/
  src/agent/tools/
    + sessions.js                 session Map, cookie setup, lifecycle
    ~ snapshot.js                 readable page state and active ref mapping
    ~ browser.js                  eight validated browser tool operations
    ~ riskGate.js                 interrupt, fingerprint, approval consumption
    + navigation.js               origin/path/request boundaries
    ~ index.js                    export browser tool factory/registry
  tests/
    + phase5.test.js              schemas, boundary and lifecycle checks
    + phase5-browser.js           explicit local Chromium/ref/dialog checks
    helpers/
      + phase5-harness.js         testing-only checkpointed approval graph
      + phase5-world.js           guarded isolated MatchDay_phase5_test setup
  scripts/
    + verify-phase5.js            tool-only approved/rejected action flows
  docs/
    + phase5-langgraph-flow.svg   testing graph and its approval/resume flow
  ~ README.md                     tools, setup, harness, limits and results
phase-5-plan.md                    this document
~ phases.md                       verified Phase 5 completion record
```

Do not implement the production graph in `agent/graph.js`, real `nodes/tools.js`,
control/data tools, task APIs, or Gemini reasoning in this phase. The browser
registry is prepared for those later phases; its internal runtime remains generic.
Do not repurpose the Phase 4 database helper without explicit scope: the Phase 5
helper follows its safety pattern but selects its own guarded test database.

## Implementation order

| Step | Work | Completion check |
|---|---|---|
| 1 | Baseline tests, installed API inspection, session lifecycle and navigation boundary | Isolated contexts, uid, allowed navigation and cleanup work |
| 2 | Snapshot text, labels/values/options/alerts/time and refs | Snapshot describes real UI; stale refs cannot target another element |
| 3 | Read/input tools and screenshots | Tool-only discovery/filter/form fill works with refreshed refs |
| 4 | Click gate, fingerprints and dialog binding | Unapproved marked clicks never execute; changed proposals invalidate approval |
| 5 | Checkpointed harness and approved/rejected flows | Pause/resume retains task/session; one approved intended mutation |
| 6 | Isolation, failures, cleanup, boundary and adversarial checks | No cross-task approval/session leakage or forbidden navigation |
| 7 | Regression and final documentation | Record actual results, screenshot paths and any blocked checks |

The initial planning step made no source edits or test runs. Implementation was
subsequently authorized by the user. No commits or pushes without an explicit
request. Phase 6 does not start automatically.

## Tests and verification

### Offline/unit checks

Run existing `npm test` before and after implementation. Cover tool schemas,
URL/path normalization, unsafe task/label paths, missing sessions, malformed refs,
control-type mismatches, approval payload validation, fingerprint comparisons,
and single-use proposal rules. Test behavior rather than duplicating implementation.

### Local browser checks

Run an explicit testing-only Chromium harness against controlled local pages
without MongoDB. Check:

- Semantic names, visible/hidden/disabled controls, checkbox states, select
  options, alerts, mock-time extraction, trimming, and screenshot path safety.
- Navigation, fill/select/check/click/back and fresh snapshot behavior.
- Old refs after a new snapshot, rerender/replaced element, navigation, and
  returning to the same URL: none silently act on a different target.
- Safe timeout/error observations and no blind resubmission.
- Allowed-origin navigation; blocked admin/external/encoded paths, redirects,
  popups, and back history. Tests use local simulated pages, not real third parties.
- Separate contexts and independent refs/cookies for two task IDs; cleanup,
  duplicate cleanup, failed startup and unknown-task errors.
- Dialog dismissal without approval; acceptance only for the approved originating
  click; approval cleared after errors/completion.
- Desktop and mobile snapshots, including the menu's hidden/shown controls.

### Real tool-only action verification

Use an explicitly approved isolated `MatchDay_phase5_test` database. The helper
must refuse the normal MatchDay database, system databases, and setup without the
exact reset confirmation. Do not mutate the user's demo world or reset it silently.

Drive the complete flows using snapshot refs and browser tools:

1. Discover/filter matches; inspect policies/inventory/time; fill a booking form.
2. Attempt Confirm booking; graph pauses. Query DB directly from the test harness
   to assert no inventory/booking/outbox changes before approval.
3. Resume with approval; inspect the ticket/inbox through browser tools and assert
   exactly one correct booking, inventory increment, and confirmation in MongoDB.
4. Repeat with rejection; assert no mutation and a clear rejection observation.
5. Change quantity/attendee details, target or page after the pause; old approval
   cannot execute the changed action. A fresh proposal is required.
6. Try duplicate/concurrent resumes and cross-task approval reuse; assert at most
   one intended write and no action in the other task.
7. Exercise free RSVP, approved full/zero-refund cancellation, waitlist, and profile
   save through the same generic tools. Verify their records and outbox where
   applicable; no special-purpose booking/profile agent tools are introduced.
8. Reject cancellation and prove both booking and inventory stay unchanged;
   unapproved dialogs are dismissed.
9. Trigger a site validation error or stale ref; capture the observation and
   recover with a fresh snapshot without matching a hardcoded error string.
10. Close all sessions at the end, including failures; confirm no orphan browser
    pages/contexts remain.

Direct DB assertions belong to the testing harness only. They do not implement
or substitute for the independent agent verification node planned for Phase 8.
New tests/helpers/scripts are testing-only artifacts and will be flagged in the
implementation report. Format changed files and run `git diff --check`.

## Final flow and end product

```text
Task ID → isolated browser session + demo cookie
          → navigate → snapshot → choose ref
          → fill/select/check → refreshed snapshot
          → click
              ├─ ordinary target → execute → refreshed snapshot
              └─ marked target → inspect proposal → interrupt
                                  ├─ reject → observation, no write
                                  └─ approve → recheck fingerprint
                                               → one click → handle dialog
                                               → refreshed snapshot
          → screenshots / test assertions → cleanup
```

At the end, deterministic scripts can operate MatchDay entirely through generic
browser tools, pause before a persisted action, approve or reject it, recover from
stale refs/site errors, and retain evidence. The LLM is not involved yet. The user
continues using the existing website normally; the Postman task API and real
natural-language agent arrive in the following phases.

Phase 5 is complete when its offline/local-browser checks and real isolated
approved/rejected action checks pass, no unapproved action occurs, changed or
reused approvals fail safely, session isolation/cleanup hold, and observed results
are documented.

## Implementation and verification record — 7 October 2026

- Completed the eight task-bound LangChain browser tools, isolated sessions,
  visible snapshots and fresh refs, navigation/redirect restrictions, approval
  fingerprints, dialog handling, and screenshot evidence.
- Kept the graph testing-only in `tests/helpers/phase5-harness.js`; generated and
  visually checked `backend/docs/phase5-langgraph-flow.svg` in the requested style.
- `npm test`: all 40 tests passed, including existing website regressions.
- Explicit local Chromium suite: all nine reported tests passed. It checks real
  input/select/checkbox/history/screenshot tools, hidden/disabled/readonly controls,
  stale and detached refs, blocked routes/redirects/popups, approval rejection,
  changed fields/risk attributes, malformed/cross-task/duplicate/concurrent
  resumes, timeout recovery, dialog permission cleanup, and isolated cookies.
- Approved real action runner in `MatchDay_phase5_test`: nine scenario groups
  passed, covering discovery, rejection without writes, paid/free booking,
  cancellation/refunds, waitlisting, profile save, changed proposals, duplicate
  resumes, site validation, and the real mobile menu. Database assertions check
  records, inventory and receipts; cleanup leaves zero sessions.
- The normal `MatchDay` database was only read for a separate seed comparison.
  That checker failed because the current demo has 17 outbox entries versus the
  seed's 16, and one event's inventory differs. Its clock still matches the seed.
  No reset or correction was performed; this does not affect the isolated Phase 5
  checks. No claim is made that the current demo is a pristine seed.
- No Gemini calls, production graph/task API, new dependencies, website behavior,
  models, shared utilities, environment files, or seed implementation changes.
