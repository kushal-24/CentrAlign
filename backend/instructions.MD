1. Your biggest source of wasted calls is probably this
You effectively have:

LLM → snapshot
LLM → click
LLM → snapshot
LLM → click
LLM → snapshot
LLM → fill
LLM → snapshot

That's extremely expensive from an RPM perspective.
Instead, make your browser executor behave more like:
LLM
 ↓
browser action
 ↓
Playwright
 ↓
automatic observation
 ↓
LLM

So:
LLM #1
   ↓
click(matches)
   ↓
Playwright
   ↓
automatic snapshot
   ↓
LLM #2

There is no reason for the LLM to separately request snapshot() if your executor already knows that the page changed.

2. Batch deterministic browser actions
This is probably the biggest optimization you can make.
Instead of the model producing:
click(12)

then getting called again:
click(17)

then again:
fill(21, "2")

you can let it produce a sequence:
{
  "actions": [
    {"type": "click", "target": 12},
    {"type": "click", "target": 17},
    {"type": "fill", "target": 21, "value": "2"}
  ]
}
Don't batch everything.
Batch only actions that are highly deterministic and unlikely to change the page:

fill username
fill password
select dropdown
check checkbox

But keep potentially state-changing/navigation actions individually reasoned:

click Match
     ↓
fresh snapshot
     ↓
LLM
     ↓
click Book
     ↓
approval interrupt

And the interrupt node doesn't need to be triggered by an action failure. That's an important distinction.
You can have two separate routes:
                    EXECUTOR
                       │
             ┌─────────┴─────────┐
             │                   │
        action failed       approval needed
             │                   │
             ▼                   ▼
         RECOVERY             INTERRUPT
             │                   │
             ▼                   ▼
            LLM               USER

So if click(17) fails → Recovery node.
If the agent reaches Confirm Booking → Interrupt node.
That's actually cleaner than making every failure go through the interrupt.

3. Separate "reasoning" from ``execution``
This is the architecture I'd recommend for CentrALign.
LLM should answer:
"What should I do?"

Your code should answer:
"How do I physically do it?"

5. Don't use an LLM for verification
Suppose Playwright performs:
Click "Book"

Don't do:
Playwright
 ↓
LLM: "Did the booking succeed?"

Instead inspect the website programmatically:
const confirmation = await page.locator(
  '[data-testid="booking-success"]'
).isVisible();

or:
const text = await page.locator("body").innerText();

if (text.includes("Booking confirmed")) {
    // success
}

That's:
Playwright → deterministic verifier → DONE

Zero LLM calls.

6. Deterministic Final Response — Do Not Use an Extra LLM Call

Do not invoke the LLM solely to generate the final user-facing response after an agent task has already completed.

Once the LangGraph workflow has finished its browser actions and the deterministic verification layer has established the final outcome, generate the final response directly from the structured result in code.

Important: This does NOT mean the LLM should never produce natural-language responses

The LLM should still be used whenever reasoning or interpretation is actually required.

For example:

SOLD_OUT
    ↓
LLM reasons about possible alternatives
    ↓
"That match is sold out. I found another match tomorrow at 7 PM. Would you like me to book it?"

That is a legitimate LLM use because the model is making a decision/reasoning about what to do next.

However, if the workflow already knows the result, do not spend another LLM request merely converting structured data into a sentence.

Required architecture

The final stage should follow:

Playwright execution
        ↓
Deterministic verification
        ↓
Structured result
        ↓
LangGraph routing
        ↓
┌──────────────────────────────────────────────┐
│ success → deterministic final response       │
│ needs_input → interrupt / ask user            │
│ expected failure → deterministic or LLM path │
│ system error → recovery / report             │
└──────────────────────────────────────────────┘

Avoid:
LLM → action → LLM → action → LLM → final response

Prefer:
LLM → browser execution → verification → routing → final response

7. I'd put an LLM-call budget into your graph
For your demo, I'd literally enforce something like:
const MAX_LLM_CALLS = 6;

Maintain:
state.llmCallCount

Before every LLM invocation:
if (state.llmCallCount >= MAX_LLM_CALLS) {
    throw new Error("Agent reasoning budget exceeded");
}

That gives you a very nice safety mechanism.