# OSCAR test automation API: an example Bruno collection

The same steps as the Node client one folder up, as a Bruno collection, for a
test automation that runs Bruno rather than Node in its own code (#1455). It
asks OSCAR for tests as a **Company API account**, waits for the verdict and
reads the results. *OSCAR - Test Automation API Guide* describes the API.

| Request | What it does |
|---|---|
| `1 Get a token` | Signs the client assertion with the account's private key (ES256 or PS256, one minute) and gets a 15-minute token |
| `2 Find the provider` | `GET /v1/api/key`: the account, its company and the providers it may test; keeps the id of `provider` |
| `3 Ask for tests` | `POST /v1/api/test-requests` with the suite or the scenario codes, and an `Idempotency-Key` |
| `4 Wait for the verdict` | `GET …/{id}?wait=50`, asked again until every run is finished |
| `5 Read the results` | The verdict, then each run not passed and its failed checks; the test fails unless the verdict is `passed` |
| `6 JUnit report` | The same results as JUnit XML |

What the scripts do is in `lib/oscarApi.js` (Node's own `crypto` and `fs`
only), tested by `../tests/bruno-example.test.js`. A token is asked again
before it ends, so a long campaign needs nothing more.

## Before you start

1. A Test Manager has made the account on OSCAR (*API Accounts*): its
   providers ticked, its OSDM credentials set, your public key added. Note its
   **client id** (a UUID, under *Signing in to the API*). The guide's § 1 and
   § 3 explain each step, and § 11 the usual problems.
2. The scenarios you ask for are **shared** in the provider's Test Config: the
   account runs shared scenarios only.

## Open it in Bruno

1. *Open Collection* → this `bruno` folder.
2. Turn the collection's JavaScript sandbox to **Developer Mode**: the scripts
   use Node's `crypto` (to sign) and `fs` (to read the key file).
3. Choose the environment **OSCAR** and fill it in:

| Variable | Value |
|---|---|
| `oscar_url` | OSCAR's address, as on the account's card without `/v1/api/oauth/token` (`https://oscar.uic.org`) |
| `client_id` (secret) | the account's client id |
| `private_key_file` | the full path of the private key's PEM file, kept outside any repository and synchronised drive |
| `private_key` (secret) | or, instead of the file, the PEM text itself (line breaks may be written `\n`) |
| `provider` | the provider's name as OSCAR shows it (`GAMMA`), or its id |
| `scenarios` | scenario codes, separated by commas |
| `suite` | or a named suite of your company: it is used instead of `scenarios` |
| `reference` | your own id for this campaign, given back as it is |
| `wait_minutes` | how long to wait for the verdict (60) |

4. Run the **whole collection** (*Run* in Bruno's runner): request 4 asks
   again by itself until the runs are finished. A request sent alone does not
   loop.

The token and the ids are runtime variables: Bruno never writes them to the
environment file. Secret variables (`client_id`, `private_key`) stay in
Bruno's own store on your machine, not in the file either.

## From a command line or a CI

With the Bruno CLI, in this folder. Secrets come from the CI's own secret
variables:

```bash
bru run --sandbox=developer --env OSCAR \
  --env-var "client_id=$OSCAR_CLIENT_ID" \
  --env-var "private_key=$OSCAR_PRIVATE_KEY" \
  --env-var provider=GAMMA --env-var scenarios=SIM_SALE_SEARCH_1ADT_38 \
  --reporter-junit bruno-results.xml
```

The exit code is 0 when every request's tests passed, so a failed verdict
makes the CI step fail. The collection was run this way with the Bruno CLI
OSCAR pins (4.3.0), against a local OSCAR.

## When it stops

| The run says | Look at |
|---|---|
| `No private key: set private_key_file …` | `private_key_file` or `private_key` in the environment |
| `Cannot find module 'crypto'` or `'fs'` | The collection is in Safe Mode: switch it to Developer Mode |
| `OSCAR refused the token request (HTTP 401). invalid_client` | The client id, the public key on the account's card, `oscar_url`, your machine's clock (guide § 11.1) |
| `"X" is not a company or provider this account may test` | Tick the provider for the account on *API Accounts* |
| `3 Ask for tests` refused with 409 | The account's OSDM credentials for that provider (guide § 11.2) |
| `3 Ask for tests` refused with 400 `Nothing would run` | A code that is private or not that provider's own (guide § 11.3) |
| `4 Wait for the verdict` answered 502 or 504 | A proxy in front of OSCAR cut the wait; the request asks again by itself (guide § 11.4) |
