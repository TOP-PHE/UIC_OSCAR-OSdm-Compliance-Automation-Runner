# OSCAR API TestTool

`oscar-test` is a small command-line tool that plays your company's test
automation: it asks OSCAR for conformance tests as a **Company API account**,
waits for the verdict, prints where each run failed, and writes JUnit XML.

It is what a CI pipeline would do (OSCAR #1342), runnable from your PC. It is
also the reference client for integrators: `src/oscar.js` signs in,
`src/run.js` asks, waits and reports.

**To check an API set-up with it, step by step,** see *OSCAR - Test
Automation API Guide*, § 10
([Documentation/User_Guides](../Documentation/User_Guides/OSCAR%20-%20Test%20Automation%20API%20Guide.md)).
Copy this folder anywhere: it needs nothing else from the repository.

- **Node 22 or later. No dependency:** nothing to install.
- **Signs in with OAuth 2.0 client credentials and `private_key_jwt`**
  (RFC 7523). The private key stays on your PC; OSCAR holds only the public key.
- **Reads results only**, as the API gives them. Logs and message content stay
  in OSCAR: each run in the report gives the address of its page.

## 1. Before the first run, in OSCAR

You need **OSCAR 1.11.561 or later** (release 2026.600) on the server you test.
That server must have `APP_URL` set, or its token endpoint answers 503.

As a Test Manager of **UIC Simulateurs**:

1. **Make an account.** Menu **API Accounts** → *Make an account*: name it
   ("PC test client") and tick the simulators it may test (alpha, beta, delta…).
2. **Give it simulator credentials.** In its row, *Set its OSDM credentials*
   opens API Config for the account, one section per simulator. Enter a
   simulator account's client id and secret in each, then *Test the account's
   credentials*.
   - **Tip:** with your administrator account, give the tool simulator
     accounts of its own (*Admin → OSDM Simulator*). Its traffic then shows
     apart in the simulator's statistics.
3. **Give it a key.** Make a key pair (§ 2) and paste the **public** key in
   the card *Signing in to the API*. Note the account's **client id** shown
   there.
4. **Optionally, a suite.** On the **Run** page, choose a selection and save
   it as a suite (card *Named suites*), for example `smoke`.

## 2. The key pair

In PowerShell, with OpenSSL (Git for Windows has one):

```powershell
openssl ecparam -name prime256v1 -genkey -noout -out oscar-ci.key
```

```powershell
openssl ec -in oscar-ci.key -pubout -out oscar-ci.pub
```

Paste `oscar-ci.pub` in OSCAR. Keep `oscar-ci.key` private; `.gitignore`
keeps it out of git. An RSA key of 2048 bits or more works too (PS256).

## 3. Running it

Set the three settings once per PowerShell window:

```powershell
$env:OSCAR_URL = "https://<oscar host>"; $env:OSCAR_CLIENT_ID = "<the account's client id>"; $env:OSCAR_PRIVATE_KEY_FILE = "$PWD\oscar-ci.key"
```

Check who you are and what you may test:

```powershell
node oscar-test.js --whoami
```

List the company's suites:

```powershell
node oscar-test.js --suites
```

Run the suite `smoke` on alpha and beta, wait for the verdict, write JUnit:

```powershell
node oscar-test.js --provider alpha --provider beta --suite smoke --junit result.xml
```

Or name scenarios:

```powershell
node oscar-test.js --provider gamma --scenarios OTST_SALE_ONE_WAY_1ADT,OTST_REFUND_FULL_1ADT
```

A request still running when `--timeout` ends (60 minutes by default) can be
waited for again:

```powershell
node oscar-test.js --status <test request id> --junit result.xml
```

The tool waits 50 seconds at a time. If a proxy in front of OSCAR cuts a wait
(HTTP 502, 503 or 504), it asks again with a shorter wait, and after five cuts
in a row it stops (exit 4) and says how to wait again. A `--selection` file is
read whatever encoding PowerShell wrote it in. More problems and their causes:
the guide's § 11.

### Options

| Option | |
|---|---|
| `--provider <name or id>` | a simulator (or the company) to test; repeat it, or separate with commas. Names are matched without case |
| `--suite <name>` | a named suite of the company |
| `--scenarios <A,B,…>` | scenario codes |
| `--selection <file.json>` | a selection as the Run page makes it: `{ "categories": ["happy"], "groups": ["Refund"] }` (OSCAR's spelling, case included) |
| `--categories`, `--modes`, `--groups`, `--forms` | the Run page's filters, each a list, upper or lower case: `happy,refusal,simulated`; `PRODUCT,FARE`; `"Sale,Refund,Seat reservations"`…; `SEARCH,SPECIFICATION,TRIP_IDS`… (`--help` lists every value) |
| `--last-run <all\|toRunAgain\|failed>` | the Run page's *Last run* |
| `--run-list` | each provider's own run list (the Run page's *My run list*) instead of every scenario |
| `--reference <text>` | your own id (a pipeline number), given back as it is |
| `--idempotency-key <key>` | a retry with the same key and request runs nothing twice |
| `--timeout <minutes>` | how long to wait for the verdict (60) |
| `--junit <file>` / `--json <file>` | write the results |
| `--oscar`, `--client-id`, `--key` | instead of the environment variables |

Only one of `--suite`, `--scenarios`, `--selection`, or the filter options. The
filter options build the same selection as a `--selection` file, without a
file: a filter left out keeps the Run page's default (every value, but the
categories: happy and refusal). For example, refunds of the happy flows on each
provider's own run list:

