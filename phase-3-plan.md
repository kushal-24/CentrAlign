# Phase 3 implementation plan — MatchDay browsing

Prepared: 6 October 2026. Status: proposed implementation; no Phase 3 code changes made.

Scope update: ticket tiers are deferred at the user's request. Implement the
pages below with one price and seat pool per match/event. Bookings and waitlists
have no tier selector or tier display. The revised Phase 2 seed must be applied
with explicit database-reset approval before live Phase 3 verification.

## Goal and source documents

Make the seeded MatchDay world usable in a normal browser: browse and filter matches, inspect details, view the current user's tickets and waitlist entries, and read confirmation messages. Every rendered website page must show the same configured mock time.

Follow `phases.md` Phase 3, `MatchPilot_plan_v2.md` sections 4–6 and 16, and `Rules.MD`. Use the existing backend layout, Express, EJS, Mongoose, and API utilities. No new dependencies, model changes, authentication system, or React frontend work are planned.

## Starting point

- Phase 2 verification is recorded in `backend/README.md`: deterministic seed, stored-data consistency, clock endpoints, refund boundaries, and overlaps passed.
- The seed contains 18 matches, six users, 16 bookings, and 16 confirmation messages. The main user has two bookings; the seeded waitlist is empty.
- `backend/src/site/server.js` already configures EJS, JSON and URL-encoded form parsing, health checks, clock routes, and error handling. Its home page is still a placeholder.
- Existing models and `getNow()` / `getMatchStatus()` are available. Reuse these without modifying their contracts.
- The existing Phase 1 home-page test assumes a database-independent placeholder. Update that test deliberately when `/` becomes the browsing entry point, while retaining health and startup coverage.
- Current unrelated working-tree changes include `backend/README.md` and `backend/.env.example`. Preserve them; do not overwrite environment files.

## What will be implemented

### Shared page structure and request context

- Shared EJS header/footer partials with MatchDay branding and navigation to Matches, My Bookings, and Inbox.
- A fixed, readable site-time banner using `getNow()`, with an explicit IST label and machine-readable timestamp. Read the clock once per page request and use that same instant for every status on that page.
- Minimal responsive CSS, readable tables/cards, semantic headings, labeled inputs, keyboard-accessible links, and visible feedback inside `role="alert"`.
- `/` redirects to `/matches` as the browsing entry point.
- Cookie parsing using the already-installed `cookie-parser`. A valid `uid` resolves an existing seeded user; user-specific queries always use that resolved identity.
- Public match browsing works without a cookie. Private pages without a valid user show an explanatory error rather than selecting someone else's account. No silent fallback to the main user and no login implementation.
- HTML error pages for website routes: malformed IDs, missing records, missing/invalid mock identity, and unavailable clock. Keep the existing JSON contracts for health and operator clock endpoints.
- Escape dynamic data through EJS, including query text and inbox bodies. Render inbox bodies as plain text, preserving line breaks.

### Match listing — `GET /matches`

- Default view groups matches into Live, Upcoming, and Past, derived from the request's mock time.
- Status links use `?status=live|upcoming|past`; support returning to all groups.
- A GET filter form accepts `sport`, `location`, and `q`. Preserve active filters across status navigation and show their current values.
- Sport filtering covers cricket, tennis, badminton, and football.
- Location uses literal, case-insensitive substring matching across city, country, and venue. Keep Bangalore and Bengaluru distinct; do not introduce aliases or geographic inference.
- Text search uses case-insensitive literal matching across title, participants, and competition. Combine all supplied filters with AND; location fields match with OR.
- Validate supported status/sport values and reject non-scalar query inputs visibly. Treat search punctuation literally rather than executing user-supplied regex syntax.
- Show title, sport, city, venue time with its stored zone label, derived status, event ticket price, and a details link. Show free-event and postponed labels where relevant.
- Use deterministic ordering within each group: start time, then ID. Show a clear empty-results message and a reset-filters link.

