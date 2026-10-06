const cancellation = document.querySelector("[data-cancel-booking]");

if (cancellation) {
    cancellation.addEventListener("submit", (event) => {
        if (
            !window.confirm(
                `Cancel ${cancellation.dataset.cancelBooking}? Expected refund: ${cancellation.dataset.refund}.`,
            )
        ) {
            event.preventDefault();
        }
    });
}
