# MatchDay and MatchPilot backend

Phase 1 establishes the servers and proves the stack. The source plan is
[MatchPilot_plan_v2.md](../MatchPilot_plan_v2.md), the build order is
[phases.md](../phases.md), and project rules are in [Rules.MD](../Rules.MD).
These existing documents retain their original names.

Use Node.js 20.19 or later (Node 22 or 24 is recommended for this project).
From `backend/`, run `npm ci`, then `npm run install:chromium`.
Configure your existing `.env` using `.env.example` as a reference; do not
overwrite a working environment file. Keep credentials private.

Required settings for the full Phase 1 check are `MONGODB_URI`,
`GEMINI_API_KEY`, and `STUDENT_EMAIL`. Defaults are `SITE_URL=http://localhost:4000`,
`SITE_PORT=4000`, `AGENT_PORT=5000`, `MAX_STEPS=25`, and `HEADLESS=false`.
`PORT` from the previous bootstrap no longer sets the MatchDay port;
use `SITE_PORT` if necessary and keep `SITE_URL` aligned with it.
The Gemini model defaults to `gemini-2.5-flash` and can be set with `GEMINI_MODEL`.
The database connection preserves the URI and selects `DB_NAME` explicitly
through Mongoose's `dbName` option, including when the URI ends in a slash or
contains query parameters.

Run `npm run check:config` to validate configuration without printing values.
Gemini and student settings are required by the full configuration check;
the two base servers only require MongoDB and valid runtime settings.

Start the servers in separate terminals:

```sh
npm run start:site
npm run start:agent
```

Open `http://localhost:4000` for the EJS placeholder page. Health endpoints are
`http://127.0.0.1:4000/health` and `http://127.0.0.1:5000/health`; they return
503 if MongoDB is disconnected. Both servers connect to MongoDB before listening
and bind to localhost. `npm run dev` starts the site with nodemon;
`npm run dev:agent` does the same for the agent API.
Use `127.0.0.1:5000` for Postman on this Mac: `localhost:5000` resolved to a
different local service during verification and returned 403.

The planned layout is adapted to the existing backend:

```text
backend/
  src/
    config.js              environment loading and validation
    server.js              shared startup/shutdown helpers
    index.js               site startup compatibility entry point
    db/index.js            existing MongoDB connection
    site/
      server.js            MatchDay Express/EJS server
      lib/clock.js         Phase 2 placeholder
      models/ routes/ views/ seed/
    agent/
      index.js             MatchPilot API base server
      llm.js               Gemini model factory
      graph.js state.js runs.js prompts/ nodes/ tools/
  scripts/                 configuration and smoke checks
  tests/                   offline Phase 1 tests
  evals/                   later-phase evaluation placeholders
  postman/                 future exported Postman collection
  evidence/                generated screenshots, gitignored
```

Run `npm test` for configuration, site/API behavior, validation and browser-tool unit tests.
Run `npm run format` to apply the backend Prettier configuration, or
`npm run format:check` to check formatting without editing files. JavaScript uses
four-space indentation, double quotes, and semicolons; JSON uses two spaces.
Formatting targets backend JavaScript/JSON and this README, and excludes
environment files, dependencies, generated evidence, and the lockfile.
Run `npm run smoke` for the three independent integration checks, or choose
`smoke:mongo`, `smoke:gemini`, or `smoke:browser`.
For automated browser checks use `HEADLESS=true npm run smoke:browser`.
The browser check opens only an ephemeral local MatchDay page and writes
`evidence/phase1/playwright.png`. Mongo smoke only pings the database.
Gemini smoke calls one harmless dummy tool and sends its result back to the model.
Graph smoke pauses with `interrupt()` and resumes via `Command` using
`MemorySaver` and the same unique `thread_id`.

Verification performed on 6 October 2026: all six offline tests passed;
Mongo ping, Chromium rendering/screenshot, and LangGraph pause/resume passed;
both actual server entry points started on ports 4000 and 5000 with connected
Mongo health responses. After the user configured `GEMINI_API_KEY`, full
configuration validation and Gemini dummy-tool calling also passed. All Phase 1
runtime completion checks now pass. The lockfile remains uncommitted.
Chromium is installed inside `node_modules` via `PLAYWRIGHT_BROWSERS_PATH=0`.

Phase 1 has no task execution, bookings, seed mutations, or evaluation workflows.
Seeding is now implemented in Phase 2; `npm run evals` still exits unsuccessfully
with its owning phase explained.
The Postman directory contains only a placeholder; the collection is Phase 8.
Existing utilities and legacy `src/app.js` are preserved.

The current Dockerfile still uses Node 18 and Compose exposes port 3000.
Use the local commands above for Phase 1. Docker alignment is pending; neither
the frontend nor the shared Compose setup is changed by this backend work.

