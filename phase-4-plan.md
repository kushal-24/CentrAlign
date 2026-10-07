# Phase 4 implementation plan — MatchDay actions and profile

Prepared: 6 October 2026. Status: implemented and verified on 6 October 2026.

## Goal and current scope

Finish the MatchDay website so a person can open a demo session, book paid tickets
or a free fan-arena screening, cancel a ticket with the correct refund, join an
event waitlist, and edit their profile name/phone. Every action must enforce its
rules on the server and show an observable result.

Follow `phases.md`, `MatchPilot_plan_v2.md` sections 4–7 and 16, `Rules.MD`, and the
user's subsequent scope decisions. The original tier-based requirements are
superseded: one price and one seat pool per event; no active tier fields or
selectors. Profile editing and the demo-session button are additions discussed
with the user. Friends, authentication, and a users directory are outside this
phase.

Reuse the Phase 3 responsive gradient design, EJS partials, controllers, route
folders, cookie parser, mock clock, and Mongoose models. No React work, dependency
changes, migrations, or shared-utility/model edits are planned.

## Starting point

- Phase 3 provides discovery, filters, event details, owned booking/ticket views,
  and a scoped inbox. Status tabs retain the match section through `#explore`.
- The revised Phase 2 seed is applied: 18 single-price events, six users, 16
  bookings/confirmation messages, empty waitlist, and the fixed mock clock.
- All 29 tests and fixture/live read-only Chromium checks passed before this phase.
- Matches already have `price`, `capacity`, `sold`, `perBookingLimit`,
  `bookingStatus`, refund policy, and start/end times.
- Bookings retain original owner name/email, quantity, total price, status,
  refund amount, and business timestamps. Active bookings are unique per
  `(userId, matchId)`.
- Waitlist identity and position have unique event-level indexes. User records
  already contain name, email, and phone. Profile editing needs no new fields.
- The current browser cookie is manually set; the proposed demo-session control
  removes that step without introducing an authentication system.

## What will be implemented

### 1. Open demo session

- Add `POST /session/demo`, exposed as an **Open demo session** form button in the
  shared navigation and the existing 401 page.
- Resolve the seeded main user using configured `STUDENT_EMAIL`; do not accept a
  user ID/email from the form or create missing users implicitly.
- Set `uid` as an HttpOnly, SameSite=Lax cookie with `path=/`, and redirect to
  `/bookings`. Keep it a session cookie; there is no expiry preference to add.
  HttpOnly means browser JavaScript cannot read it, while the server and
  Playwright still receive/use it normally.
- Show clear unavailable feedback if the configured seeded user is absent.
- Offer **Close demo session** through `POST /session/close`: clear the cookie
  using matching attributes and return to discovery. No data is deleted.
- Resolve optional user context on public pages so the header can show the
  current user's name, My Profile, and Close demo session. Private routes continue
  requiring a valid identity; they never silently select another account.
- This is a fictional demo selector. There are no passwords, registration,
  user switching, account recovery, or production authentication claims.

### 2. Booking — `GET/POST /matches/:id/book`

- Replace the existing coming-soon text with appropriate action links on the event
  detail page. Keep closed and postponed states explanatory and enforce them again
  on POST.
- Render one reusable booking form for paid events and free screenings:
  quantity, attendee name, email, phone, and an explicit confirmation checkbox.
- Prefill primary attendee contact fields from the selected user's profile,
  keeping every field editable. Do not infer friends' identities or fabricate
  missing details. Quantity is ticket count, not a friends-management feature.
- Show event/venue/time, unit price, remaining seats, limit, refund policy, and
  total. Free events use the same flow with total zero and RSVP wording.
- A small browser script may update the displayed total as quantity changes.
  The server always recalculates it from the stored price; client totals are not
  trusted. The form works with JavaScript disabled.
- Validate scalar inputs, nonempty name, email/phone format, positive safe integer
  quantity, per-booking limit, remaining seats, upcoming/open event, selected user,
  confirmation checkbox, and absence of an existing active booking.
- Invalid submissions re-render the form with its submitted values and a clear
  `role="alert"` message. Price, owner identity, status, and timestamps cannot be
  overridden by extra request fields.
- Transactionally increase `sold`, create a uniquely coded booking, and create
  its confirmation outbox entry. A conditional inventory update prevents
  overselling; unique active-booking/code indexes remain the final safeguards.
- Use a readable `MD-...` code generated from a cryptographically random suffix
  through Node's built-in crypto module; no dependency or counter model. Handle
  the rare code collision with a bounded fresh attempt after a rolled-back write.
- Read the mock clock for the transaction's business validation/timestamps,
  including on transaction retries. Recheck event eligibility inside the
  transaction rather than trusting the earlier form render.