```powershell
node oscar-test.js --provider GAMMA,ALPHA --categories happy --groups Refund --run-list
```

A scenario a simulator does not have is reported as *not on this provider*; it
does not stop the run.

`OSCAR_PRIVATE_KEY` may hold the PEM text itself instead of a file, with line
breaks written `\n`. That is handy in a CI's secret variables.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | **passed**: every run passed (a documented known deviation counts as passed) |
| 1 | **failed**: a run failed a check |
| 2 | **incomplete**: a run gave no result (not the provider's fault: run it again) or was cancelled |
| 3 | not finished within `--timeout`: wait again with `--status` |
| 4 | an error: a setting, the network, or a refusal by OSCAR (the message says which) |

## 4. In a CI pipeline

The same command, with the settings in the CI's secret variables. GitHub
Actions, for example:

```yaml
- name: OSCAR conformance tests
  env:
    OSCAR_URL: ${{ secrets.OSCAR_URL }}
    OSCAR_CLIENT_ID: ${{ secrets.OSCAR_CLIENT_ID }}
    OSCAR_PRIVATE_KEY: ${{ secrets.OSCAR_PRIVATE_KEY }}
  run: node oscar-test.js --provider alpha --suite smoke --reference "${{ github.run_id }}" --idempotency-key "gh-${{ github.run_id }}-${{ github.run_attempt }}" --junit oscar-junit.xml
```

Then publish `oscar-junit.xml` with your CI's test report step.

## 5. When it refuses

| Message | What to check |
|---|---|
| `OSCAR refused the token request (HTTP 401). invalid_client` | the client id; the public key pasted in OSCAR matches your private key and is not revoked; the account is not suspended; your PC's clock is right (the assertion lives one minute) |
| `… (HTTP 503) temporarily_unavailable` | the server has no `APP_URL` |
| `"x" is not a company or provider this account may test` | tick it for the account on the API Accounts page |
| `POST /v1/api/test-requests: HTTP 409 — <simulator>: Cannot start run — missing: …` | the account's credentials for that simulator (API Config opened for the account) |
| `… HTTP 404 — Your company has no suite named …` | `--suites` lists them |
| `… HTTP 429` | more than 30 test requests in 10 minutes |

More: *OSCAR - Test Automation API Guide*, § 5 to § 7 and § 10.

## 6. Its own tests

```powershell
npm test
```

They run the tool against a stand-in OSCAR on this machine. The stand-in
checks each signed assertion with the public key, as OSCAR does, and answers
the API as OSCAR does. They run in the repository's required CI job, with
its lint, as the MCP server's do. The tool was also tried against OSCAR's real
routes (token endpoint, test requests, suites, results, JUnit) on a
throwaway local server built from `main`.
