# MatchDay & MatchPilot

MatchDay is a sports event booking application. MatchPilot is an AI assistant
that handles natural-language requests by browsing MatchDay, reading application
data, and asking for approval before submitting changes.

## Features

- Discover sports events and view availability, prices, and venue details.
- Book tickets, reserve free fan-screening entry, cancel bookings, and join waitlists.
- View tickets and confirmation messages, and update the demo user's profile.
- Submit natural-language tasks through an asynchronous agent API.
- Answer clarification questions and approve or reject proposed actions.
- Inspect task results and execution traces, with database verification of supported actions.

## Tech stack

Node.js, Express, EJS, MongoDB, Mongoose, LangChain, LangGraph, Groq, Playwright,
and Zod. MatchDay renders its pages on the server; MatchPilot uses Chromium for
browser interactions.

## Prerequisites

- Node.js 20.19 or later and npm.
- MongoDB Atlas or a local MongoDB replica set. Booking operations and seeding
  require transaction support.
- A Groq API key for agent tasks.
- Playwright Chromium, installed with the command below.

## Installation

Run these commands from the repository root:

```sh
cd backend
npm ci
npm run install:chromium
```

### Configuration

Create or update `backend/.env` with your local settings. Preserve any existing
credentials and keep this file out of version control.

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=openai/gpt-oss-20b
STUDENT_EMAIL=demo@example.com
SITE_URL=http://localhost:4000
SITE_PORT=4000
AGENT_PORT=5000
HEADLESS=false
```

The application explicitly selects the `MatchDay` database, defined in
`src/constants.js`. `STUDENT_EMAIL` identifies the main demo account and is
required for seeding and agent tasks.

The current model factory uses Groq. Configuration forces this provider even
if a legacy `LLM_PROVIDER` setting selects Gemini.

| Variable                  | Default                              | Purpose                                           |
| ------------------------- | ------------------------------------ | ------------------------------------------------- |
| `MONGODB_URI`             | Required                             | MongoDB connection URI                            |
| `GROQ_API_KEY`            | Required for agent tasks             | Groq credentials                                  |
| `GROQ_MODEL`              | `openai/gpt-oss-20b`                 | Agent model                                       |
| `STUDENT_EMAIL`           | Required for seeding and agent tasks | Main demo account email                           |
| `SITE_URL`                | `http://localhost:4000`              | Website address used by the browser agent         |
| `SITE_PORT`               | `4000`                               | MatchDay server port                              |
| `AGENT_PORT`              | `5000`                               | MatchPilot API port                               |
| `HEADLESS`                | `false`                              | Run Chromium without a visible window when `true` |
| `MAX_STEPS`               | `25`                                 | Agent step limit                                  |
| `MAX_LLM_CALLS`           | `30`                                 | Per-task model request budget, including retries  |
| `LLM_REQUESTS_PER_MINUTE` | `4`                                  | Model request rate limit                          |
| `LLM_TOKENS_PER_MINUTE`   | `7000`                               | Estimated model token budget per minute           |
| `GROQ_MAX_OUTPUT_TOKENS`  | `2048`                               | Model output allowance                            |

Use different ports for the two servers. If you change `SITE_PORT`, update
`SITE_URL` to match it.

### Demo data

Preview the seed records without connecting to or changing MongoDB:

```sh
npm run seed -- --dry-run
```

To initialize or reset a dedicated demo database:

```sh
npm run seed -- --confirm-reset MatchDay
```

**This replaces existing records** in `users`, `matches`, `bookings`, `waitlist`,
`outbox`, and `config`. It preserves `agent_runs` and other collections. Use it
only when you intend to reset the demo data.

The seed includes events, users, bookings, confirmations, and a fixed mock
clock. Event status, refund eligibility, and business timestamps follow this
clock rather than the computer's current time.

## Running locally

Start the website and agent in separate terminals from `backend/`:

```sh
npm run start:site
```

```sh
npm run start:agent
```

Open `http://localhost:4000/matches`, then select **Open demo session** to use
the seeded account. For automatic restarts during development, use `npm run dev`
and `npm run dev:agent`.

Both services bind to the local machine. Health endpoints are available at
`http://127.0.0.1:4000/health` and `http://127.0.0.1:5000/health`; they return
HTTP 503 when MongoDB is disconnected.

## Agent API

The default API base URL is `http://127.0.0.1:5000`.

Submit a task:

```sh
curl -X POST http://127.0.0.1:5000/tasks \
  -H 'Content-Type: application/json' \
  -d '{"task":"Find upcoming cricket matches in Bangalore under INR 1000. Do not book."}'
```

The API returns HTTP 202 with `data.taskId`. Poll the task endpoint for progress.

| Method | Endpoint             | Purpose / JSON body                                      |
| ------ | -------------------- | -------------------------------------------------------- |
| `POST` | `/tasks`             | Start a task: `{"task":"..."}`                           |
| `GET`  | `/tasks/:id`         | Read status, pending interaction, and result             |
| `GET`  | `/tasks/:id/trace`   | Read ordered execution steps                             |
| `POST` | `/tasks/:id/answer`  | Answer a question: `{"questionId":"...","answer":"..."}` |
| `POST` | `/tasks/:id/approve` | Approve the pending action: `{"proposalId":"..."}`       |
| `POST` | `/tasks/:id/reject`  | Reject the pending action: `{"proposalId":"..."}`        |

Tasks report `running`, `needs_input`, `awaiting_approval`, `done`, or `failed`.
Use the question or proposal ID from the current task response when resuming.
Answering a question does not approve an action. Stale IDs, incompatible task
states, and concurrent resumes return HTTP 409.

The [Postman collection](postman/phase7.collection.json) includes these requests.
Set its `agent_url` variable to your running API address; the collection's
saved default uses port 5001.

## Architecture

```text
backend/
  src/
    config.js           Environment loading and validation
    constants.js        Application database name
    db/                 MongoDB connection
    controllers/        Website and task request handlers
    site/
      server.js         MatchDay entry point
      models/           Application data models
      routes/           Website routes
      services/         Booking and other action logic
      views/            EJS pages and partials
      public/           Styles, scripts, and images
      seed/             Demo data and reset script
    agent/
      index.js          MatchPilot API entry point
      runtime.js        Task lifecycle and resource management
      graph.js          LangGraph workflow
      llm.js            Groq model and request handling
      prompt.js         Agent prompts
      nodes/            Workflow steps
      tools/            Browser, read-only database, and control tools
      verification.js   Action outcome checks
  evals/                Evaluation scenarios and runner
  scripts/              Development utilities
  postman/              API collection
  docs/                 Architecture documentation
  evidence/             Generated artifacts, gitignored
```

Website changes happen through browser forms. Database tools expose bounded,
allowlisted reads scoped to the demo account. Submissions pause for explicit
approval, and supported outcomes are checked against database evidence before
successful completion.

## Limitations

- Demo sessions select a fictional user; they are not production authentication.
- Paused tasks retain browser resources and count toward the four-task limit.
- Browser sessions and graph checkpoints are held in memory. A server restart
  marks unfinished tasks as failed; persisted traces remain available.
- Action verification supports one persisted action per task. Split requests
  containing multiple changes into separate tasks.
- Waitlists record queue positions without automatic promotion or removal.
- Model availability, quotas, and configured request budgets can interrupt tasks.

## Code formatting

From `backend/`, apply formatting with `npm run format`, or check it without
editing files using `npm run format:check`.

## License

The backend package declares the ISC license in `package.json`.