- Redirect successful submissions with HTTP 303 to the existing ticket page.
  Show confirmation feedback and the real stored booking code.
- The existing booking schema has no phone field. Validate phone input, but do
  not add it to booking records or silently update the user's profile. Name/email
  snapshots remain on the booking; phone changes belong to My Profile. Persisting
  attendee phone on tickets would require a separate agreed schema change.

### 3. Cancellation — `POST /bookings/:id/cancel`

- Add a cancellation form on an owned, active, not-started ticket, displaying the
  expected refund and policy before submission. Recalculate the refund on POST.
- Require a confirmation checkbox and show a JavaScript `confirm()` dialog when
  JavaScript is available. The checkbox supplies deliberate confirmation without
  JavaScript; dismissing the dialog sends no request.
- Query the booking by both ID and current user. Reject unknown/foreign tickets,
  already-cancelled bookings, and matches that have started.
- Reuse `getRefundAmount()` with mock time: full price at/before the inclusive
  policy cutoff; zero afterward or for a non-refundable event. Free RSVP refund
  remains zero.
- In one transaction, change only an active booking to cancelled, record refund
  and `cancelledAt`, decrease event `sold` by its quantity, and create one
  cancellation outbox record. Reject inconsistent inventory rather than masking it.
- Conditional booking updates and transaction conflicts prevent duplicate
  cancellation or double inventory restoration under repeated/concurrent requests.
- Redirect with 303 to the ticket; show actual stored cancellation/refund details
  and visible success feedback. Existing cancellation fields already suffice.

### 4. Event waitlist — `GET/POST /matches/:id/waitlist`

- Add a quantity/confirmation form tied directly to the event, without tiers.
- Keep the planned insufficient-inventory rule: permit joining when the event
  cannot satisfy the requested quantity, including zero seats. If enough tickets
  exist, tell the user to book instead. Partial availability is displayed so the
  person can choose fewer tickets rather than join the queue.
- Enforce upcoming/open event, user identity, positive integer quantity,
  per-booking limit, confirmation, and no existing waitlist entry for that user
  and event. Recheck live inventory on POST.
- Assign the next position within the event. Use the existing unique
  `(matchId, position)` and `(matchId, userId)` indexes, with bounded transaction
  retry for competing position allocation; do not permit duplicate positions.
- Create the waitlist record and `waitlist_joined` outbox message together.
  Joining never increments `sold` and does not create a booking or reserve seats.
- Existing outbox has no waitlist-reference field. Use its recipient/type and
  include event, quantity, and position in its body; leave `relatedBookingId`
  null. Do not add a model field just for this workflow.
- Redirect with 303 to My Bookings and show position/quantity feedback. The entry
  appears in the existing waitlist section and its confirmation in Inbox.
- No automatic promotion, seat assignment, waitlist cancellation, or notification
  delivery is introduced here.

### 5. My Profile — `GET/POST /profile`

- Add a profile page matching the shared design, reachable through the header.
- Render editable name and phone; show email as read-only. Save only the current
  user's name/phone using an explicit field allowlist and Mongoose validation.
- Validate scalar input, trim name/phone, reject blank names and invalid phone
  numbers. Preserve entered values and show clear form feedback on failure.
- Reject a submitted email/account-ID change rather than treating read-only HTML
  as enforcement. Never mass-assign `req.body` into a user record.
- Redirect with 303 after saving; the updated name appears in the shared header
  and profile. Subsequent booking forms prefill the updated contact data.
- Existing booking owner snapshots and outbox recipients/bodies stay historical.
  Saving a profile does not rewrite tickets, move bookings, change email, or send
  a new outbox message; profile saves do not require a schema timestamp addition.
- Mark Save profile as a persisted-change action for the later browser approval
  gate. Future agent verification can query `users`; this is a new site capability,
  not a new specialized agent tool.

### 6. Shared behavior and feedback

- Use real labeled forms, accessible buttons, `role="alert"` feedback, keyboard
  focus styles, narrow-screen layouts, and reduced-motion support throughout.
- Mark **Confirm booking**, **Cancel booking**, **Join waitlist**, and **Save
  profile** with `data-risk="irreversible"` so later browser tools can identify
  persisted actions. This attribute alone does not implement agent approval;
  enforcement belongs to Phases 5/7.
- Preserve query/anchor behavior from Phase 3 and render all page times through
  the mock clock. No real clock for business timestamps or cutoffs.
- Use server-controlled success codes in redirects; feedback must agree with the
  loaded record. Do not echo arbitrary query text as a successful action.
- Support only same-site mutation submissions using a focused request-origin
  check for the fictional app, alongside SameSite cookies. Do not claim this
  replaces a production authentication/security system.
