import test from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/site/server.js";
import { installSiteFixture } from "./helpers/site-fixture.js";
import { User } from "../src/site/models/index.js";
import {
    quantityField,
    contactFields,
    requireConfirmation,
    requireBookable,
} from "../src/site/services/action-validation.js";

const good = {
    quantity: "2",
    ownerName: "Riya",
    ownerEmail: "riya@example.com",
    phone: "+919000000001",
    confirm: "yes",
};

test("Phase 4 input rules reject invalid action details", () => {
    assert.equal(quantityField(good), 2);
    assert.deepEqual(contactFields(good), { ownerName: "Riya", ownerEmail: "riya@example.com" });
    assert.doesNotThrow(() => requireConfirmation(good));

    for (const quantity of ["0", "-1", "1.5", "2e1", "NaN", ["1", "2"], "9999999999999999"]) {
        assert.throws(() => quantityField({ quantity }));
    }

    for (const fields of [
        { ownerName: " " },
        { ownerEmail: "bad" },
        { phone: "abc" },
        { phone: ["1234567"] },
    ]) {
        assert.throws(() => contactFields({ ...good, ...fields }));
    }

    assert.throws(() => requireConfirmation({}), /confirm/);
    assert.throws(() => requireConfirmation({ confirm: ["yes"] }), /confirm/);
});

test("Phase 4 demo session, profile and forms enforce HTTP validation", async (t) => {
    const fixture = installSiteFixture(t.mock);
    const data = fixture.data;
    const oldEmail = process.env.STUDENT_EMAIL;
    process.env.STUDENT_EMAIL = "student@example.com";

    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, "127.0.0.1");
        listener.once("listening", () => resolve(listener));
        listener.once("error", reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const uid = `uid=${data.users[0]._id}`;
    const request = async (path, body, cookie = uid, origin = base) => {
        const response = await fetch(base + path, {
            method: body === undefined ? "GET" : "POST",
            redirect: "manual",
            headers: {
                ...(cookie ? { Cookie: cookie } : {}),
                ...(body === undefined
                    ? {}
                    : { "Content-Type": "application/x-www-form-urlencoded", Origin: origin }),
            },
            body: body === undefined ? undefined : new URLSearchParams(body),
        });
        return { response, html: await response.text() };
    };

    try {
        await t.test(
            "one-click session opens, closes and rejects cross-site requests",
            async () => {
                const open = await request("/session/demo", {}, "");
                assert.equal(open.response.status, 303);
                assert.equal(open.response.headers.get("location"), "/bookings");
                const cookie = open.response.headers.get("set-cookie");
                assert.match(cookie, /HttpOnly/);
                assert.match(cookie, /SameSite=Lax/);
                assert.match(cookie, /Path=\//);
                const close = await request("/session/close", {});
                assert.equal(close.response.status, 303);
                assert.match(close.response.headers.get("set-cookie"), /Expires=/);
                assert.equal((await request("/profile", undefined, "")).response.status, 401);
                assert.equal(
                    (await request("/session/demo", {}, "", "https://other.example")).response
                        .status,
                    403,
                );
                const email = process.env.STUDENT_EMAIL;
                process.env.STUDENT_EMAIL = "absent@example.com";
                assert.equal((await request("/session/demo", {}, "")).response.status, 503);
                process.env.STUDENT_EMAIL = email;
            },
        );

        await t.test("profile only saves current user's name and phone", async () => {
            const before = JSON.stringify({
                bookings: data.bookings,
                outbox: data.outbox,
                others: data.users.slice(1),
            });
            const update = t.mock.method(User, "findOneAndUpdate", async (query, change) => {
                assert.equal(query._id.toString(), data.users[0]._id.toString());
                assert.deepEqual(Object.keys(change.$set), ["name", "phone"]);
                Object.assign(data.users[0], change.$set);
                return data.users[0];
            });
            const saved = await request("/profile", {
                name: "Demo Reader",
                phone: "+919999999999",
            });
            assert.equal(saved.response.status, 303);
            assert.ok((await request("/profile")).html.includes("Demo Reader"));
            assert.equal(
                JSON.stringify({
                    bookings: data.bookings,
                    outbox: data.outbox,
                    others: data.users.slice(1),
                }),
                before,
            );
            for (const values of [
                { name: " ", phone: "1234567" },
                { name: "Reader", phone: "bad" },
                { name: "Reader", phone: "1234567", email: "new@example.com" },
                { name: "Reader", phone: "1234567", userId: data.users[1]._id.toString() },
            ]) {
                assert.equal((await request("/profile", values)).response.status, 400);
            }
            assert.equal(update.mock.callCount(), 1);
            update.mock.restore();
        });

        await t.test("forms, prefill, free price, risk buttons and errors render", async () => {
            const paid = await request(`/matches/${data.matches[2]._id}/book`);
            assert.equal(paid.response.status, 200);
            assert.ok(paid.html.includes('value="Demo Reader"'));
            assert.ok(paid.html.includes('data-risk="irreversible"'));
            assert.ok(paid.html.includes('for="phone"'));
            const free = await request(`/matches/${data.matches[10]._id}/book`);
            assert.ok(free.html.includes('data-booking-price="0"'));
            assert.equal(
                (await request(`/matches/${data.matches[6]._id}/waitlist`)).response.status,
                200,
            );
            assert.equal(
                (await request(`/matches/${data.matches[2]._id}/book`, undefined, "")).response
                    .status,
                401,
            );
            assert.equal((await request("/matches/bad/book")).response.status, 404);
            for (const values of [
                { ...good, quantity: "0" },
                { ...good, confirm: "no" },
                { ...good, phone: "abc" },
            ]) {
                const result = await request(`/matches/${data.matches[2]._id}/book`, values);
                assert.equal(result.response.status, 400);
                assert.ok(result.html.includes('role="alert"'));
                assert.ok(result.html.includes('value="Riya"'));
            }
            assert.equal(
                (
                    await request(`/matches/${data.matches[6]._id}/waitlist`, {
                        quantity: "0",
                        confirm: "yes",
                    })
                ).response.status,
                400,
            );
            assert.equal(
                (await request(`/bookings/${data.bookings[0]._id}/cancel`, {})).response.status,
                400,
            );
            assert.equal(
                (await request(`/bookings/${data.bookings[2]._id}/cancel`, {})).response.status,
                404,
            );
            assert.equal((await request("/bookings/bad/cancel", good)).response.status, 404);
        });

        await t.test("closed, postponed and quantity-limit rules use mock time", () => {
            const now = new Date(data.config[0].value);
            assert.throws(() => requireBookable(data.matches[0], now, 1), /closed/);
            assert.throws(() => requireBookable(data.matches[13], now, 1), /closed/);
            assert.throws(() => requireBookable(data.matches[11], now, 1), /postponed/);
            assert.throws(() => requireBookable(data.matches[7], now, 3), /Maximum 2/);
            assert.doesNotThrow(() => requireBookable(data.matches[10], now, 1));
        });
    } finally {
        if (oldEmail === undefined) delete process.env.STUDENT_EMAIL;
        else process.env.STUDENT_EMAIL = oldEmail;
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        fixture.restore();
    }
});
