import test from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/site/server.js";
import { installSiteFixture } from "./helpers/site-fixture.js";
import { getMatchStatus } from "../src/site/lib/clock.js";

const occurrences = (html, marker) => html.split(marker).length - 1;

test("Phase 3 browsing pages, filters, privacy, clock, and errors", async (t) => {
    const fixture = installSiteFixture(t.mock);
    const { data } = fixture;
    const before = JSON.stringify(data);
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, "127.0.0.1");
        listener.once("listening", () => resolve(listener));
        listener.once("error", reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const cookie = `uid=${data.users[0]._id}`;
    const get = async (path, identity = cookie) => {
        const response = await fetch(`${base}${path}`, {
            headers: identity ? { Cookie: identity } : {},
        });
        return { response, html: await response.text() };
    };
    try {
        await t.test("shared shell, semantic controls and all three match groups", async () => {
            const { response, html } = await get("/matches", "");
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("cache-control"), "no-store");
            assert.equal(occurrences(html, 'class="match-card"'), 18);
            for (const status of ["live", "upcoming", "past"]) {
                assert.ok(html.includes(`href="/matches?status=${status}#explore"`));
            }
            assert.ok(html.includes('href="/matches#explore"'));
            for (const label of [
                "Live right now",
                "Coming up next",
                "From the archives",
                "My bookings",
                "Inbox",
                'id="site-time"',
                'datetime="2026-10-10T08:30:00.000Z"',
                'for="sport"',
                'for="location"',
                'for="q"',
            ])
                assert.ok(html.includes(label), label);
            assert.ok(!html.includes("/admin/clock"));
            assert.ok(!html.includes('/book"'));
        });
        await t.test(
            "status boundaries, sports, literal text, location and combined filters",
            async () => {
                for (const status of ["live", "upcoming", "past"]) {
                    const { html } = await get(`/matches?status=${status}`);
                    assert.equal(
                        occurrences(html, 'class="match-card"'),
                        data.matches.filter(
                            (match) =>
                                getMatchStatus(match, new Date(data.config[0].value)) === status,
                        ).length,
                    );
                }
                for (const [query, count] of [
                    ["location=bAnGaLoRe", 1],
                    ["location=Bengaluru", 1],
                    ["location=INDIA", 8],
                    ["location=Deccan", 1],
                    ["q=Festival", 2],
                    ["q=.*", 0],
                    ["sport=tennis&status=upcoming&location=London", 1],
                    ["sport=football", 5],
                ]) {
                    const { response, html } = await get(`/matches?${query}`);
                    assert.equal(response.status, 200);
                    assert.equal(occurrences(html, 'class="match-card"'), count, query);
                }
                const filtered = await get("/matches?sport=tennis&location=London&q=semi");
                assert.ok(filtered.html.includes("sport=tennis&amp;location=London&amp;q=semi"));
                for (const query of [
                    "status=wrong",
                    "sport=rugby",
                    "sport=tennis&sport=football",
                    "q[x]=bad",
                    `q=${"a".repeat(161)}`,
                ]) {
                    const { response, html } = await get(`/matches?${query}`);
                    assert.equal(response.status, 400, query);
                    assert.ok(html.includes('role="alert"'));
                }
                const empty = await get("/matches?location=Atlantis");
                assert.ok(empty.html.includes("No matches found"));
            },
        );
        await t.test(
            "details show event inventory, free price, policy and postponement",
            async () => {
                for (const index of [2, 6, 10, 11]) {
                    const match = data.matches[index];
                    const { response, html } = await get(`/matches/${match._id}`);
                    assert.equal(response.status, 200);
                    assert.ok(html.includes(match.policyText.replaceAll("'", "&#39;")));
                    assert.ok(
                        html.includes(
                            index === 6
                                ? "Sold out"
                                : index === 10
                                  ? "Free entry"
                                  : index === 11
                                    ? "Postponed"
                                    : "2 tickets remaining",
                        ),
                    );
                    assert.ok(html.includes('datetime="' + match.endsAt.toISOString() + '"'));
                    assert.ok(!html.includes("Phase 4"));
                    assert.ok(!html.includes('data-risk="irreversible"'));
                }
                for (const id of ["bad-id", "200000000000000000000099"])
                    assert.equal((await get(`/matches/${id}`)).response.status, 404);
            },
        );
        await t.test(
            "identity scopes tickets, waitlist and inbox, and denies foreign tickets",
            async () => {
                const bookings = await get("/bookings");
                assert.equal(bookings.response.status, 200);
                assert.ok(bookings.html.includes("MD-1001"));
                assert.ok(bookings.html.includes("MD-1002"));
                assert.ok(!bookings.html.includes("MD-1003"));
                assert.ok(bookings.html.includes("No waitlist spots yet"));
                const inbox = await get("/inbox");
                assert.equal(occurrences(inbox.html, 'class="message-card"'), 2);
                assert.ok(!inbox.html.includes("MD-1003"));
                const ticket = await get(`/bookings/${data.bookings[0]._id}`);
                assert.equal(ticket.response.status, 200);
                assert.ok(ticket.html.includes("Demo Student"));
                for (const path of ["/bookings", "/inbox", `/bookings/${data.bookings[0]._id}`]) {
                    for (const uid of ["", "uid=bad", "uid=100000000000000000000099"])
                        assert.equal((await get(path, uid)).response.status, 401);
                }
                const foreign = await get(`/bookings/${data.bookings[2]._id}`);
                const missing = await get("/bookings/300000000000000000000099");
                assert.equal(foreign.response.status, 404);
                assert.equal(foreign.html, missing.html);
                assert.equal((await get("/bookings/bad-id")).response.status, 404);
                const other = await get("/bookings", `uid=${data.users[5]._id}`);
                assert.ok(!other.html.includes("MD-1001"));
            },
        );
        await t.test(
            "pages use the same clock, update boundaries, and never mutate records",
            async () => {
                for (const path of [
                    "/matches",
                    `/matches/${data.matches[2]._id}`,
                    "/bookings",
                    `/bookings/${data.bookings[0]._id}`,
                    "/inbox",
                    "/missing",
                ])
                    assert.ok(
                        (await get(path)).html.includes('datetime="2026-10-10T08:30:00.000Z"'),
                    );
                const clock = data.config[0].value;
                data.config[0].value = data.matches[2].startsAt.toISOString();
                const live = await get(`/matches/${data.matches[2]._id}`);
                assert.ok(live.html.includes("badge-live"));
                data.config[0].value = data.matches[2].endsAt.toISOString();
                assert.ok(
                    (await get(`/matches/${data.matches[2]._id}`)).html.includes("badge-past"),
                );
                data.config[0].value = clock;
                assert.equal(JSON.stringify(data), before);
            },
        );
        await t.test(
            "synthetic cancelled tickets, waitlist, empty views and escaped inbox bodies",
            async () => {
                const booking = data.bookings[0];
                const original = { ...booking };
                booking.status = "cancelled";
                booking.refundAmount = 1000;
                booking.cancelledAt = new Date(data.config[0].value);
                assert.ok((await get(`/bookings/${booking._id}`)).html.includes("Refund:"));
                Object.assign(booking, original);
                data.waitlist.push({
                    _id: "600000000000000000000001",
                    matchId: data.matches[6]._id,
                    userId: data.users[0]._id,
                    quantity: 2,
                    position: 3,
                    createdAt: new Date(data.config[0].value),
                });
                assert.ok((await get("/bookings")).html.includes("#3"));
                data.waitlist.pop();
                const body = data.outbox[0].body;
                data.outbox[0].body = '<script>alert("bad")</script>\nNext line';
                const html = (await get("/inbox")).html;
                assert.ok(html.includes("&lt;script&gt;"));
                assert.ok(!html.includes("<script>alert"));
                data.outbox[0].body = body;
                const search = await get("/matches?q=%3Cscript%3E");
                assert.ok(search.html.includes("&lt;script&gt;"));
                const records = [...data.bookings];
                const outbox = [...data.outbox];
                data.bookings.length = 0;
                data.outbox.length = 0;
                assert.ok((await get("/bookings")).html.includes("Your next matchday awaits"));
                assert.ok((await get("/inbox")).html.includes("You're all caught up"));
                data.bookings.push(...records);
                data.outbox.push(...outbox);
            },
        );
        await t.test(
            "missing clock, stale tier data and database failures return sanitized errors",
            async () => {
                const clock = data.config.pop();
                assert.equal((await get("/matches")).response.status, 503);
                data.config.push(clock);
                const price = data.matches[0].price;
                delete data.matches[0].price;
                assert.equal((await get("/matches")).response.status, 503);
                data.matches[0].price = price;
                fixture.failure = true;
                const error = await get("/matches");
                assert.equal(error.response.status, 500);
                assert.ok(!error.html.includes("private database error"));
                fixture.failure = false;
            },
        );
        await t.test(
            "CSS and navigation script are served without a database request",
            async () => {
                for (const path of [
                    "/css/base.css",
                    "/css/components.css",
                    "/css/pages.css",
                    "/js/navigation.js",
                ])
                    assert.equal((await get(path)).response.status, 200);
            },
        );
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        fixture.restore();
    }
});