- Use `asyncHandler` / `apiError`; retain JSON health/operator-clock contracts.
  Translate expected validation, uniqueness, inventory, and transaction failures
  into useful HTML alerts without exposing database internals.

## Files and folder structure

`+` denotes a new file, `~` an existing file receiving focused changes. Model,
seed, clock, frontend, agent, and shared utility files remain outside the planned
implementation changes.

```text
backend/
  src/
    controllers/
      ~ matches.controller.js       event action availability
      ~ bookings.controller.js      booking form/create/cancel handlers
      + waitlist.controller.js      event waitlist form/join handlers
      + profile.controller.js       owned profile display/update
      + session.controller.js       open/close seeded demo session
    site/
      ~ server.js                   mount profile/session routes
      middleware/
        ~ page-context.js           optional user context; retain requireUser
        + mutation-origin.js        same-site form request check
      services/
        + booking.service.js        atomic booking/cancellation operations
        + waitlist.service.js       atomic position allocation and outbox
      routes/
        ~ matches/matches.routes.js booking and waitlist endpoints
        ~ bookings/bookings.routes.js cancellation endpoint
        + profile/profile.routes.js
        + session/session.routes.js
      views/
        partials/
          ~ header.ejs              demo session/profile navigation
          + form-feedback.ejs       reusable visible form feedback
        matches/
          ~ detail.ejs              working action links and event states
          + book.ejs                paid booking and free RSVP form
          + waitlist.ejs            event queue form
        bookings/
          ~ index.ejs               join success/position feedback
          ~ detail.ejs              booking feedback and cancellation form
        profile/
          + index.ejs               editable name/phone, read-only email
        ~ error.ejs                 open-session button for 401
      public/
        css/
          ~ components.css          shared field/error/action styles
          + forms.css               responsive action/profile form layouts
        js/
          + booking-form.js         optional live price preview
          + cancellation.js         confirmation dialog
  tests/
    + phase4.test.js                validation, HTTP forms, ownership
    + phase4-integration.js         explicit real DB test runner (not in npm test)
    helpers/
      ~ site-fixture.js            narrow fixture updates for profile/session
  scripts/
    + verify-phase4.js             browser actions plus DB/outbox assertions
    ~ verify-phase3.js             keep browsing regression assertions valid
  ~ README.md                      usage, routes, checks, verification results
phase-4-plan.md                     this document
~ phases.md                        Phase 4 scope/checklist and verified results
```

Services isolate multi-record transaction logic from HTTP form rendering. Route
files stay small; EJS handles markup; CSS and browser JavaScript stay separate.
Avoid recreating a generic service framework or combining every action in one
large controller. Add test helpers only if the real tests need them.

## Implementation sequence

| Step | Implementation | Gate before proceeding |
|---|---|---|
| 1 | Run baseline tests; inspect current data/indexes and transaction support read-only | Existing tests pass; no silent reset or model change |
| 2 | Demo-session buttons and profile page/save | One-click session works; scoped profile updates validate |
| 3 | Shared form/feedback styles and booking form | Responsive, labeled form; free/paid totals; no-JS usability |
| 4 | Atomic booking service and POST handler | Correct booking/inventory/outbox; hard-rule and concurrency tests |
| 5 | Cancellation form/dialog and atomic service | Full/zero/free refunds; rejection and duplicate cancellation tests |
| 6 | Waitlist form and atomic join service | Event positions unique; inventory unchanged; confirmation exists |
| 7 | Wire detail/navigation/success states and risk attributes | Complete browser navigation; mutations visibly identifiable |
| 8 | Regression, real DB integration, and browser checks | Positive and negative assertions pass; record actual results |
| 9 | Update README, this plan status, and Phase 4 checklist | Mark only observed checks complete; no commit/push without request |

No phase automatically starts the next phase. Gemini, graph/controller code, and
browser-agent tools are not part of this implementation.

## Tests that will actually be run

### Offline tests and HTTP form checks

Run `npm test` before and after the implementation. Add Phase 4 tests for:

- Opening/closing a demo session, cookie attributes, missing seeded user, profile
  navigation, and private routes without/with valid identity.
- Valid name/phone changes; blank names, malformed phone, duplicate/non-scalar
  form fields, forbidden email/user-ID edits, and escaped form values.
- Booking forms for paid/free events, calculated totals, preserved invalid input,
  owner identity, confirmation requirement, and route ID validation.
- Live/past/postponed event rejection; sold-out/insufficient inventory; positive
  integer quantity and limit; existing active booking; invalid email/phone/name.
- Cancellation ownership, confirmation, already-cancelled/started event
  rejection, full/zero/non-refundable/free refund and exact cutoff boundaries.
- Waitlist quantity/limit/eligibility/confirmation, duplicate join, enough-seat
  rejection, partial-inventory handling, and visible position.
