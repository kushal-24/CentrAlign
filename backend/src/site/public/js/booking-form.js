const form = document.querySelector("[data-booking-price]");

if (form) {
    const quantity = form.querySelector("#quantity");
    const total = form.querySelector("#booking-total");
    const price = Number(form.dataset.bookingPrice);
    const money = new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    });

    quantity.addEventListener("input", () => {
        const count = Number(quantity.value);

        total.textContent =
            Number.isSafeInteger(count) && count > 0 ? money.format(price * count) : "—";
    });
}
