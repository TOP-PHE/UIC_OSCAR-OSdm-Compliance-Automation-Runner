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

---

## 1. For the Test Manager: set up an account

1. **Make the account.** Menu **API Accounts** → *Make an account*. Give it a
   name (the tool that uses it: "Nightly CI") and tick the providers it may
   test besides your company. You can change the providers later, and taking
   one away stops the account there at once.
2. **Give it OSDM credentials.** In the account's row, *Set its OSDM
   credentials* opens **API Config** for the account. Fill one section per
   company or provider it tests, as you would your own credentials, and use
   *Test the account's credentials*. Its runs use these, never yours.
3. **Give it a public key.** In the card *Signing in to the API*, paste the
   public key your company made (§ 3). Note the account's **client id** and the
   **token endpoint** shown there: your automation needs both.
4. **Optionally, name suites.** On the **Run** page, choose a selection and
   *Save the selection above as a suite* (card *Named suites*). The automation
   then asks it by name.

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

Keep `oscar-ci.key` where your CI keeps its secrets. Give OSCAR
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
  Run page's: `categories`, `groups`, `forms`, `modes`, `lastRun`), or `suite`
  (a name; `GET /v1/api/suites` lists them).
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
until `state` is `finished`.

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
until [ "$(curl -sf "$OSCAR/v1/api/test-requests/$REQ?wait=60" -H "Authorization: Bearer $TOKEN" | jq -r .state)" = finished ]; do :; done
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