- Profile edits retaining historical tickets and inbox messages.
- Sanitized errors and absence of unapproved field assignment.
- Existing Phase 1–3 behaviors, including status-tab scroll anchors.

Fixture tests validate request/rendering behavior. They are not evidence that
MongoDB transactions or simultaneous writes work; those require the real checks
below.

### Real MongoDB integration

Use an explicitly selected dedicated test database with a clear test-name guard.
The test runner must refuse the normal demo database and MongoDB system databases.
Creating/resetting that isolated world needs approval before execution; it must
never erase the user's current `MatchDay` records by default.

Assert actual stored records before/after each operation:

- Paid booking and free RSVP: one owned booking, correct quantity/price,
  inventory increment, one linked confirmation, and mock-clock timestamps.
- Invalid booking requests: no booking, inventory, or outbox changes.
- Two users competing for the last seat: at most one successful booking; no
  oversell. Concurrent duplicate booking: one active booking/confirmation.
- Forced failure after inventory update or before outbox insertion: the whole
  booking transaction rolls back. Use a controlled integration-test hook/stub,
  not a production request flag or a deliberately corrupted live demo.
- Full/zero refund cancellation: stored status/refund/timestamp, exact inventory
  restoration, and one cancellation message. Repeated/concurrent cancellation
  restores inventory only once. Failure before outbox rolls all changes back.
- Waitlist success/concurrent joins: unique users/positions, matching receipts,
  no inventory changes; rejected/failed joins leave all action records unchanged.
- Profile saves change only the selected user's name/phone; existing tickets,
  other users, and outbox are unchanged.

Use transaction-capable MongoDB, as required by the current seed. If transaction
support or database access is unavailable, report that check as blocked rather
than substituting fixtures and declaring it passed.

### Playwright flows and presentation checks

Run the testing-only `verify-phase4.js` against the approved isolated test world,
with the installed local Chromium. Assert browser behavior and independently
query the resulting DB records; save screenshots under gitignored
`backend/evidence/phase4/`.

1. Open discovery without manually setting a cookie; click Open demo session.
2. Edit profile name/phone, save, reload, and check updated header/prefill.
3. Book paid tickets; inspect the ticket, My Bookings, Inbox, and stored outcome.
4. RSVP to the free screening and verify total zero and inventory/outbox.
5. Cancel a full-refund ticket; dismiss the dialog first to prove no request or
   mutation, then confirm and inspect cancellation/refund/receipt.
6. Cancel the seeded zero-refund ticket after inspecting its policy and refund.
7. Join the sold-out Hyderabad event waitlist and inspect position/receipt.
8. Exercise hard-rule errors through the UI and confirm no unintended writes.
9. Check profile, booking, waitlist, and ticket/cancellation layouts at desktop,
   tablet, and 320/390px mobile widths, including keyboard operation and overflow.
10. Check the forms without JavaScript; total enforcement remains on the server
    and explicit cancellation confirmation still works.
11. Close the demo session; private routes deny access until reopened.

All new test files and browser scripts are testing-only artifacts and will be
identified in the implementation report. Check formatting of changed files and
`git diff --check`; do not bulk-format unrelated code.

### Demo reproducibility

After successful isolated tests, demonstrate the requested actions in the normal
demo world only with authorization for those mutations. If restoring that world
is needed, get explicit reseed/reset approval. Do not silently seed before every
server start, change the mock clock, or leave an edited profile without reporting
it. Verify that the existing seed restores the expected single-price world.

## End product and completion criteria

The final website has this ordinary-browser flow:

```text
Discover → Open demo session
                  ├─ My Profile → Edit name/phone → Save
                  ├─ Match details → Book / free RSVP → Ticket → Inbox
                  ├─ My Bookings → Ticket → Confirm cancellation → Refund + Inbox
                  └─ Sold-out / insufficient-seat event → Waitlist → Position + Inbox
```

The user no longer needs console commands for normal demo browsing. Every valid
transaction produces the correct stored outcome and readable confirmation;
invalid requests produce clear alerts and no unintended data changes. Forms
match the existing gradient design and work on mobile and desktop. No active
ticket tiers or friends directory are introduced.

Phase 4 is complete only after real transaction/concurrency/rollback checks and
browser flows pass, regressions pass, and actual results are documented. Profile
editing demonstrates an additional capability through future generic browser
and DB tools; it does not yet execute through an agent. Risk attributes prepare
the site for later approval enforcement rather than implementing that gate now.

Implementation was subsequently authorized. The isolated test reset was approved and performed only in `MatchDay_phase4_test`. Offline tests, real transaction/concurrency/rollback checks, and browser flows passed. The normal demo seed passed read-only verification. No commits or pushes were made. See the README and `phases.md` for actual verification results.
