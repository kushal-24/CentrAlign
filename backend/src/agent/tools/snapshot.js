export async function takeSnapshot(session) {
    const { page } = session;
    await page.waitForLoadState("domcontentloaded");
    const start = session.nextRef;

    const snapshot = await page.evaluate(
        ({ start }) => {
            const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();
            const visible = (element) =>
                element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
                element.getClientRects().length > 0 &&
                !element.closest('[inert], [aria-hidden="true"]');
            const visibleText = (element) => {
                const clone = element.cloneNode(true);
                clone
                    .querySelectorAll('[aria-hidden="true"], script, style')
                    .forEach((child) => child.remove());
                return clean(clone.textContent);
            };
            const name = (element) => {
                const labelled = element.getAttribute("aria-labelledby");
                return (
                    clean(element.getAttribute("aria-label")) ||
                    (labelled
                        ? clean(
                              labelled
                                  .split(/\s+/)
                                  .map((id) => document.getElementById(id)?.innerText ?? "")
                                  .join(" "),
                          )
                        : "") ||
                    clean(
                        Array.from(element.labels ?? [])
                            .map(visibleText)
                            .join(" "),
                    ) ||
                    (element.matches('input[type="submit"],input[type="button"]')
                        ? element.value
                        : visibleText(element)) ||
                    element.getAttribute("placeholder") ||
                    element.getAttribute("title") ||
                    ""
                );
            };

            const candidates = Array.from(
                document.querySelectorAll(
                    'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"]',
                ),
            ).filter(visible);
            const elements = candidates.slice(0, 180).map((element, index) => {
                const ref = start + index;
                element.setAttribute("data-ref", String(ref));
                return {
                    ref,
                    role: element.getAttribute("role") || element.tagName.toLowerCase(),
                    name: name(element).slice(0, 240),
                    type: element.type ?? "",
                    value:
                        element.type === "password"
                            ? "[redacted]"
                            : String(element.value ?? "").slice(0, 500),
                    checked: element.checked ?? null,
                    disabled:
                        element.matches(":disabled") ||
                        element.getAttribute("aria-disabled") === "true",
                    readOnly: Boolean(element.readOnly),
                    href: element.href ?? null,
                    risk: element.getAttribute("data-risk"),
                    options:
                        element.tagName === "SELECT"
                            ? Array.from(element.options)
                                  .slice(0, 80)
                                  .map((option) => ({
                                      value: option.value,
                                      label: clean(option.label),
                                      disabled:
                                          option.disabled ||
                                          Boolean(option.closest("optgroup[disabled]")),
                                  }))
                            : undefined,
                };
            });
            const mainText = clean((document.querySelector("main") ?? document.body).innerText);
            return {
                url: location.href,
                title: document.title,
                siteTime: clean(document.querySelector("#site-time")?.innerText),
                alerts: Array.from(document.querySelectorAll('[role="alert"]'))
                    .filter(visible)
                    .slice(0, 12)
                    .map((element) => clean(element.innerText).slice(0, 800)),
                text: mainText.slice(0, 10000),
                truncated: mainText.length > 10000 || candidates.length > 180,
                elements,
            };
        },
        { start },
    );

    for (const entry of session.refs.values()) await entry.handle.dispose();
    session.refs.clear();
    session.nextRef += snapshot.elements.length;
    for (const element of snapshot.elements) {
        const handle = await page.locator(`[data-ref="${element.ref}"]`).elementHandle();
        if (handle) session.refs.set(element.ref, { handle, epoch: session.epoch });
    }
    snapshot.readable = [
        `URL: ${snapshot.url}`,
        `TITLE: ${snapshot.title}`,
        `SITE TIME: ${snapshot.siteTime || "Unavailable"}`,
        `ALERTS: ${snapshot.alerts.join(" | ") || "(none)"}`,
        `PAGE TEXT: ${snapshot.text}`,
        ...(snapshot.truncated ? ["CONTENT TRUNCATED"] : []),
        "ELEMENTS:",
        ...snapshot.elements.map(
            (element) =>
                `[${element.ref}] ${element.role} ${JSON.stringify(element.name)} type=${element.type} value=${JSON.stringify(element.value)}${element.checked === null ? "" : ` checked=${element.checked}`}${element.disabled ? " disabled" : ""}${element.readOnly ? " readonly" : ""}${element.risk ? ` risk=${element.risk}` : ""}${element.href ? ` href=${element.href}` : ""}${element.options ? ` options=${JSON.stringify(element.options)}` : ""}`,
        ),
    ].join("\n");
    session.latestSnapshot = snapshot;
    return snapshot;
}

export async function resolveRef(session, ref) {
    const entry = session.refs.get(ref);
    if (!entry || entry.epoch !== session.epoch)
        throw new Error("Stale or missing reference. Take a fresh snapshot.");
    const valid = await entry.handle
        .evaluate(
            (element, ref) =>
                element.isConnected &&
                document.querySelector(`[data-ref="${ref}"]`) === element &&
                element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
                !element.closest('[inert], [aria-hidden="true"]') &&
                !element.matches(":disabled") &&
                element.getAttribute("aria-disabled") !== "true",
            ref,
        )
        .catch(() => false);
    if (!valid)
        throw new Error("Reference is detached, hidden or disabled. Take a fresh snapshot.");
    return entry.handle;
}
