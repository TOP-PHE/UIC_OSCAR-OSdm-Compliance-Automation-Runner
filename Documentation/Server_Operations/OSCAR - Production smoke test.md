# OSCAR - Production smoke test

After each successful promotion, and every morning at 06:17 UTC, the GitHub
workflow `production-smoke.yml` asks production for a few scenarios on a
simulator. It goes through the test automation API, as a company's CI would
(#1359), using the example client `OSCAR_API_TestTool/`.

The job goes red when production no longer runs a test from end to end:
sign-in, queue, runner, collection, results. That is what went unseen twice
before: isolated runs that could not load their data file for a week, and the
long poll cut by nginx with 504.

After a promotion, the job first waits until `/health` shows the promoted
release (`release_label`), at most 20 minutes, because Watchtower takes the new
image within about five minutes. It then runs the scenarios and writes the
client's report in the job's summary. The exit code is the verdict: 0 passed,
1 failed, 2 incomplete, 3 not finished, 4 an error.

Until the environment below holds the account, the job says so and passes.

## Set-up (once)

### 1. A Company API account for GitHub, in OSCAR

As a Test Manager of **UIC Simulateurs**, the company that has the simulators
as providers. Not the platform company *UIC*: OSCAR never starts tests there.

1. **API Accounts** → *Make an account*: name `GitHub production smoke`, tick
   **GAMMA only**. The account may then test nothing else.
2. In its row, *Set its OSDM credentials* → section GAMMA:
   - choose **OAuth2**, *credentials in Basic auth header*;
   - token URL `https://<simulator host>/gamma/oauth/token`;
   - a simulator client of its own. A new one comes from *Admin → OSDM
     Simulator* (an administrator); its secret is shown once.

   Then click *Test the account's credentials for GAMMA*.
3. Make a key pair in a temporary folder that no repository and no
   synchronised drive holds. The Node command is in *OSCAR - Test Automation
   API Guide*, § 3. Paste `oscar-ci.pub` into the account's card (*Add this
   public key*), and note the account's **client id** (a UUID).
4. The scenarios it runs must be **shared** in GAMMA's Test Config. The
   default ones come from the GAMMA reference and are shared:
   `SIM_SALE_SEARCH_1ADT_38`, `SIM_REFUND_RETURN_1ADT_38`,
   `SIM_EXCHANGE_1ADT_38`.

### 2. A GitHub environment of its own

Repository → *Settings* → *Environments* → *New environment*, named
`oscar-smoke`:

- **No required reviewer.** The job must start by itself. That is why it never
  uses the `production` environment, which asks a reviewer before each job.
- *Deployment branches and tags*: **Selected branches**, `main` only.
- **Environment secrets**:
  - `OSCAR_SMOKE_CLIENT_ID`: the account's client id;
  - `OSCAR_SMOKE_PRIVATE_KEY`: the whole text of `oscar-ci.key`, from
    `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----`.
- **Environment variables**, both optional:
  - `OSCAR_SMOKE_PROVIDER`: the provider's name, `GAMMA` if not set;
  - `OSCAR_SMOKE_SCENARIOS`: the codes, separated by commas, the three above
    if not set.

Then delete the local copy of `oscar-ci.key`: GitHub holds it now, and OSCAR
only ever holds the public key.

### 3. First run

*Actions* → *Production smoke · OSCAR API* → *Run workflow*. The summary
shows the client's report, and each run is on the Dashboard of UIC
Simulateurs, started by *GitHub production smoke*.

## When it is red

| The summary says | Look at |
|---|---|
| `Release … did not answer within 20 minutes` | The promotion's own job, then Watchtower on the VPS (`docker logs watchtower`) |
| `OSCAR refused the token request (HTTP 401)` | The account is suspended, its key revoked, or the secrets were changed |
| `HTTP 409 — GAMMA: …` | The account's GAMMA credentials, or the simulator's endpoint (suspended?) |
| `Nothing would run …` | A code no longer shared, or changed, in GAMMA's Test Config |
| a run `failed` | Open its link: OSCAR or the simulator changed, or a real regression |
| `not_a_result` / exit 2 | The runs did not finish (runner, pods): the run's page says why |

To stop it at once, *Suspend* the account on API Accounts. Its tokens stop
working and the job goes red until you resume it. You can also disable the
workflow in *Actions*.
