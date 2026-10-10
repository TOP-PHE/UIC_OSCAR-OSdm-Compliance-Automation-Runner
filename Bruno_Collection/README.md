# OSDM conformance test collection (Bruno)

The Bruno requests and the shared validators that OSCAR runs against an OSDM
provider. OSCAR is one way to run them; the other is Bruno on your own PC,
straight from this folder. Every scenario must pass both ways.

| Path | Role |
|---|---|
| `00-Access Token/` | one token request per provider; only the one that matches the environment runs |
| `01-System Infos Requests/` … `04-Exchange/` | the OSDM requests, in the order a scenario calls them |
| `environments/` | one environment per provider (`OTST_<Provider>_Env.yml`) |
| `data_base/` | the data files: the scenarios and their test data ([README](data_base/README.md)) |
| `json_validator/` | the data file schema |
| `library-bruno/` | the validators, run inside Bruno |

## Run standalone

What follows uses the OSDM simulator's `gamma` provider, which needs no
account anywhere. For a real provider, take its environment and data file
instead and enter the credentials it gave you.

### 1. What you need

- Bruno: the desktop app, or the command line, `npm install -g @usebruno/cli`
  at the version OSCAR runs, the one in `Oscar_Server/bruno-cli/package.json`
  (4.2.1 when this was written).
- Python 3 or any other static file server: the collection reads its data file
  and schema over HTTP.
- The simulator, either the one installed for your team
  (`https://<simulator-host>/gamma`) or one on your PC:

  ```bash
  cd OSDM_Simulator
  node scripts/make-clients.js     # writes clients.json, with the client ids and secrets
  node server.js                   # http://127.0.0.1:3002
  ```

  A client of `gamma` is an entry of `gamma` in `clients.json`, for example
  `gamma.tst01`, with its secret.

### 2. Serve the data file

From the root of the repository, the folder that holds `Bruno_Collection/`:

```bash
python3 -m http.server 8080 --bind 127.0.0.1
```

The environment reads
`http://localhost:8080/Bruno_Collection/data_base/simulator_datafile.json`
and the schema next to it. Leave this running.

### 3. The environment

`environments/OTST_Simulator_Env.yml`:

| Variable | Value |
|---|---|
| `api_base` | `http://127.0.0.1:3002/gamma` as committed; `https://<simulator-host>/gamma` for the installed one |
| `client_id`, `client_secret` | a client of `gamma`. Secret variables: they have no value in the file and Bruno keeps what you enter on your PC only. Never commit one. |
| `data_base`, `json_schema` | the data file and the schema, served in step 2 |

The token request, `00-Access Token/Simulator Access Token`, posts the client
to `{{api_base}}/oauth/token`.

### 4a. Bruno desktop

1. *Open Collection* → this folder. Select the environment
   **OTST_Simulator_Env**, and enter `client_id` and `client_secret` in it.
2. Run **00-Access Token → Simulator Access Token** on its own first. The
   token it stores lasts an hour on `gamma`; send it again after that.
3. Run the collection. Every scenario of the data file's `scenariosToRun`
   runs, one after the other, and each one writes an HTML report to
   `Validation_Reports/` (git-ignored).

For one scenario only, set the environment variable `scenario_override` to its
code and run the collection again; this is what OSCAR does for each run. Empty
it to go back to the list. (`scenarioTarget` is for sending one request at a
time: in a collection run it repeats the same scenario without end.)

### 4b. Command line

From this folder, with the client in two shell variables:

```bash
export SIM_CLIENT_ID=gamma.tst01
export SIM_CLIENT_SECRET=...        # from clients.json

# The whole list (scenariosToRun)
bru run "00-Access Token" "01-System Infos Requests" "02-Common Requests" "03-Refund" "04-Exchange" \
  --sandbox=developer --env OTST_Simulator_Env \
  --env-var "client_id=$SIM_CLIENT_ID" --env-var "client_secret=$SIM_CLIENT_SECRET"

# One scenario: the same command, plus
  --env-var scenario_override=SIM_SALE_SEARCH_2ADT_SAVER_38
```

Name the folders: `bru run` on the whole collection leaves out
`00-Access Token`, and every request then gets 401. Add
`--env-var api_base=https://<simulator-host>/gamma` for the installed
simulator, and `--reporter-json <file>` for Bruno's own results.

**`bru run` writes the run's variables back into the environment file**
(about 800 lines: the data file, the booking, the passengers; never the
secret variables nor the token). Do not commit that; put the file back with
`git checkout -- environments/OTST_Simulator_Env.yml` after a run.

### 5. What to expect

The scenarios exist once per OSDM version: `_36` for `alpha`, `_37` for
`beta`, `_38` for `gamma`, the file's run list. On another provider, set
`api_base` to it and name its scenario with `scenario_override`. Besides the two
sales there are return journeys (#594): `SIM_RETURN_SEPARATE_1ADT` on every
version, and `SIM_RETURN_COMBINED_1ADT` (one offer for both directions) from
3.7, so not on `alpha`. Refunds of a return (#595), on every version:
`SIM_REFUND_RETURN_1ADT` (full refund, every refund offer confirmed) and
`SIM_REFUND_INBOUND_1ADT` (the inbound ticket only). Technical cancellations
(#596), on `gamma` only: `SIM_REFUND_OVERRULE_<code>_38` for each overrule code
it accepts (`CONNECTION_BROKEN`, `PAYMENT_FAILURE`, `SALES_STAFF_ERROR`,
`TECHNICAL_FAILURE`), and `SIM_REFUND_OVERRULE_REFUSED_38`, which sends
`STRIKE` and expects the refusal.

`SIM_SALE_SEARCH_1ADT_38` and `SIM_SALE_SEARCH_2ADT_SAVER_38` pass with no failed
check: the version check and the sale steps answer 200, and the nine optional
information requests answer 501, reported as "not implemented by this
provider". The same holds for the `_36` pair on `alpha` and the `_37` pair on
`beta`, and for the return scenarios, which also check the inbound answer and
expect one ticket per direction. A scenario run on a provider of another
version gets a warning from the version check.

Through OSCAR, the same data file gives the same checks: OSCAR obtains the
token itself, so its run has two checks fewer, those of the token request.
Pointing a company at the simulator: `Documentation/Server_Operations/OSCAR -
OSDM Simulator.md`, section 5.

## One data file for both

`data_base/simulator_datafile.json` is the only copy. It is the data file of
the standalone run above, and the file a Test Manager uploads in OSCAR.
`OSDM_Simulator/tests/datafile.test.js` keeps it valid against the schema and
answerable by every simulated provider.