Official API references checked for Phase 1:
[LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
and [Google GenAI integration](https://docs.langchain.com/oss/javascript/integrations/chat/google_generative_ai).
Installed imports are exercised by the graph and Gemini smoke scripts.

## Phase 2: models, mock clock, and seed data

Scope update on 6 October 2026: ticket tiers are deferred as bonus features.
Each match now has one `price`, `capacity`, and `sold` value; bookings and
waitlist entries refer directly to the match without a tier. Fan-arena screening
tickets cost zero. The former tier schema/fields, indexes, and seed definitions
are preserved as comments marked "Bonus features to be looked on later".
Seed booking totals and confirmation bodies use the event's single price.
The India ODI retains two available seats; Hyderabad remains sold out with
17 seats; London has 20 seats with 12 sold. Main-user booking totals and refunds
are unchanged. Ground truth and Phase 2 tests/verification use this contract.

This source-code update does not migrate or reset stored MongoDB data. Existing
tier-shaped records need an explicitly approved demo reseed before live data
verification or Phase 3 browsing uses the new fields. Old tier-based waitlist
indexes may remain in an existing database; the seed creates the new event-level
indexes without dropping old indexes. Removing those redundant indexes is a
separate database maintenance action. The earlier live verification below applies
to the original tier-based seed, not this revised data contract.

The working demo database is `MatchDay`, as configured in `src/constants.js`.
The MongoDB URI and environment file are preserved; explicit `dbName` selection
ensures a trailing slash cannot select an unintended database. Models live in
`src/site/models`; clock controllers use the existing `src/controllers` folder
and the existing API utilities. No dependencies were added for Phase 2.

Models follow Rules.MD section 10: `import mongoose, { Schema }`, a local
`const ...Schema = new Schema(...)`, and named exports such as
`export const Booking = mongoose.model("Booking", bookingSchema)`.
`models/index.js` only re-exports those models; it does not build models or
connections dynamically. The clock model validates its ISO string directly
with Mongoose and a named date validator, without Zod. Explicit collection
names are retained only for `waitlist`, `outbox`, `config`, and `agent_runs`
so queries keep using the already seeded collections. Business timestamp
requirements and the active-booking uniqueness index remain explicit.
Clock routing lives in `src/site/routes/clock/clock.routes.js` and uses
`router.route("/").get(readClock).post(updateClock)`.

The seed world uses `2026-10-10T14:00:00+05:30` as its fixed time. It contains
6 users, 18 matches, 16 bookings, 16 confirmation outbox records, an empty waitlist,
and one clock record. Two bookings belong to the main user configured by
`STUDENT_EMAIL`; the other 14 account for sold inventory held by the other users.
Stable ObjectIds make resets and evaluation references repeatable.
`evals/ground_truth.json` records independently specified expected counts,
match times/statuses, tier inventory, main-booking refunds, and the Tokyo/Kolkata
overlap. It contains no configured email or API credentials.

Preview and validate the seed without connecting or changing MongoDB:

```sh
npm run seed -- --dry-run
```

After explicitly approving the reset of the dedicated demo data, run:

```sh
npm run seed -- --confirm-reset MatchDay
```

This resets records only in `users`, `matches`, `bookings`, `waitlist`, `outbox`,
and `config`. It preserves `agent_runs` and all other collections. It creates
the seven planned model collections/indexes, including the empty `agent_runs`
collection if absent. It does not create the optional `issues` model or reset
any existing `issues` records. Deletion and insertion run in one transaction;
use a transaction-capable Atlas cluster or local MongoDB replica set.
The script validates all seed documents and unique user emails before writes.
There is no automatic reset on server startup or during `npm test`.

`GET /admin/clock` reads the site clock. `POST /admin/clock` accepts a JSON body
such as `{"now":"2026-10-10T14:00:00+05:30"}`. Both are on the site server,
restricted by the actual localhost socket address and absent from navigation.
Malformed or timezone-free timestamps are rejected. Missing clock data gives
503 rather than silently falling back to real time.

Business `createdAt` values must be provided explicitly from `getNow()`;
bookings, waitlist, and outbox have no real-time timestamp defaults. Agent run
timestamps use real time only for technical diagnostics. `getMatchStatus()`
derives status from the provided clock; `getRefundAmount()` checks the exact
refund cutoff and started-match boundary without changing records.

`tests/phase2.test.js` is testing-only: it checks models, ground truth, inventory,
confirmation consistency, clock boundaries, and HTTP validation in memory.
`npm test` includes these tests and the existing Phase 1 tests.
`scripts/verify-phase2.js` is also testing-only. After seeding, run
`npm run verify:phase2` for read-only stored-data checks. With explicit reset
approval, `npm run verify:phase2 -- --confirm-reset MatchDay` seeds twice,
compares all stored records, tests actual clock GET/POST and boundary changes,
then restores the original seed clock. It keeps non-reset collections intact.

Phase 2 verification on 6 October 2026: the approved live verification seeded
`MatchDay` twice and confirmed identical records. Stored counts, ground truth,
booking/inventory/confirmation consistency, refunds, and actual time overlaps
passed. Actual clock GET/POST checks passed at refund and match-status boundaries;
the original seed clock was restored. A regression test covers explicit database
selection with a slash/query-bearing URI. No `.env` or frontend changes were made
by the assistant, and `phases.md` and `Rules.MD` remain unchanged for Phase 2.

## Phase 3: responsive MatchDay browsing

Open `http://127.0.0.1:4000/matches` after `npm run start:site`. MatchDay now
renders match discovery, event details, My Bookings, ticket details, and Inbox
using EJS. Shared partials are in `src/site/views/partials`, page templates in
named view folders, and responsive styles in `src/site/public/css`. Controllers
remain in `src/controllers`; routes and page middleware remain in `src/site`.
The design uses mint/lavender gradients, navy panels, local SVG sport graphics,
subtle hover transitions, keyboard focus styles, and reduced-motion support.
No dependencies or React frontend changes were needed.

Match browsing is public. To view the seeded user's tickets and inbox in your
normal browser, run this in the developer console on the local MatchDay page:

```js
document.cookie = "uid=100000000000000000000001; path=/; SameSite=Lax";
location.reload();
```

This is a mock user identity, not authentication. Missing/unknown cookies return
401; another user's ticket returns 404. Inbox messages are scoped by the user's
email and related ticket links additionally check booking ownership. The clock
is read once per page request; statuses use that instant and all website pages
show the mock time. Business timestamps are displayed in IST; venue times also
retain their seeded explicit zone labels. Location searches remain literal
case-insensitive substrings, with Bangalore and Bengaluru distinct.

Booking, cancellation, and joining a waitlist remain Phase 4. This phase displays
existing bookings and waitlist entries; unavailable actions have plain explanatory
text without links to unimplemented routes. Errors are escaped HTML with alerts;
operator clock and health endpoints retain JSON responses.

`tests/phase3.test.js`, `tests/helpers/site-fixture.js`, and
`scripts/verify-phase3.js` are testing-only files, not runtime application files.
The fixture helper supplies deterministic model responses without MongoDB.
Run browser checks with the already-installed Chromium:

```sh
PLAYWRIGHT_BROWSERS_PATH=0 node scripts/verify-phase3.js --fixture
PLAYWRIGHT_BROWSERS_PATH=0 node scripts/verify-phase3.js
```

The second command uses live MongoDB read-only, starts an ephemeral local site,
and compares all site collections before/after browsing. Neither command seeds
or changes the clock. Screenshots go under gitignored `evidence/phase3/`.

Verification on 6 October 2026: the user-approved revised Phase 2 reseed succeeded
with 18 single-price matches, 16 bookings, 16 confirmations, six users, and the
original mock clock. `npm run verify:phase2` passed against the refreshed database.
All 29 regression tests passed; fixture and live Chromium checks passed for
filters, details, private tickets/inbox, time banners, mobile menu, no-JavaScript
navigation, and layouts from 320 to 1440 pixels without horizontal overflow.
Browser checks confirmed no stored site records changed. The user's running
port-4000 site returned 200 for `/matches` and `/bookings` with the demo cookie.
This supersedes the earlier pending-reseed note in the Phase 2 scope update.

## Phase 4: bookings, cancellations, waitlists, profile, and demo session

Restart the site with `npm run start:site` (or let `npm run dev` reload it), then
open `http://127.0.0.1:4000/matches`. Click **Open demo session** in the navigation;
this sets the seeded main user's session cookie and opens My Bookings. No console
command is needed. The cookie is HttpOnly, SameSite=Lax, and scoped to `/`.
**Close demo session** clears it without changing records. This is a fictional
user selector, not authentication.

Open an upcoming event to book paid tickets or reserve free fan-screening entry.
The same form collects quantity, primary attendee name/email/phone and explicit
confirmation. The server enforces eligibility, quantity/limit, inventory, active
booking uniqueness and contact validation; submitted prices/owner IDs are not
trusted. The primary attendee can differ from the account holder. Confirmations
are addressed to the selected account so its Inbox retains them; the receipt
body identifies the attendee. Phone is validated but not stored on bookings,
whose existing schema has no phone field.

Tickets show the expected full/zero refund before cancellation. The checkbox and
JavaScript dialog confirm intent; dismissing sends no action. Without JavaScript,
the checkbox still permits explicit confirmation. Started/already-cancelled and
foreign tickets cannot be cancelled. Refunds and all business timestamps use the
mock clock. The existing refund cutoff is inclusive.

Waitlists are per event, with no tiers. They accept requests only when inventory
cannot satisfy the requested quantity; joining does not reserve seats or change
`sold`. Queue entries and receipts show the position. There is no automatic
promotion or waitlist removal. My Profile saves only the selected user's name
and phone; email is read-only and historical ticket/outbox details stay unchanged.

Controllers retain separated validation/data/response sections. New services
under `src/site/services` handle transactions and action validation. Forms are
in `views/matches` and `views/profile`; `forms.css` extends the Phase 3 design.
Client scripts supply optional total previews and the cancellation dialog.
Booking/cancellation updates and receipts are atomic. Unique indexes and bounded
transaction retries handle races; invalid requests leave action records unchanged.
The four persisted-action buttons carry `data-risk="irreversible"` for later
agent approval enforcement. No Gemini/agent actions are implemented in Phase 4.

New site endpoints:

| Method   | Route                   | Purpose                      |
| -------- | ----------------------- | ---------------------------- |
| POST     | `/session/demo`         | Select seeded main user      |
| POST     | `/session/close`        | Clear session cookie         |
| GET/POST | `/profile`              | Read/save own name and phone |
| GET/POST | `/matches/:id/book`     | Booking/free RSVP            |
| POST     | `/bookings/:id/cancel`  | Owned cancellation/refund    |
| GET/POST | `/matches/:id/waitlist` | Event waitlist               |

Run `npm test` for offline tests. The new `phase4.test.js`, explicit
`phase4-integration.js`, `helpers/phase4-world.js`, and `verify-phase4.js` are
testing-only artifacts. Integration/browser checks require approval to reset
only the dedicated `MatchDay_phase4_test` database and transaction-capable MongoDB:

```sh
PHASE4_TEST_RESET=MatchDay_phase4_test node --test tests/phase4-integration.js
PHASE4_TEST_RESET=MatchDay_phase4_test PLAYWRIGHT_BROWSERS_PATH=0 node scripts/verify-phase4.js
```

The helper refuses setup without that exact confirmation and explicitly selects
the isolated database. It recreates the six site collections' seed records there;
it never seeds the normal demo database. `npm test` does not run this destructive
test setup. Screenshots are gitignored under `evidence/phase4/`.

Verification on 6 October 2026: 35 offline tests and nine real-Mongo integration
checks passed. Browser/DB checks passed one-click session, profile/prefill,
paid/free booking, dismiss/confirm cancellation, full/zero refunds, waitlist/inbox,
invalid requests with no writes, forms at 320/390/768/1440 pixels without overflow,
reduced motion and no-JavaScript booking/cancellation. Concurrent requests did
not oversell, duplicate active bookings, restore seats twice, or duplicate queue
positions. Injected outbox failures rolled all writes back. Partial-inventory
rejection and exact refund boundaries were checked against MongoDB. The normal
demo retained its original inventory/bookings/messages and passed the read-only
Phase 2 verifier. Existing models, shared utilities, secrets/environment, agent,
seed code, and React frontend were untouched. No commits or pushes were made.

## Phase 5: browser tools and approval gate

Eight generic tools now operate MatchDay: `browser_goto`, `browser_snapshot`,
`browser_click`, `browser_fill`, `browser_select`, `browser_check`, `browser_back`,
and `browser_screenshot`. `createBrowserTools(manager, taskId)` returns LangChain
`tools` for later Gemini binding, plus `runTool(name, args)` for deterministic
checks. Task identity is bound by the caller; it is not a model argument.

`sessions.js` owns one isolated context/page per task and resolves the seeded
user by configured email. `navigation.js` restricts browser requests and redirects
to MatchDay website routes and blocks operator/agent navigation and additional
pages. `snapshot.js` describes visible controls with labels, values, options,
alerts and site time. Each snapshot replaces the active refs with larger numbers;
old or detached refs fail rather than targeting a replacement element.
`browser.js` contains the explicit tool definitions and their Zod schemas.

`riskGate.js` pauses a marked click using LangGraph `interrupt()`. Its proposal
includes the action, URL, form destination/fields and visible page details. Resume
with `{ proposalId, approved: true | false }` on the same task thread. Approval
is bound to the original document, element, fields and visible details; changed,
malformed, rejected or reused proposals cannot authorize a click. The tool lock
is released while interrupted, but other tools are blocked until resolution.
The test harness additionally rejects concurrent and duplicate resumes.

Only a currently approved originating click may accept a confirmation dialog;
other dialogs are dismissed. Permission is cleared even after timeouts. Tool
success means the browser operation completed, not that the business action
succeeded: callers must inspect the returned alerts/page, and Phase 8 will add
independent verification. An uncertain click is never retried automatically.
Screenshots go to `evidence/<taskId>/<safe-label>-<uuid>.png`.

Phase 6 migrated these checks to the production graph. The old testing graph and
its SVG were removed. `tests/helpers/production-approval.js` injects a scripted
model into `createAgentGraph`; it contains no alternate graph implementation.
`phase5-world.js`, `phase5.test.js`, `phase5-browser.js` and `verify-phase5.js`
remain testing-only. Runtime sessions/checkpoints are in memory; restart loses them.

Checks from `backend/`:

```sh
npm test
PLAYWRIGHT_BROWSERS_PATH=0 node --test tests/phase5-browser.js
```

The real action runner requires explicit permission to reset only the isolated
`MatchDay_phase5_test` database. Its reset guard refuses any other confirmation;
normal `npm test` never runs the reset:

```sh
PHASE5_TEST_RESET=MatchDay_phase5_test PLAYWRIGHT_BROWSERS_PATH=0 node scripts/verify-phase5.js
```

The runner starts its own temporary site server, exercises only generic tools
and snapshot refs, and checks MongoDB from the test harness. It covers approved
and rejected paid/free booking, full/zero refund cancellation, waitlist and profile
save; changed forms, duplicate resumes, site validation and mobile navigation.
All resources close in `finally`. Evidence is generated under
`evidence/phase5-actions/` and `evidence/browser-fixture/`.

API references consulted: [LangGraph interrupt/resume](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph),
[Playwright actionability](https://playwright.dev/docs/actionability), and
[Playwright request routing](https://playwright.dev/docs/api/class-route).

Verification on 7 October 2026: all 40 offline/regression tests, nine reported
local Chromium tests, and nine real action scenario groups passed. Stale and
replaced targets, changed risk attributes, malformed/cross-task/duplicate and
concurrent resumes, and approved click timeouts were tested without unintended
writes. The SVG was rendered and visually checked. No sessions remained after
cleanup. The normal demo's separate read-only seed comparison reports 17 receipts
versus the seed's 16 and one changed event inventory; its clock matches the seed.
It was left as-is, so that pristine-seed checker does not pass on the current demo.

## Project overview page

Open `docs/project-map/index.html` directly in your browser, or run this from
`backend/` and visit `http://127.0.0.1:4100/project-map/`:

```sh
python3 -m http.server 4100 --bind 127.0.0.1 --directory docs
```

The standalone developer guide contains phase progress, website/browser/future
agent flow diagrams, a folder map and searchable per-file function descriptions.
It maps 131 authored files and 276 function/behavior notes, covering all files in
`src`, `scripts`, `tests` and `evals` except empty `.gitkeep` folder markers, plus
selected project documents and the separate unused React starter. Dependencies,
binary evidence, lockfiles and secret environment values are not cataloged.

Its files are split into `index.html`, `styles.css`, `app.js`, `data.js` and three
catalog datasets (`site.js`, `agent.js`, `support.js`). It makes no database calls.
Update the catalog and review date as the project changes; this is a reviewed
snapshot rather than an automatic code analyzer. Testing-only, planned, legacy
and current review items are explicitly marked.

Page verification: search/category/status filters, expanded/collapsed function
lists, copy-path buttons, flow tabs and keyboard switching, direct file opening,
SVG access, reduced motion and widths 320/390/768/1024/1440 passed in Chromium.
Source inventory coverage had no missing authored backend files or duplicate
catalog paths. The documentation work itself made no runtime or database changes.
The restored `allowedUrl` route allowlist passes the current regression suite
and is reflected in the overview. After removing the redundant Phase 1 graph
smoke test, all 39 remaining regression tests pass.

## Phase 6: production graph and task API

The [approved plan](../phase-6-plan.md) describes the file responsibilities.
The [production graph SVG](docs/phase6-langgraph-flow.svg) shows actual Phase 6
routing; dashed branches are future Phase 7/8 additions. The node `makePlan`
avoids collision with the graph state's `plan` field; its function is `plan()`.

Start from `backend/` with `npm run start:agent` (MongoDB and the seeded account
must exist). Task routes bind only to the local agent server, normally port 5000.
macOS Control Center currently owns port 5000; use this process-only port override
without editing `.env`:

```sh
AGENT_PORT=5001 PLAYWRIGHT_BROWSERS_PATH=0 npm run start:agent
```

Then use `http://127.0.0.1:5001` for the task routes:

```http
POST /tasks
Content-Type: application/json

{"task":"Find upcoming cricket matches in Bangalore under INR 1000. Do not book."}
```

The response is HTTP 202 with `data.taskId`. Poll `GET /tasks/:id` for persisted
status/result; read `GET /tasks/:id/trace` for ordered completed-node/tool steps.
Run creation finishes before 202; model work runs in the background. Four active
or paused tasks are allowed. There is no public answer/approve/reject endpoint
until Phase 7. A marked browser click pauses as `awaiting_approval`, with its real
proposal, retaining browser/checkpoint state and making no marked submission.

The production files remain in `src/agent`: `graph.js` wires named nodes,
`llm.js` configures/invokes Gemini, `prompt.js` contains readable prompt functions,
`tools/` defines signatures and strict schemas, `nodes/` keeps node bodies short,
and `runtime.js` owns execution/resources. Controllers reuse existing API helpers.
No new dependency, model field, shared utility or secret configuration was changed.

`db_query` supports only allowlisted find reads over the six actual site
collections. Its filter is JSON **text** because Gemini needs a concrete argument
schema. Field types, logical/comparison operators, literal `$contains`, depth,
projection and sort are checked. Results default to 10 and cap at 20/24 KB;
truncation is explicit. Private records are AND-scoped to the trusted account,
including inbox email. The tool cannot write or query agent_runs. Actual event
spelling and mock time are discovered from observations rather than hardcoded.

`remember` returns bounded memory intents (20 keys); `finish` requests completion.
The tools node retains six complete AI/ToolMessage pairs with matching call IDs.
The guard warns on three identical calls, stops at five, enforces MAX_STEPS and
three consecutive errors, and stops rejected/changed/uncertain submissions.
An evidence-free read finish fails; an action finish fails until independent
Phase 8 verification. Tool success alone cannot establish action completion.

Gemini receives supported declaration schemas: exclusive integer bounds become
inclusive bounds, while actual execution still validates original strict Zod
schemas. Tool calling is required; code still rejects multiple/unknown calls and
allows only one missing-call nudge. Provider retries cap at four attempts for
429/selected 5xx, with 30-second per-attempt timeout and bounded 1/2/4-second
backoff. Permanent failures and structured daily-quota exhaustion stop immediately. Raw provider errors stay out of
API responses and traces. Run timestamps/durations are technical, not site time.

Terminal tasks release their session/checkpoint/context. Shutdown closes paused
sessions. Startup marks unrecoverable persisted unfinished runs failed; Mongo
traces do not restore live browser or MemorySaver state after restart.

Testing-only additions: `tests/phase6.test.js`, `tests/helpers/phase6-model.js`,
`tests/helpers/production-approval.js`, and `scripts/verify-phase6.js`.
They test the actual production graph; no throwaway graph remains.

```sh
npm test
PLAYWRIGHT_BROWSERS_PATH=0 node --test tests/phase5-browser.js
PLAYWRIGHT_BROWSERS_PATH=0 node scripts/verify-phase6.js
```

The live runner starts temporary local servers, runs real Gemini discovery for
Bangalore/Bengaluru through HTTP, checks actual titles, ordered traces, session
cleanup and a before/after digest of all six site collections. It never seeds,
resets or mutates website data. AgentRun records/evidence are expected diagnostics.
Results are stored in gitignored `evidence/phase6/results.json`.

Integration references: [LangGraph graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api),
[interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts), and
[Gemini integration](https://docs.langchain.com/oss/javascript/integrations/chat/google_generative_ai).

Verification — 7 October 2026: 53 regression tests passed; nine reported Chromium
checks passed using the production graph; the isolated Phase 5 runner passed all
nine action scenario groups after migration, with zero sessions remaining.
Formatting checks passed. One real Gemini production-graph discovery completed
with the Bangalore ODI at INR 800. The full live HTTP check for both spellings remains open: the default model's
20-request daily quota was exhausted (429). The user then authorized Gemini 3.6
Flash for testing; its verified API ID is `gemini-3.6-flash`. Three requests through
a process-only override each returned model-overloaded 503 before tool execution.
No further live requests were made; normal website data and `.env` were unchanged.
The test runner has a hard global request budget (default 14), one provider attempt
and at most five tool turns per task. `PHASE6_REQUEST_BUDGET` can lower the cap;
`PHASE6_COMBINED_CHECK=true` combines the spellings into one read-only task.
Example when the provider is available:

```sh
GEMINI_MODEL=gemini-3.6-flash PHASE6_REQUEST_BUDGET=8 PHASE6_COMBINED_CHECK=true PLAYWRIGHT_BROWSERS_PATH=0 node scripts/verify-phase6.js
```

Changed files pass formatting. The repository-wide format check separately flags
the pre-existing formatting of `src/site/models/match.model.js`; it was left
untouched because it is outside this phase's model scope.

Latest live attempt used the user's configured `gemini-3.1-flash-lite` with
generation starts spaced 16 seconds apart and automatic retries disabled. Six
requests were used: understanding, planning, a rejected invalid config filter,
successful recovery by reading config, and successful browser navigation occurred
before the next agent generation returned provider-overloaded 503. Bangalore did
not finish and Bengaluru was not started; full live acceptance remains open.
The saved trace is in `evidence/phase6/results.json`.

The action cap now reserves one additional finish-only agent turn. No browser,
database or memory tool can execute on that turn; repetition, error and approval
guards remain enforced. Prompts and database tool guidance specify the clock's
`key` filter and lowercase sport values, with actionable invalid-ID feedback.
All 55 tests pass, including final-turn action blocking and clock-query feedback.
The subsequent live retry used three requests and returned provider-overloaded
503 at the first agent turn, after understanding and planning. Live acceptance
therefore remains open; no further retry was made.

Groq is also supported through the installed `@langchain/groq` integration.
Set `LLM_PROVIDER=groq`, `GROQ_MODEL=openai/gpt-oss-20b` and `GROQ_API_KEY`
locally. When `LLM_PROVIDER` is absent, a nonempty Groq key selects Groq;
otherwise Gemini remains the default. Explicit `LLM_PROVIDER=gemini` selects
Gemini even when both keys exist. Only the selected provider's key is required
by the production model factory and live acceptance runner.
Groq receives original tool schemas with required tool selection and parallel
calls disabled; Gemini retains its existing schema adaptation. The graph,
browser actions and approval boundaries are unchanged. All 57 local tests pass.
The first Groq live attempt used five generation requests. Understanding,
planning, clock lookup and a correctly filtered upcoming-cricket query succeeded.
The next agent request failed with no HTTP status exposed by the adapter;
the saved trace cannot distinguish timeout, transport or response parsing.
Browser navigation and final completion were not reached, so full live acceptance
remains open. No site mutation tools executed in this attempt.

## Phase 7 — human questions, approval and resume

The agent now exposes human interaction through Postman and preserves the same
task ID, graph checkpoint and browser across pauses. `ask_human` returns
`needs_input`; marked submissions return `awaiting_approval`. No model calls or
website submissions run while paused. Human answers persist as bounded task
clarifications and never grant submission permission.

Import [the Postman collection](postman/phase7.collection.json). Set `agent_url`
to your running agent; the collection defaults to port 5001. Restart an existing
agent process to load these changes:

```sh
AGENT_PORT=5001 PLAYWRIGHT_BROWSERS_PATH=0 npm run start:agent
```

Submit a task with `POST /tasks`, then inspect `GET /tasks/:id`:

| Status              | Response to send                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `needs_input`       | `POST /tasks/:id/answer` with `{"questionId":"<pending questionId>","answer":"your answer"}`        |
| `awaiting_approval` | Inspect action details, then `POST /tasks/:id/approve` with `{"proposalId":"<pending proposalId>"}` |
| `awaiting_approval` | To decline, `POST /tasks/:id/reject` with the same proposal ID                                      |
| `running`           | Poll status; do not send another resume                                                             |
| `done` / `failed`   | Inspect result and `GET /tasks/:id/trace`                                                           |

Resume returns 202. Malformed bodies return 400, unknown task IDs 404, and wrong
interrupt types, stale identifiers, terminal tasks or concurrent resumes 409.
The server constructs the approval boolean; extra approval fields are rejected.
Postman captures IDs but never sends an approval automatically.

`request_approval(ref)` and marked `browser_click` use the same gate: approval
executes that exact click once. Do not issue a second click after resume.
Proposals include actual form fields, destination, event/booking, quantity,
price/refund, policy and overlapping bookings. A changed form, target or database
baseline invalidates approval. Rejection stops without resubmission. The gate
now correctly honors a form's action unless a button explicitly overrides it.

The initial Phase 8 verification slice was brought forward as agreed:

- `verification.js` captures bounded read-only baselines and checks the approved
  booking/free RSVP, cancellation, waitlist or profile outcome. It checks owned
  records, quantity/cost/refund, inventory, matching receipt, queue position and
  unrelated changes in the observed records.
- `nodes/verify.js` rejects missing or inconsistent evidence, then makes a
  separate structured LLM call to assess every success criterion. It receives
  only read-only evidence and human clarifications, with no action tools bound.
- Action `finish` routes `guard → verify → complete`. Failed checks cannot
  become `done`; they return evidence and stop without automatic mutation retry.
- The slice supports one persisted action per task. It conservatively stops if
  observed records change concurrently. Multiple-action batches, repair loops,
  a separate evidence endpoint and broader evidence packaging remain Phase 8.

Paused tasks retain resources and count toward the four-task cap. Duplicate
resume and shutdown/persistence races are guarded. Restart cannot restore the
current in-memory browser/checkpoints; old incomplete tasks become failed and
must be started again. Model schemas, shared utilities, credentials and normal
demo records were not changed for Phase 7.

See the [implementation plan](../phase-7-plan.md) and
[current graph](docs/phase7-langgraph-flow.svg).

### Phase 7 checks — 8 October 2026

68 regression tests passed. Nine existing Chromium tool tests passed. Nine new
real HTTP/browser/database scenarios passed: rejection, changed approval,
ambiguity plus revised quantity, paid booking, free RSVP, overlapping booking,
full/zero refunds, waitlist and profile. Negative cases compare all site records;
approved cases require independent production checks and ordered traces.
Only the explicitly approved isolated `MatchDay_phase5_test` world was reset.

Testing-only commands:

```sh
npm test
PLAYWRIGHT_BROWSERS_PATH=0 node --test tests/phase5-browser.js
PHASE5_TEST_RESET=MatchDay_phase5_test PLAYWRIGHT_BROWSERS_PATH=0 node scripts/verify-phase7.js
```

An explicit live mode runs one provider-driven profile task with a maximum of
12 generation requests and no automatic retries. The attempted live check used
seven requests and stopped on 429 at the agent node, before action approval.
No approved mutation occurred in that attempt; live end-to-end acceptance is
incomplete. It was not retried. `--live` also resets only the isolated test world.


### LLM-call optimization — implementation pending validation

Browser actions already provide snapshots; the agent is instructed to request
another snapshot only when observations are stale or recovery needs it.
`browser_batch` sequentially fills, selects or checks stable form controls from
one snapshot. It validates each target and applied value, stops on errors or
page changes, and returns completed references with fresh observations. Clicks,
navigation and approval interrupts are excluded from batches.

Approved actions now route immediately to deterministic before/after database
verification. The existing agent turn receives that evidence to interpret the
requested goal and any human clarifications; there is no separate LLM verifier.
Action completion requires that evidence plus an explicit assessment of every
success criterion in the finish tool. Verified action summaries are generated
in code. Read-only summaries still use the agent's interpretation of observations.

`MAX_LLM_CALLS` defaults to 30 and can be configured for the workflow. It counts
all provider attempts, including retries, across interrupt/resume. Exhaustion
reports failure with available verification evidence and closes the session;
it never bypasses verification or grants approval. Existing rate limiting,
step limits, tool calling and approval gates remain active.

No tests, live checks, formatting checks or other validation were run for these
optimization edits, at the user's request. Earlier Phase 7 validation records
apply to the implementation before these edits.


### Groq token compaction — not live validated

Groq uses LangChain's `maxTokens` setting, serialized by the installed integration
as `max_completion_tokens`. `GROQ_MAX_OUTPUT_TOKENS` defaults to 1024 and includes
the model's generated reasoning/output allowance. No reasoning-effort setting
was changed. Increase the configurable allowance if a supported response needs
more room; truncated output is not evidence of successful completion.

The model-facing context now uses concise page text and target references, with
URL, site time, alerts, current values, control state and risk markers retained.
Playwright sessions, full snapshots, independent DB verification and traces are
unchanged. A partial view is labelled; `browser_snapshot` accepts `textOffset`
and `elementOffset` to retrieve another section without navigating or submitting.
Database observations retain record IDs and explicitly label omitted fields;
the agent can query narrow projections to inspect them.

Only two complete recent tool-call/result pairs are sent to the model. Older
record details are compacted further. A separate action log preserves tool
outcomes, observed record IDs, errors, completed batch refs and executed approval
state; goal, memory, clarification and verified evidence remain in the prompt.

Tool selection reads existing graph/page state, without a model call. Initial
turns expose discovery/control tools. Page turns add browser primitives matching
visible controls, including request_approval for irreversible targets. Recovery
or incomplete full snapshots retain all tools. After verification, completion,
clarification and read-only evidence tools remain available. Both submission
paths retain the existing code-enforced approval gate.

Offline schema/prompt sizing was performed without model, graph or browser
execution. No live task or API request was run for these changes. The existing
request-rate limiter is not token-aware: compaction lowers TPM pressure but does
not guarantee every workload will remain within 8000 TPM.


## Phase 9 evaluation harness

Evaluation-only files live in `evals/` and `tests/helpers/eval-world.js`;
they are not production entry points. The harness calls the existing production
runtime without replacing its graph, model, tools, approval handling or verification.
`tests/helpers/phase5-world.js` supplies `siteRecords()` snapshots and must remain
available. Its Phase 5 reset function is not called.

When you choose to run evaluations later, from `backend/`:

```sh
npm run evals -- --confirm-reset MatchDay_phase9_eval
```

This is destructive **only to the dedicated `MatchDay_phase9_eval` database**:
before each scenario it transactionally replaces the six demo collections with
production seed data and clears evaluation `agent_runs`. The exact confirmation
is mandatory. The normal application database is not reset. MongoDB must support
transactions (a replica set or Atlas). Existing MongoDB, LLM and student-account
configuration and installed Playwright Chromium are prerequisites; no separate
site or agent server needs to be started.

Scenarios run sequentially in isolated child workers, each hosting the existing
MatchDay app on an ephemeral loopback port and calling `createRuntime()`.
Scripted answers must match the requested question; approvals must match the
intended action, otherwise the harness rejects them. Waitlist `expectedPosition`
is an outcome assertion, not a field in the production approval payload.
Timeouts terminate the owned worker process group on macOS/Linux. Windows falls
back to terminating the worker and needs separate browser-descendant cleanup
validation. There is a 60-second pause between scenarios; provider quota errors
can still occur, including when other processes share that quota.

`tasks.json` is the executable expectation source. Add scenarios there without
changing agent code. `ground_truth.json` retains the baseline seed oracle and
mirrors the default scenarios' `taskExpectations` for review; it is not a second
source of runtime expectations. `{{studentEmail}}` is replaced from existing
configuration. Supported CLI options are `--tasks <path>`, `--repeat <1..20>`,
`--demo-only`, and `--report <path-inside-backend/evidence/>`.

Reports default to `evidence/phase9/evals-<timestamp>.json` and are saved after
each completed scenario and during cleanup. They include individual assertions,
failures, run results, ordered tool/node traces, scripted interactions and duration.
Assertions use production `checkAction()` plus whole-database snapshots to detect
unintended changes. A failed run may already have submitted an action; inspect
its database assertions before drawing conclusions. Reports may contain task,
attendee and receipt information, so review before sharing.

An exclusive `evaluation_lock` document prevents concurrent harness resets.
SIGINT/SIGTERM handling stops the active worker before releasing the owned lock
and saving the report. Forced termination, machine shutdown or lost database
connectivity can still leave a lock. The harness deliberately refuses to steal
it: confirm no previous harness/worker remains before manually removing only
that stale lock in `MatchDay_phase9_eval`. No database cleanup was performed as
part of this recovery.

This implementation was recovered using static inspection only. No tests,
builds, evaluations, browser sessions or model/API requests were run. Live
compatibility, scenario completion, approval matching, database assertions,
timeout cleanup and interruption recovery still need testing later.
