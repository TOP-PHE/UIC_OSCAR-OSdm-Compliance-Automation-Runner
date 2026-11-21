# OSCAR – Test Automation API Guide

How a company's own test automation (a CI pipeline, a test tool) asks OSCAR for
conformance tests through an API and reads their results. Issue #1342.

- **Who acts:** a **Company API account**, a user of your company of its own
  kind. It never signs in to OSCAR's pages and never acts as a person.
- **How it signs in:** OAuth 2.0 client credentials with `private_key_jwt`
  (RFC 7523). Your company keeps the private key; OSCAR holds only the public
  key, and no secret is shared.
- **What it asks:** scenarios by code, a selection as the Run page makes it, or
  a named suite, on one or more providers.
- **What it gets back:** results only. That is the verdicts, and where each run
  failed and warned, with the messages, as JSON or JUnit XML. Logs and message
  content stay in OSCAR's pages, and each run gives the address of its page.
- **How it learns a request is finished:** by polling, with a long poll of up
  to 60 seconds. There is no webhook.
- **A working client to start from:** `OSCAR_API_TestTool/` in the repository.
  § 10 uses it to check a set-up step by step, before the CI uses it.
- **When something goes wrong:** § 11 lists the problems met during the first
  real set-up, each with its cause and what to do.

---

## 1. For the Test Manager: set up an account

1. **Make the account.** Menu **API Accounts** → *Make an account*. Give it a
   name (the tool that uses it: "Nightly CI") and tick the providers it may
   test besides your company. You can change the providers later, and taking
   one away stops the account there at once.
2. **Give it OSDM credentials.** In the account's row, *Set its OSDM
   credentials* opens **API Config** for the account. Fill one section per
   company or provider it tests, as you would your own credentials, and use
   *Test the account's credentials*. Its runs use these, never yours. Choose
   OAuth2 where the provider gives a client id and secret: a pre-obtained
   bearer token expires, and the account's runs would then fail.
3. **Give it a public key.** In the card *Signing in to the API*, paste the
   public key your company made (§ 3). Note the account's **client id** and the
   **token endpoint** shown there: your automation needs both.
4. **Optionally, name suites.** On the **Run** page, choose a selection and
   *Save the selection above as a suite* (card *Named suites*). The automation
   then asks it by name. Saved with *My run list*, a suite runs on each provider
   that provider's own run list, as its Test Config selects it.

**The account runs shared scenarios only.** A scenario you create, duplicate or
copy is yours and private until you share it in Test Config, even as a Test
Manager: share every scenario the automation must run (§ 11.3).

To stop an account at once, use **Suspend**. Every token it holds stops
working, even after a resume, and its queued runs do not start. **Delete**
removes it with its runs: suspend it if you want to keep them.

An account belongs to your company's Test Managers. The administrator sees it
listed and changes nothing of it.

## 2. What the account may do

| | |
|---|---|
| Test | its company and the providers it is given, with its own OSDM credentials |
| Run | the company's shared scenarios (never a tester's own) |
| Read | the runs and test requests it launched, never a person's |
| Never | sign in to a page; change the data file, Test Framework, Test Data, endpoint, users or findings |

The company's testers and Test Managers read its runs in OSCAR, as they read a
Test Manager's.

## 3. The key pair

EC P-256 (ES256) or RSA of 2048 bits or more (PS256). With OpenSSL:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out oscar-ci.key
openssl ec -in oscar-ci.key -pubout -out oscar-ci.pub
```

Without OpenSSL (Windows has none by default), Node 22 or later makes the
same pair. In PowerShell:

```powershell
node -e "const c=require('crypto'),fs=require('fs');const k=c.generateKeyPairSync('ec',{namedCurve:'P-256'});fs.writeFileSync('oscar-ci.key',k.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});fs.writeFileSync('oscar-ci.pub',k.publicKey.export({type:'spki',format:'pem'}));console.log('oscar-ci.key and oscar-ci.pub written')"
```

Make the pair in a folder that no repository and no shared or synchronised
drive holds: whatever is there can be copied elsewhere. Keep `oscar-ci.key` where your CI keeps its secrets. Give OSCAR
`oscar-ci.pub` only: OSCAR refuses a private key. An account holds two active
keys at most, so you can change a key without a stop: add the new key, switch
the automation to it, then revoke the old one.

## 4. Getting a token

`POST <OSCAR>/v1/api/oauth/token`, as `application/x-www-form-urlencoded`:

| Field | Value |
|---|---|
| `grant_type` | `client_credentials` |
| `client_assertion_type` | `urn:ietf:params:oauth:client-assertion-type:jwt-bearer` |
| `client_assertion` | a JWT signed with the private key (below) |
| `scope` | optional: `runs:read runs:write` (both when absent) |

The assertion is signed ES256 (EC key) or PS256 (RSA key), with these claims:

| Claim | Value |
|---|---|
| `iss`, `sub` | the account's client id |
| `aud` | the token endpoint, as shown on the page |
| `iat`, `exp` | now, and at most 5 minutes later (one minute is enough) |
| `jti` | a new random value each time: OSCAR accepts each once |

The answer is `{ access_token, token_type: "Bearer", expires_in: 900, scope }`.
Send the token as `Authorization: Bearer <access_token>` to `/v1/api/…`, and
ask a new one when it expires. Any problem with the client (unknown account,
wrong key, expired or replayed assertion, wrong `aud`, suspended account) is
answered with the same `401 invalid_client`, so the answer tells nothing to
someone guessing.

**Node.js (no dependency):**

```js
const crypto = require('node:crypto');
const fs = require('node:fs');