### Match details — `GET /matches/:id`

- Render title, participants, competition, sport, city/country, venue, start/end instants with explicit time zones, and stored `displayTime`.
- Keep Live/Upcoming/Past separate from the booking-status label, so an upcoming postponed match remains distinguishable.
- Display the event's ticket price and remaining tickets (`capacity - sold`), per-booking limit, free-event indicator, and the exact stored refund-policy text.
- Provide a back-to-matches link. Booking and waitlist controls display a clear Phase 4 availability message; do not expose links to unimplemented action routes. Replace these with the planned action links in Phase 4.
- Do not create booking forms or enforce mutation rules in this phase.

### My bookings — `GET /bookings`

- Query bookings by resolved `userId`; include booked and cancelled records.
- Show booking code, linked match, quantity, total price, booking status, and ticket-details link.
- Include that user's waitlist entries with match, quantity, position, and mock-clock creation time.
- Handle empty bookings/waitlists explicitly. Use deterministic ordering and avoid per-row database queries by fetching referenced matches together or populating them.

### Ticket details — `GET /bookings/:id`

- Query by both booking ID and current `userId`; another user's ticket returns the same 404 as an absent ticket.
- Show booking code, match/venue/time, owner details stored on the booking, quantity, total price, status, and creation time.
- For cancelled bookings, show stored refund amount and cancellation time. Show the match's stored policy text without performing a cancellation.
- Cancellation controls remain unavailable until Phase 4. No report-issue form, PDF, QR code, or ticket transfer.

### Inbox — `GET /inbox`

- Query outbox records by the resolved user's normalized email, since the existing outbox schema has `to` rather than `userId`.
- Show subject, type, recipient, mock-clock creation time, and escaped body; newest first with a stable ID tie-breaker.
- Link to a related booking only when it belongs to the same user. Do not infer ownership from an incoming URL.
- Show an empty inbox state. Do not send real email or create/update messages.

## Implementation order and files

| Step | Work | Expected files | Check before moving on |
|---|---|---|---|
| 1 | Establish baseline and review current route/model contracts | Existing tests and source, read-only | `npm test`; record existing failures separately |
| 2 | Add request clock/user context and shared page shell | New focused middleware under `backend/src/site/`; EJS partials; `backend/src/site/server.js`; minimal site stylesheet | Clock appears consistently; public pages do not require identity; private pages validate cookie |
| 3 | Build listing, query validation, filtering, and details | `backend/src/controllers/matches.controller.js`; `backend/src/site/routes/matches/matches.routes.js`; match views | Seed fixture filtering/status/detail assertions pass |
| 4 | Build owned booking list, ticket details, and waitlist section | `backend/src/controllers/bookings.controller.js`; `backend/src/site/routes/bookings/bookings.routes.js`; booking views | Cross-user access fails; booked/cancelled/empty states render |
| 5 | Build scoped inbox and complete page errors/navigation | `backend/src/controllers/inbox.controller.js`; `backend/src/site/routes/inbox/inbox.routes.js`; inbox/error views | No other user's messages; errors are visible HTML |
| 6 | Run regression, read-only integration, and browser verification | New Phase 3 tests and browser verification script; narrowly updated Phase 1 test | All automated assertions and normal-browser flows pass |
| 7 | Document observed results | Focused Phase 3 section in backend README and verification record in `phases.md` | Mark only verified Phase 3 requirements complete; report limitations |

Use existing `asyncHandler` and `apiError` for controllers. Use `apiResponse` for JSON responses where appropriate; page controllers render EJS. Mount specific routes in the existing site server and preserve operator endpoint behavior. Exact middleware/view filenames can follow the existing conventions during implementation; do not reorganize unrelated files.

No commits or pushes are part of this request. No seeding/reset is needed for the planned read-only integration checks. Any prerequisite requiring model/shared-utility edits, new dependencies, or destructive writes must be identified before changing scope.