async function oscarToken(oscar, clientId, keyFile) {
  const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = b64({ alg: 'ES256', typ: 'JWT' }) + '.' + b64({
    iss: clientId, sub: clientId, aud: `${oscar}/v1/api/oauth/token`,
    iat: now, exp: now + 60, jti: crypto.randomUUID(),
  });
  const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  const res = await fetch(`${oscar}/v1/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: `${data}.${sig.toString('base64url')}`,
    }),
  });
  if (!res.ok) throw new Error(`token refused: HTTP ${res.status}`);
  return (await res.json()).access_token;
}
```

**Python** (PyJWT with `cryptography`):

```python
import time, uuid, jwt, requests

def oscar_token(oscar, client_id, key_file):
    now = int(time.time())
    assertion = jwt.encode(
        {"iss": client_id, "sub": client_id, "aud": f"{oscar}/v1/api/oauth/token",
         "iat": now, "exp": now + 60, "jti": str(uuid.uuid4())},
        open(key_file).read(), algorithm="ES256")
    r = requests.post(f"{oscar}/v1/api/oauth/token", data={
        "grant_type": "client_credentials",
        "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        "client_assertion": assertion})
    r.raise_for_status()
    return r.json()["access_token"]
```

## 5. Asking for tests

`POST /v1/api/test-requests` (scope `runs:write`), JSON:

```json
{
  "providers": ["<company or provider id>", "<another>"],
  "suite": "nightly",
  "reference": "pipeline 4812"
}
```

- **Exactly one of:** `scenarios` (a list of scenario codes), `selection` (the
  Run page's: `base`, `categories`, `groups`, `forms`, `modes`, `lastRun`), or
  `suite` (a name; `GET /v1/api/suites` lists them).
- **`base: "list"`** (the Run page's *My run list*), in a selection or a
  suite, cuts the selection from **each provider's own run list**, the
  scenarios its Test Config selects, read at each launch: two providers may run
  different scenarios. A provider with no run list set runs every scenario.
  `"all"` (the default) cuts it from every scenario. Either way, the account
  runs shared scenarios only.
- **`providers`:** 1 to 20. `GET /v1/api/key` lists the account's company and
  providers with their ids.
- **`reference`:** your own id, given back as it is.
- **Header `Idempotency-Key`** (optional, 8 to 100 of letters, digits,
  `. _ : -`): a retry with the same key and request gives the same test
  request, and nothing runs twice.

Every provider is checked **before anything is queued**:

| Answer | When |
|---|---|
| `202` + `Location` | queued: one batch per provider |
| `200` | the same `Idempotency-Key` and request were already made |
| `400` | a bad body, or nothing at all would run |
| `403` | a token without `runs:write`, or a read-only API key |
| `404` | a provider the account is not given, or an unknown suite |
| `409` | a provider cannot run now: endpoint suspended, or the endpoint, the account's credentials or the data file missing. The answer names it (`provider`, `missing`) |
| `422` | the `Idempotency-Key` was used for another request |
| `429` | more than 30 requests in 10 minutes |

A scenario code a provider does not have is listed in that provider's
`not_found`. It is not a refusal.

## 6. Waiting and reading the verdict

`GET /v1/api/test-requests/{id}?wait=60` (scope `runs:read`) answers as soon as
the request is finished, or after 60 seconds with its state. Call it again
until `state` is `finished`. Behind a proxy that cuts a call held open
60 seconds (nginx's default read timeout), ask less: `?wait=50`, and on a 502,
503 or 504 ask again with a shorter wait (§ 11.4).

- **`state`:** `queued`, `running` or `finished`.
- **`verdict`**, once finished, is one of three values. Make the pipeline green
  on `passed` only.
  - `failed`: a run failed a check.
  - `incomplete`: a run gave no result, or was cancelled.
  - `passed`: neither of those.
- **Each run** gives its verdict, `reason`, check counts and `run_url`:

| Run verdict | Meaning |
|---|---|
| `passed` | every check passed |
| `passed_with_deviation` | no check failed, and the run applied a known deviation your company documented (a finding baselined in the run). Accepted: the request still passes |
| `failed` | at least one check failed: the provider's answer is not conformant |
| `not_a_result` | the run ended without a test result (`reason`: `NO_CHECKS`, `RUN_NOT_FINISHED`, a token failure…). Never read as the provider's failure: run it again |
| `cancelled` | stopped before its end |

## 7. Where it failed and warned

`GET /v1/api/test-requests/{id}/results` gives the same answer with, for each
run:

- **`failures`:** each failed check. For each, its step, the check's text, the
  failure message, the expected and actual values, the HTTP status, and for an
  error answer the OSDM problem code.
- **`warnings`:** each warning of the run, with its step.
- **`deviations`:** the known deviations it applied.

There are 50 failures and 50 warnings at most per run (`truncated` says when
there were more), and each text is one line. Request and response bodies and
the rest of the log are never in the API: open `run_url` in OSCAR.

**JUnit XML** for your CI's test report: `…/results?format=junit`.

- One test suite per provider, and one test case per run.
- A failed run is a `<failure>`; a run without result is an `<error>`; a
  cancelled or unfinished run is `<skipped>`.
- Warnings and known deviations are in `<system-out>`, because JUnit has no
  warning element.
- The verdict and `run_url` are properties.

**A CI step, for example:**

```bash
# OSCAR, CLIENT_ID and the key file come from the CI's secrets.
TOKEN=$(node oscar-token.js)            # the Node.js function of § 4
REQ=$(curl -sf -X POST "$OSCAR/v1/api/test-requests" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: ci-$CI_PIPELINE_ID" \
  -d '{"providers":["'"$PROVIDER_ID"'"],"suite":"nightly","reference":"'"$CI_PIPELINE_ID"'"}' | jq -r .id)
until [ "$(curl -sf "$OSCAR/v1/api/test-requests/$REQ?wait=50" -H "Authorization: Bearer $TOKEN" | jq -r .state)" = finished ]; do :; done
curl -sf "$OSCAR/v1/api/test-requests/$REQ/results?format=junit" -H "Authorization: Bearer $TOKEN" -o oscar-junit.xml
```

A token lives 15 minutes: a campaign longer than that asks a new one while it
waits.

## 8. An AI assistant on the same account

The OSCAR MCP server (`OSCAR_MCP/`) reads test requests, their results and the
suites as the account, with `OSCAR_CLIENT_ID` and `OSCAR_PRIVATE_KEY`. It asks
the scope `runs:read` only, so it never launches anything. See its README.

## 9. Security in short

- **No secret is shared.** OSCAR holds the account's public keys only. The
  assertion lives one minute and is accepted once. The token lives 15 minutes.
- **The API cannot redirect tests.** It never changes the data file, the Test
  Framework, the endpoint or the credentials, and never takes an address in a
  request. A stolen token can start tests against your provider's registered
  endpoint, and cannot send runs or tokens elsewhere. Suspend the account.
- **Everything is audited:** each token given, each test request, each change
  to an account or its keys.
- **The API's other routes** (`/v1/api/runs`, `…/batches`, `…/queue`) answer an
  account's own runs; a read-only API key keeps its company's or provider's.

## 10. Checking a set-up with the example client

The repository holds a working client, **`OSCAR_API_TestTool/`**
(`oscar-test`). It does what a CI pipeline does: it signs in, asks for tests,
waits for the verdict, prints where each run failed and writes JUnit XML.

- **Before handing the account to the company's CI,** a Test Manager runs it
  from their own PC to check the set-up of § 1, step by step.
- **For integrators,** it is an example: `src/oscar.js` signs in, `src/run.js`
  asks, waits and reports.

It needs Node 22 or later and nothing else: copy the folder anywhere. Its
`README.md` lists every option.

### 10.1 Settings

In PowerShell, in the tool's folder. The private key of § 3 stays in its own
folder: give its full path.

```powershell
$env:OSCAR_URL = "https://<oscar host>"; $env:OSCAR_CLIENT_ID = "<the account's client id>"; $env:OSCAR_PRIVATE_KEY_FILE = "<the key's folder>\oscar-ci.key"
```

`OSCAR_URL` is **exactly** the address on the account's card (the token
endpoint without `/v1/api/oauth/token`). It is the server's `APP_URL`, and the
signed assertion names it: another name for the same server is refused.

### 10.2 The checks, in order

Each step checks what the step before could not. Stop at the first that
fails, fix what its message points to, and run it again.

**Step 1: signing in.**

```powershell
node oscar-test.js --whoami
```

It answers with the account's name, its company and every provider it may
test, with their ids. That proves:
- the server knows the API (1.11.561 or later) and has `APP_URL`;
- the address is the right one;
- the key OSCAR holds matches yours;
- the account is active.

| Refused with | Check |
|---|---|
| `OSCAR could not be reached` | `OSCAR_URL`, the network, a proxy |
| `OSCAR answered with a redirect` | `OSCAR_URL` uses `https://` and the exact host |
| `OSCAR refused the token request (HTTP 404)` | the server is older than 1.11.561 |
| `(HTTP 503). temporarily_unavailable` | the server's `APP_URL` is not set |
| `(HTTP 401). invalid_client` | the client id; the public key pasted on the card matches your private key and is not revoked; the account is not suspended; `OSCAR_URL` is the card's address; your PC's clock is right (the assertion lives one minute) |
| `The private key must be EC P-256 or RSA of 2048 bits or more` | make the key as § 3 does |

**Step 2: the providers.** The list of step 1 must hold every provider the
automation will test. If one is missing, tick it on the account's row (§ 1,
step 1).

**Step 3: the suites** (only if you use them):

```powershell
node oscar-test.js --suites
```

Each named suite with what it holds. An empty list: save one on the Run page
(§ 1, step 4).

**Step 4: a real run, on each provider.** One scenario you know passes, with a
short wait:

```powershell
node oscar-test.js --provider alpha --scenarios <a scenario code> --timeout 15 --junit result.xml
```

The scenario code is one the provider holds (Test Config). This step proves:
- the account's OSDM credentials for that provider;
- the provider's endpoint and data file;
- the runner;
- the verdict and the JUnit report.

| Answer | Check |
|---|---|
| `HTTP 409 — <provider>: Cannot start run — missing: Bearer token (your credentials)` (or OAuth2 fields) | the account's OSDM credentials for that provider: *Set its OSDM credentials* on its row, then *Test the account's credentials* |
| `HTTP 409 — <provider>: … endpoint is suspended` | a Test Manager resumes it on API Config, once the provider is checked |
| `HTTP 409 — … missing: OSDM API endpoint` or `data file` | the provider's set-up in API Config and Test Config |
| `"x" is not a company or provider this account may test` | step 2 |
| `not on this provider: <code>` and nothing runs | a code the provider does not hold, or a tester's own scenario (the account runs the shared ones only) |
| exit code 3, `Not finished after 15 minute(s)` | the queue is busy or a run hangs: `--status <id>` waits again; the Dashboard shows the runs |
| exit code 2, a run `not_a_result` | the run ended without a result (its `reason`): open its `run_url` in OSCAR, as for any run |
| exit code 1, a run `failed` | the set-up works: the provider failed a check. The failed check is printed, and `run_url` opens the run |
| exit code 0 | the set-up works and the provider passed |

Then `result.xml` holds the JUnit report your CI will publish.

**Step 5: the same, as the CI will run it.** Put the three settings in the
CI's secret variables. `OSCAR_PRIVATE_KEY` may hold the PEM text itself, with
line breaks written `\n`. Give each pipeline run a reference and an
Idempotency-Key, so a retried job runs nothing twice:

```powershell
node oscar-test.js --provider alpha --provider beta --suite smoke --reference "pipeline 4812" --idempotency-key "ci-4812-1" --junit oscar-junit.xml
```

The exit code tells the CI the verdict: 0 passed, 1 failed, 2 incomplete,
3 not finished in time, 4 an error.

### 10.3 What the client never does

It reads results only (§ 7) and never prints the private key, the assertion or
the token. `--whoami`, `--suites` and `--status` ask a token holding
`runs:read` only, and so does the MCP server (§ 8). The tool's own tests run
it against a stand-in OSCAR that checks each signed assertion as OSCAR does.

## 11. Problems met while setting it up

These all happened during the first real set-up, on the simulators (November
2026). Each has its symptom, its cause and what to do.

### 11.1 Signing in

| Symptom | Cause | What to do |
|---|---|---|
| `(HTTP 401). invalid_client` with the account's name as client id | The client id is not the account's name | Use the UUID shown under the account in *Signing in to the API*, after `client_id` |
| `invalid_client` although everything looks right | `OSCAR_URL` is another name of the server, or has a path | Use the card's token endpoint without `/v1/api/oauth/token`, nothing more (§ 10.1) |
| `openssl` is not recognised (Windows) | Windows has no OpenSSL by default | Make the pair with Node (§ 3) |
| `Get-Content … oscar-ci.pub` finds no file | The key was made in another folder than the one given | Look in the folder where the command ran; give the full path, in quotes when it holds a space |
| `--whoami` says `scopes runs:read` | Normal: reading commands ask a read-only token | A launch asks `runs:write` too |

Keep the private key out of any repository and of any synchronised drive
(OneDrive, Dropbox…): whatever is there can be copied elsewhere. Paste only
the `.pub` text into OSCAR.

### 11.2 The account's providers and OSDM credentials

| Symptom | Cause | What to do |
|---|---|---|
| `"X" is not a company or provider this account may test` | The provider is not ticked for the account | Tick it in the account's row on **API Accounts**, then `--whoami` again |
| `HTTP 409 — X: Cannot start run — missing: …` | The account has no OSDM credentials for that provider | **API Config** opened from the account's row (*Set its OSDM credentials*): the page then says *The account's credentials*. Your own are not changed |
| Runs fail with 401 after some minutes | The account's credentials are a pre-obtained bearer token, which expires | Choose OAuth2 (client id and secret, token URL): OSCAR then gets a token at each run |

The account's credentials may be the same OSDM client as yours. Two users of one
client see each other's bookings on the provider: harmless for tests, but a
client of its own keeps the account's runs apart.

### 11.3 Which scenarios run

**The account runs shared scenarios only.** It is not you: a scenario you
create, duplicate or copy is yours and **private** until you share it (the
*Private* button of its row in Test Config turns it to *Shared*). A private
scenario is not seen by the account, even yours as a Test Manager.

| Symptom | Cause | What to do |
|---|---|---|
| `HTTP 400 — Nothing would run: no scenario asked is a shared scenario of a provider named (X: CODE)` | The code is private, or is not in that provider's data file | Share it, or copy it into that provider (Test Config → *Copy scenarios from…*), then share the copy |
| `not on this provider: CODE` for one provider, the others run | That provider has no shared scenario of that code | Not an error: each provider runs the codes it has |
| A simulator code runs on one simulator only | The simulators' codes end in their OSDM version (`_36` ALPHA, `_37` BETA, `_38` GAMMA, `_39` DELTA, `_310` EPSILON, `_312` ZETA) | Give each provider's code, or copy one scenario (or a catalogue `OTST_…` one) into each provider, shared, so one code runs everywhere |
| A suite on *My run list* ran every scenario | A suite saved before 1.11.563 lost that choice (#1353) | Delete it and save it again on *My run list*: it then runs each provider's own run list |
| The Run page and the API count differently | The Run page counts for what **Working on** selects; the API counts each provider's data file, shared scenarios only | Select the provider in **Working on** to compare |

A selection file (`--selection`) holds the Run page's filters as JSON (§ 5).
JSON typed on the command line does not survive Windows PowerShell 5.1, which
drops the inner quotes: write it to a file. The example client reads the file
whatever encoding PowerShell gave it, and also takes the filters as options,
with no file: `--categories happy --groups Refund --run-list` (its `--help`
lists every value). In JSON, the values are spelled as OSCAR spells them:
`"Refund"`, not `"refund"`.

### 11.4 Waiting for the verdict

| Symptom | Cause | What to do |
|---|---|---|
| `HTTP 504` (or 502) while waiting | A proxy in front of OSCAR cut a call held open a minute: nginx's read timeout is 60 s by default | Ask OSCAR's administrator to set `proxy_read_timeout 660s` in the `location /` block, as `OSCAR_Deploy/nginx/oscar.conf.example` does. The example client waits 50 s at a time and, if a proxy cuts it, asks again half as long |
| The client stops before the verdict (exit 3, or a closed window) | `--timeout` reached, or the PC asleep | Nothing is lost: the runs go on in OSCAR. `--status <id>` waits again; a finished request answers at once |
| A run lasts more than the token's 15 minutes | Normal | A client signs a new assertion before its token ends (the example client does it by itself, § 7) |

### 11.5 Reading the results

- The console of the example client prints the verdict and each failed check.
  The warnings are in `--json` and in the JUnit file's `<system-out>`.
- **JUnit** is for the CI's test report; **JSON** for reading or for your own
  scripts (each check with its fields). Both hold the same results.
- A failed check is listed once, among the failures. The run's log also echoes
  it as a warning (`[WARNING] ❌ …`); since 1.11.564 the API leaves that echo out
  of `warnings`.