## Tests and validation

### Offline regression and page tests

Run `npm test` from `backend/` before implementation and after the completed changes. Add `tests/phase3.test.js` using the existing Node test runner and in-memory seed fixtures/model stubs, without requiring live MongoDB or Gemini.

Test observable HTTP/rendered behavior:

- `/` redirects correctly; navigation and the mock-time banner appear on every website page, including errors when the clock is available.
- Default listing renders all three groups; status boundaries use `startsAt <= now < endsAt` correctly. Postponed is independent of temporal status.
- Sport, city, country, venue, text search, and combined filters work; case and literal punctuation are handled correctly.
- Bangalore and Bengaluru searches return their own substring matches. Empty results, invalid filters, and repeated/nested query parameters have deliberate outcomes.
- Detail pages show accurate event seat availability, free prices, limits, policy wording, and zoned times. Invalid/missing match IDs return 404 without leaking internal errors.
- Valid cookies scope bookings, waitlists, and inbox. Missing, malformed, and unknown cookies cannot expose private records. Another user's booking ID returns 404.
- The main user's seeded B1/B2 records and confirmations render; another user's messages do not.
- Cancelled ticket/refund and nonempty waitlist views render using synthetic fixtures, since the seed has neither state for the main user.
- User-provided/search/message strings containing HTML render as text, without executable markup.
- Missing clock fails clearly with 503 and never falls back to the real clock. Database failures return sanitized errors.
- Existing health, admin clock validation, Phase 2 data rules, and agent smoke tests remain covered.

### Live read-only integration

- Start the site against the existing dedicated `MatchDay` database without reseeding.
- Read the configured clock and main user's ID without printing secrets; exercise all browsing routes with and without the `uid` cookie.
- Compare listing statuses, inventory, ticket totals, and visible confirmations with Phase 2 ground truth and stored records.
- Check foreign ticket access using a different seeded user's booking.
- Compare before/after site-collection record snapshots to prove browsing did not change users, matches, bookings, waitlist, outbox, or config.
- Test clock transitions offline with controlled fixtures. Do not POST to `/admin/clock` during this read-only pass.

### Playwright browser verification

Add a small testing-only `scripts/verify-phase3.js` using installed Playwright; it is for validation, not application runtime. Run with the installed Chromium configuration (`PLAYWRIGHT_BROWSERS_PATH=0`) and headless mode.

- Open `/matches`; navigate all status links and submit combined filters through labeled controls.
- Visit a match with partial inventory, a sold-out match, a free event, and a postponed match; check visible facts and policy text.
- Set the seeded main user's cookie; open My Bookings, a ticket, and Inbox using real links.
- Verify heading/navigation accessibility basics, readable empty/error states, and the site-time banner across pages.
- Confirm keyboard navigation and basic narrow-screen readability; no horizontal overflow obscures required data.
- Confirm no booking/cancellation/waitlist submission is exposed in Phase 3 and no admin-clock link appears in navigation.
- Save optional screenshots only under gitignored `backend/evidence/phase3/`.

The new test file and verification script are testing-only artifacts and will be flagged as such in the implementation report. Run formatting checks on changed backend JS/JSON files; avoid bulk formatting unrelated existing files. Report actual checks run and any environment blockers without claiming unexecuted checks passed.

## Completion gate

Phase 3 is complete when a person can browse/filter matches, inspect details, view their seeded tickets and waitlists, and read only their own confirmations; every website page uses the configured mock clock; offline regressions and the read-only browser/integration checks pass; and browsing leaves stored data unchanged.

Booking/free RSVP submission, cancellation/refund mutations, joining waitlists, irreversible-action risk attributes, browser agent tools, Gemini graph execution, approvals, and independent agent verification remain in their owning later phases.

This document is the deliverable for the current request. Implementation begins only after the user directs work to proceed.
