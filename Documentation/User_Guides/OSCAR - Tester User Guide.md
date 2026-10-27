# OSCAR — Tester User Guide

*How to point OSCAR at an OSDM provider and build, run, and read a conformance test.*

> Reflects collection **OTST_V2.0.204** / server **1.11.371** / release **2026.406**.
> Labels in **bold** match the on‑screen controls. When the UI and this guide
> disagree, the UI wins — please open an issue so we can update the guide.

---

## Table of contents

1. [Concepts & roles](#1-concepts--roles)
2. [One‑time setup](#2-one-time-setup)
   - 2.1 Several providers in one company (distributors)
   - 2.2 Downloading and uploading the data file
   - 2.3 API keys (Test Managers)
   - 2.4 AI analysis of results (Test Managers)
3. [Provider setup — Framework, Test data & Discovery](#3-provider-setup--framework-test-data--discovery)
   - [3.0 Setting up a provider from its checklist and the scenario catalogue](#30-setting-up-a-provider-from-its-checklist-and-the-scenario-catalogue) (start here)
   - 3.1 Test Framework (capabilities) · 3.2 Train sets · 3.3 Journeys · 3.4 Timetable Discovery
4. [Authoring a scenario](#4-authoring-a-scenario)
5. [Running tests](#5-running-tests)
6. [Reading the report](#6-reading-the-report)
   - Assertions · HTTP Traffic · Test Framework coverage (by capability, points to look at, exports) · Published coverage reports (Test Managers and certifiers)
7. [Reference tables](#7-reference-tables)
8. [Troubleshooting](#8-troubleshooting)
9. [Testing OSCAR with the OSDM simulator](#9-testing-oscar-with-the-osdm-simulator)

---

## 1. Concepts & roles

**What OSCAR does.** OSCAR drives a provider's OSDM API through realistic
sale / refund / exchange flows and checks each response against the OSDM spec.
A run produces a **report**: a tree of pass/fail **assertions** plus the full
**HTTP traffic** (every request and response).

**The hierarchy.** Everything hangs off four nested things — learn these names,
the rest of the guide uses them:

```
Company  ──►  Test Framework  ──►  Scenario(s)  ──►  Run  ──►  Report
(the           (what the           (one concrete    (one        (assertions
 provider +     vendor CAN do —     test: an O&D,    execution)   + HTTP
 api_base)      the "menu")         a date, options)              traffic)
```

- **Company** — the provider under test. Holds the `api_base` (the OSDM API
  root URL) and the per‑company **concurrency limit**.
- **Test Framework** — declares the vendor's **capabilities** (ticket types,
  seat‑map support, ancillaries, offer criteria…). It is the *menu*: it
  **gates** what a scenario is allowed to switch on.
- **Scenario** — one concrete test you author from that menu.
- **Run** — one execution of one or more scenarios.
- **Report** — the result.

**Roles** (set by an administrator; they decide what you can see and do):

| Role | What it is | Sees |
|---|---|---|
| `company_user` *(tester)* | Day‑to‑day tester for one company. Keeps **their own** OSDM credentials. | Their own runs in their company. |
| `test_manager` | Company lead. | **All** of the company's runs/reports; can **share** a report with the certifier. |
| `certification_user` *(certifier)* | UIC‑side reviewer, no company of their own. | Only the reports a `test_manager` has **explicitly shared**. |
| `administrator` | Platform operations & security. | Manages users/companies/config. **Does not read test data** (privacy‑strict, issue #60). |

If you are a tester, you live mostly in sections **3–6** below.

**New provider? Start with §3.0.** The provider fills in a checklist, OSCAR
turns it into the Test Framework and the Test Data, and the scenario
catalogue supplies ready-made scenarios. Most of a first configuration is
done that way, before any scenario is written by hand.

---

## 2. One‑time setup

Do these once before your first run.

1. **Sign in** to the OSCAR web app with the account your administrator created.
2. **Set your OSDM credentials** (Profile / API config). Credentials are
   **per‑user**: each tester authenticates to the company's OSDM API with their
   own client id / secret (or token). OSCAR requests the access token for you at
   run time when the sandbox needs one — you don't paste a token by hand.
3. **Confirm the company `api_base`** points at the right sandbox (e.g.
   `https://osdm-5.platform.bileto.zone/api`). It is shown on the API config
   page as **OSDM API Endpoint**. This is company‑level config, shared by every
   tester of the company: only a **Test Manager** can change it. As a tester
   you see it read‑only, and saving the page saves your own credentials only.
   If the address is wrong, ask your Test Manager to correct it.
   **🔌 Test my credentials for <name>** (next to the Save button, #872)
   checks what is saved, before any run: OSCAR gets a token the way a run
   does, then asks the provider's `GET /versions` with it. The result shows
   under the button: whether a token was obtained (and how long it lives), or
   why not (a missing field, the token endpoint's HTTP status); whether the
   provider accepted the token, refused it (401/403) or does not offer
   `/versions` (404/405/501, the token was not refused); and the OSDM versions
   it lists next to your Test Framework's. Unsaved changes are saved first, if
   you agree. The token itself is never shown. Ten tests a minute.
4. **Pick the environment / sandbox** for the run (e.g. Bileto, Sqills,
   Benerail, …). The collection auto‑selects the matching access‑token request
   for that sandbox.

> **Credentials never leave the server in the clear.** OSDM credentials and the
> framework/data are encrypted at rest; auth request/response bodies are redacted
> in every report.

### 2.1 Several providers in one company (distributors)

A distributor often tests more than one OSDM system: each carrier it sells is a
**provider**. In OSCAR a provider has its own endpoint, data file, Test
Framework, test resources, findings, runs and reports.

- **Choosing what you work on.** When your company has providers you may use, the
  menu bar shows a **Working on** selector instead of the company name. Pick your
  own company or a provider: Test Config, New Run, the Dashboard and the reports
  of that browser tab then work on it. Another tab can work on another provider
  at the same time.
- **API Config shows them all.** The page has one section for your company and
  one for each provider you may use, and a table at the top that says, for
  each, whether the endpoint, your credentials and the test data are set. Open
  a section, enter the credentials that provider gave you, and save it with
  its own button (*Save configuration for <provider>*). Each section is saved
  on its own: saving one never changes another, and credentials entered for a
  provider are used only for runs on that provider. A section with text you
  have not saved is marked *not saved*. **Working on** only decides which
  section is opened first.
- **Who sees which provider.** Test Managers see every provider of the company.
  A tester sees the providers a Test Manager has granted. If access is withdrawn
  while you work on a provider, OSCAR tells you and switches the tab back to
  your own company.
- **Test Managers: the Providers page** (menu **Providers**) adds and renames
  providers, sets each provider's OSDM endpoint, and grants or withdraws testers.
  An endpoint already used by another company or provider of yours asks for
  confirmation before it is saved.
- **Copying scenarios between providers.** On Test Config, **📋 Copy scenarios
  from…** (shown when you may work on more than one company or provider) copies
  scenarios from another of them into the one this tab works on:
  1. choose the source and tick the scenarios (a tester sees the shared ones and
     their own);
  2. for each trip they use, choose a train (and its service) or a journey of
     this provider's Test Data. A trip is asked once, however many scenarios
     share it; a trip with several legs needs a journey;
  3. warnings are shown before you copy: features the provider's Test Framework
     does not declare, fulfillment options it does not offer (they are reduced
     to what it declares), and the OSDM version, which becomes the framework's.

  The copies are yours (not shared) and get a new code when the code is
  already used. The endpoint, credentials, known deviations and findings are
  never copied. Save or discard unsaved changes first: the page reloads after
  the copy. The provider needs a Test Framework and Test Data before you copy.
- **The scenario catalogue** (#612). **📋 Copy scenarios from…** always offers
  **📚 Scenario catalogue**: ready-made reference scenarios, happy flows
  (`OTST_…`) and negative probes (`NHF_…`, 🚫), each with one line saying what
  it tests. Each has been run end to end on the OSDM simulator. A reference
  scenario that needs something your Test Framework does not declare (a sales
  flow, a return model, OSDM 3.7, a passenger type) is greyed out and names
  what is missing: declare it, or leave the scenario. The copy works as above:
  you choose a train for each trip, and the copies are yours. A negative probe
  that waits for a deadline (`NHF_EXPIRED_…`) waits at most 40 minutes; raise
  its *Max wait* if your provider's deadline is longer. How the catalogue fits
  with the provider's checklist, step by step, is in §3.0.
- **"The data file has changed since this page loaded it."** Test Config
  refuses a save when the data file changed after you opened the page: in
  another tab, by your Test Manager, or by a copy. Nothing is saved. Your edits
  are still on the page: use **⬇ Download unsaved edits** to keep a copy,
  reload, and make your change again. A colleague saving their own private scenarios does not
  cause this; a change to anything you can see does.

### 2.2 Downloading and uploading the data file

Since 1.11.221 (#549), the buttons at the top of Test Config work as an export
and an import of the same file:

- **⬇ Download JSON** saves the data file **as the server stores it**, named
  after the company and the day (`<company>-datafile-<date>.json`). For a Test
  Manager it is the stored file byte for byte: uploading it again changes
  nothing. Edits you have not saved are not in it.
- For a **tester**, the download is your **personal view**
  (`…-datafile-personal-view-<date>.json`): your scenarios, the shared ones and
  your own run list, without other testers' private scenarios. It is marked as
  such, and the upload refuses it: it cannot replace the company's file.
- **⬇ Download unsaved edits** appears while the page has edits that are not
  saved. It saves the page's working copy, to keep your work when a save is
  refused. It is marked too, and cannot be uploaded as the data file.
- **📤 Upload datafile** (Test Managers) replaces the data file **and nothing
  else**: the Test Framework and Test Data are not touched. The page first asks
  for confirmation, with the number of scenarios now and after. The server then
  checks the file against the data file schema, the same check every run makes,
  and refuses it with the list of problems if it does not pass; nothing is
  replaced. A file that is not `.json` is refused with "Only JSON files are
  accepted."
- If the company has **no Test Framework**, or **no train in Test Data**, the
  page then offers to create them from the uploaded file (OSDM version, sales
  flows and passenger types; one train per trip). Cancel creates nothing. A
  company that has them is never asked.
- The file an upload replaces is **kept**. **↩ Restore previous file** (Test
  Managers) puts it back; the file it replaces becomes the previous one, so a
  restore can be undone the same way. Only one previous file is kept, and only
  an upload or a restore makes one: **Save & Apply** does not. **🗑 Delete data
  file** removes both.

---

### 2.3 API keys (Test Managers)

Since 1.11.337 (#503), a program can read run results with an API key: a
dashboard, a script, a CI job. The **API Keys** page (menu **API Keys**, Test
Managers only) makes, lists and revokes them, for the company or provider
chosen in **Working on**.

- **Making a key**: give it a name and a lifetime (30, 90 or 180 days, or 1
  year). The key is shown **once**, in a yellow box: copy it then. OSCAR keeps
  only a fingerprint of it; nobody can show it again. A lost key is revoked and
  replaced.
- **What it can do**: read only, the runs of that one company or provider
  (not of its providers), on the routes under `/v1/api` only. Every other OSCAR
  route refuses it.
- **How to send it**: in the header `Authorization: Bearer <key>`. A key in a
  cookie or in the address is not read.
- **When it stops**: when it expires, when a Test Manager revokes it (at once),
  or when the Test Manager who made it is no longer a Test Manager of the
  company.
- **What it reads** (since 1.11.338), all `GET`, described in the API
  documentation (`/v1/docs`, tag *API*):

  | Route | Answer |
  |---|---|
  | `/v1/api/key` | the key itself: name, company, scopes, expiry |
  | `/v1/api/runs` | the runs, newest first; `limit` (1–200), `offset`, `status`, `batch_id`, `scenario_code` |
  | `/v1/api/runs/{id}` | one run: status, times, scenario, batch, check counts |
  | `/v1/api/runs/{id}/assertions` | its checks, by step; `result=failed` or `passed` |
  | `/v1/api/batches/{batchId}` | the runs of one batch, with counts by status |
  | `/v1/api/queue` | the runs waiting or running, in order |

  A key does not read request or response bodies, logs, report files, the
  provider's endpoint or who started a run. A deleted run, or one of another
  company or provider, answers 404 like a run that does not exist.

  ```bash
  curl -H "Authorization: Bearer $OSCAR_KEY" https://<oscar>/v1/api/runs?status=FAILED
  ```
- **With an AI assistant**: `OSCAR_MCP/` in the repository is an MCP server
  that gives an assistant (Claude Desktop, Claude Code…) these same reads as
  tools, with one key and no more rights than it. Make a key for it, then
  follow [OSCAR_MCP/README.md](../../OSCAR_MCP/README.md). Revoking the key
  stops it.

### 2.4 AI analysis of results (Test Managers)

An AI service your company chooses reads the failed checks of a batch, groups
them by probable cause and says who should act: the provider, OSCAR or the
configuration. The menu **AI Analysis** has three tabs (since 1.11.340).

1. **Connection**, done once:
   - **Ask for access** for the company and each provider. An OSCAR
     administrator approves each one on its own.
   - **Choose how the AI service is used**:
     - **one AI service for all** (recommended): one service, one key and one
       monthly limit for the company and every approved provider;
     - **one per provider**: for a provider whose agreement names another AI.
     Changing the choice deletes no service.
   - **Set up the service**: kind, address, model, key, monthly limit and your
     own instruction. It is tested before it is saved.
2. **Usage status**:
   - per company or provider: its access, the AI service and model it uses,
     the number of analyses and their cost, then the totals;
   - below it, what was spent per month and per model.
   The costs are list prices, an estimate: the AI service's invoice is what
   counts.
3. **Analysis**, step by step; each step appears once the one before is
   chosen:
   1. the company or provider to validate;
   2. the test results (a batch), and optionally a later batch to compare;
   3. the provider's set-up checklist: keep the stored one, or import a new
      one, which replaces it (without one stored: import one, or go on
      without);
   4. the language and model, then **See what will be sent**. Nothing leaves
      OSCAR before you have seen it and pressed the send button.

   The earlier analyses of that company or provider are listed below. Tick
   two to show them side by side. An analysis is an AI opinion, not a test
   result.

**What is sent, and what is not.** The preview shows the instructions and the
input exactly as they will leave OSCAR; nothing else is sent.

- Sent:
  - the failed checks, grouped by step, check text, HTTP status and OSDM
    problem code;
  - apart from them, the warnings the runs logged, grouped the same way
    (since 1.11.341). A warning is not a failure, and the AI is told so;
  - each scenario concerned: its description, its OSDM version, what the
    Test Framework does not declare of it, and what the reference scenario
    it was copied from tests;
  - the Test Framework, the findings (title, category, step, scenario), the
    provider's checklist answers and an extract of the OSDM specification;
  - for the 15 most failing groups, one request and answer, masked.
- In every text, the values a run met are replaced: `N` for a number,
  `<id>`, `<instant>`, `"…"` for a quoted value.
- Never sent: a token, a credential, the provider's address, a request's
  headers or URL, a name, birth date, contact, address, card or identity
  document of a passenger or purchaser.

When the input is too large (about 50,000 tokens), the warnings are summarised
by step first, then the failures too; the preview says which.

**Reading the answer.** It names groups of failures by probable cause. Each
says who should act:
- **Provider**: its answer does not follow OSDM, or a function is missing;
- **OSCAR**: its request or its check is wrong. **Copy as an OSCAR issue**
  gives the text of an issue to open;
- **Configuration**: the Test Framework, the Test Data or the scenarios run
  do not fit the provider. A scenario written for another OSDM version than
  the provider declares is one of these;
- **Unclear**.

Check each group against the run before acting on it.

**Make a finding draft** (under each group, since 1.11.344) sends the group
to Test Findings › 🧩 Suggested from runs, where you accept, edit or reject it
like any suggested finding. The draft names the analysis and its model. The
AI's call (provider, OSCAR, configuration, unclear) is shown with it, but the
category stays "Open point" for you to choose. A group gives one draft; the
group then says what became of it.

**⬇ Download the findings with requests and responses** (under the
analysis) saves one Markdown file, `oscar-analysis-<date>-<company>.md`: each
group as the page shows it, then the failing requests of the batch that belong
to it (scenario, step, method and address, the body sent, the HTTP status and
the body received). At most 3 requests a group, the first of each run and
step; the file says how many were left out. Hand it to the provider, or read
it outside OSCAR. The bodies are as stored, **not masked**: they are your
company's test data, passengers' names included. Headers, the provider's host
and credentials are never in the file. A body is cut at 20 KB, the file at
4 MB, and the file says where.

**History and limits.** Every analysis is kept with its model, tokens and
estimated cost. Any Test Manager of the company sees them, even without
access. Two analyses of the same input with different models can be compared
side by side. Your monthly token limit (Connection tab) refuses an analysis
of yours that would go past it; with one AI service for all, it counts your
analyses of the company and of all its providers together.

## 3. Provider setup — Framework, Test data & Discovery

Everything in this section is the **provider setup** a `test_manager` does
**once** (and revises as they learn the vendor): the **capabilities** the vendor
supports, and the **trains/journeys** to test against. Scenarios (§4) are then
authored *on top of* this. Plain testers (`company_user`) consume this setup —
the train/journey/discovery edit controls are hidden from them.

### 3.0 Setting up a provider from its checklist and the scenario catalogue

This is the shortest way from a new provider to a first run. The provider's
answers set up the Test Framework and the Test Data, and the scenario
catalogue supplies scenarios that have already been run end to end. You then
complete what only you can know, and run. The steps below are for a
**Test Manager**. A tester can follow step 6 onwards on the scenarios their
Test Manager shares with them.

```
 Blank checklist ──► provider fills it in ──► 📋 Provider checklist (import, preview, apply)
                                                 │  Test Framework  (Part A)
                                                 │  Test Data       (Parts B and C)
                                                 └► reference scenarios copied from 📚 the catalogue
                                                        │
                       complete what is "to complete" ◄─┘
                                  │
                       tick them in your run list ──► run ──► read, then refine
```

#### Step 1. Send the blank checklist to the provider

The blank checklist is
[`OSCAR_Checklist_TEMPLATE_V01.07.docx`](OSCAR_Checklist_TEMPLATE_V01.07.docx),
next to this guide. Its version is in its name (`Vxx.yy`); the folder keeps
the two versions before it too, for a provider who already has one. It asks
the provider, in business terms, what their system does:
- **Part A** is for every provider: access, OSDM version, how the provider
  distributes (A1.3: product-based, fare-based or both), load, passenger
  types and ages, reduction cards, how offers can be requested, known limits.
- **Chapter P** is for a product-based provider: offers, products,
  currencies, booking and fulfilment, sales and after-sales flows, seat
  selection, transport modes.
- **Chapter F** is for a fare-based provider: fare clusters, how fares are
  combined, fare refunds and their fee, the bicycle fare reservation, the
  age under which a fare is free.
- **Part B** has one sheet per service: the route, the trains and their times,
  days, classes, accommodations and reservations, and for fares the stations
  where a section may start or end.
- **Part C** covers the journeys with changes that the provider sells.

The provider answers **in the boxes**: text in the text boxes, ticks in the
check boxes. Ask them not to retype the document or paste it into another
one. Each answer is a tagged field, and OSCAR reads the fields back, not the
page. The annex at the end says where each answer goes in OSCAR.

The API answers (endpoint, token URL, kind of authentication, requestor,
extra headers) are for you to enter in **API Config** (§2). OSCAR never reads
them from the file. The checklist asks the provider not to write passwords or
client secrets in it: they give those to you separately, and each tester
enters their own in OSCAR.

#### Step 2. Import the filled checklist

Choose the provider in **Working on**, then in **Test Config → 📋 Provider
checklist** pick the filled `.docx`.

- **Importing changes nothing.** The box shows what applying the checklist
  would change:
  - the answers that changed since the checklist applied before, question by
    question;
  - each Test Framework setting that would change (now / after);
  - the trains and journeys the Test Data would gain, those already there,
    and, if you choose **replace them**, those removed;
  - the reference scenarios that would be copied (step 3).
- **Apply these changes** asks for a confirmation, then writes exactly what
  was shown. If someone changed the Test Framework or the Test Data in the
  meantime, OSCAR shows the new preview instead and changes nothing.
  **Discard this checklist** sets it aside.
- **What comes from where:**
  - Part A (the `fw.` answers) gives the Test Framework. Settings the
    checklist does not ask, such as random combinations, keep their value.
    Answers OSCAR cannot declare (another ancillary, a ferry) are listed for
    you to handle by hand.
  - Each service sheet of Part B gives a train set per route, with its
    services, days, ticket type, classes and accommodations.
  - Each journey sold in Part C gives a journey on those trains.
  - Times get the UTC offset of the station's country. A station without a
    7-digit UIC code keeps its local time, and the box says so.
- **Every import is kept with its date** (list *Imports kept*): who imported
  it, and whether it was applied or discarded. OSCAR keeps the answers,
  encrypted, never the API and contact answers, and not the file itself.
  The checklist applied is also the one the AI analysis is told about (§2.4).
- The endpoint and the credentials are not changed.

Read the Test Framework once after applying (§3.1). It is the *menu* that
every scenario is checked against, and a wrong tick there decides what is
tested.

#### Step 3. Reference scenarios from the catalogue

The **scenario catalogue** holds generic reference scenarios:
- happy flows (`OTST_…`): sale, return, refund, exchange, seats, cards,
  groups, currencies…;
- negative probes (`NHF_…`, 🚫): a request the provider must refuse, such as
  too many passengers, an expired offer, or a code it does not declare.

Each comes with one line saying what it tests, and has been run end to end on
the OSDM simulator. The documents
[OSCAR - What is tested](../Test_Coverage/OSCAR%20-%20What%20is%20tested.md)
and its reference-scenario tables describe each one.

There are two ways to bring them in:
- **With the checklist** (step 2). Leave **copy them** chosen (the default)
  and applying copies every reference scenario that the new Test Framework
  declares everything for. **do not copy** applies the framework and the Test
  Data only.
- **By hand, at any time.** **Test Config → 📋 Copy scenarios from… → 📚
  Scenario catalogue**. Tick the scenarios, choose a train set (and service)
  or a journey for each trip, and copy. A trip is asked once, however many
  scenarios share it.

What decides which scenarios you get:
- **Your Test Framework** (the golden rule). A reference scenario that needs
  something the framework does not declare is greyed out, with what is
  missing: a sales flow, a return model, an OSDM version, a passenger type,
  a declared limit such as the maximum number of passengers. Declare it if
  the provider supports it, or leave the scenario.
- **Your Test Data.** A trip of several legs needs a journey of as many legs;
  without one the scenario is greyed out ("no journey of N legs"). A scenario
  with no train set at all is not copied.
- **Some entries become several scenarios**, following what you declared:
  - one per offer request form (search, specification, trip ids);
  - one per currency sold;
  - one per search option value listed explicitly;
  - the random combinations of options (drawn from the seed in the
    framework).

  The card and product entries take the first declared reduction card,
  product or group product.

On the copy, OSCAR adapts each scenario to the provider:
- the OSDM version becomes the framework's;
- the tariff flexibility becomes one the provider sells;
- passenger lists are resized to the declared limits, and ages follow the
  declared age bands;
- overrule codes are taken from the declared list (and one it does not
  declare, for the refusal probe).

The copies are **yours**: not shared, and in **no run list**. A scenario whose
code the data file already holds is left as it is, so copying again (or
importing the next checklist) adds only the new ones.

#### Step 4. Complete what is "to complete"

The copy report sorts the scenarios ticked into three groups: **ready to run**,
**to complete first**, and **not allowed by the Test Framework**. A scenario
to complete names what OSCAR could not know from the checklist or the Test
Data. For example:
- a train with a reservation, or a class the train has (Test Data carries no
  reservation or class per service);
- a value only the provider knows: the reference place for a "near this seat"
  test, a named seat, an overrule code;
- a deadline longer than the default wait of a negative probe
  (`NHF_EXPIRED_…` waits at most 40 minutes: raise its *Max wait* if the
  provider's deadline is longer).

Open each one in Test Config and fill it in (§4). Until then, leave it out of
your run list.

#### Step 5. Choose what to run

Tick **✓ In run** on the scenarios to run (§5). Your run list is yours, and
copies are never added to it. If your run list is **ALL**, every copied
scenario runs, including the ones still to complete, and those fail until
they are completed. The copy report warns you when this is the case.

A good first run is a handful of happy flows (a one-way sale, a refund), to
check the endpoint, the credentials and the Test Data. After that, run the
whole list.

#### Step 6. Run, read, refine

Run (§5) and read the report (§6). A failure is not always the provider's:
1. **A setting.** The scenario asks for something the provider does not do,
   because a tick in the framework or a train set is wrong. Correct the
   framework or the Test Data. If the provider gave the wrong answer, correct
   the checklist and import it again.
2. **A known deviation.** Record it in **Test Findings** (and, once agreed,
   as a known deviation, so the run reports it as a warning).
3. **OSCAR.** Report it as an issue. The AI analysis (§2.4) can help sort
   the failures of a batch into these groups.

#### When the provider's answers change

Ask for the checklist again, filled in where it changed, and import it. The
preview shows only what moved: the answers, the framework settings and the
trains. With **copy them**, it also lists the reference scenarios that the new
declarations allow and that you do not have yet. Your own scenarios and your
edits to the copies are never changed.

#### Without a checklist

Everything above can be done by hand:
- the Test Framework (§3.1);
- the train sets, from **🔍 Discover timetable** (§3.4) or typed in (§3.2);
- the journeys (§3.3);
- the reference scenarios, through **📋 Copy scenarios from… → 📚 Scenario
  catalogue** (step 3).

The catalogue then works the same way: it offers what your framework declares.

### 3.1 Test Framework (capabilities)

The framework tells OSCAR **what the vendor can do**. It does **not** run
anything — it defines the menu that scenario authoring is limited to.

| Capability | Field | What it means / gates |
|---|---|---|
| **Distribution** | 🧭 *Distribution* (`distributionModes`) | **Product‑based**, **fare‑based**, or both (issue #936). A framework that names none is product‑based. The scenario catalogue offers only the reference scenarios of the modes ticked, and a scenario of another mode runs with a warning. The last mode cannot be unticked. |
| **Ticket types** | `rail.ticketTypes` | `IRT`, `NRT_OPTIONAL_RESERVATION`, … Declaring a reservation‑bearing type is what makes **place selection** available to scenarios. |
| **Graphical seat map?** | **Seat Selection** → *“Does the system offer a graphical seat map?”* (`placeSelection.seatMap`) | Tick if travellers can pick a specific seat. Off ⇒ scenarios cannot pick seats at all. |
| **Supported seat‑selection modes** | the pills revealed under the box (`placeSelection.supportedModes`) | Tick **🪑 Seat map at offer** and/or **➕ Add reservation to a booking** — declare the one(s) this vendor actually supports. A scenario's mode picker (§4.6) offers **exactly** these and nothing else. |
| **Offer criteria** | `offerCriteria.{serviceClasses, travelClasses, requestedOfferParts, flexibilities, offerMode, currency}` | The allowed values a scenario's offer search may use. |
| **Fulfillment** | `fulfillment.{media, types}` | Allowed fulfilment media/types (e.g. `PDF_A4` / `ETICKET`). |
| **Ancillaries** | `ancillaries[]` | The catalog of ancillary types the vendor sells. Declaring ≥1 enables the **Add ancillary** action. Defined once, reusable per train (issue #130). |
| **Passenger types & ages** | `passengerTypes`, `passengerAgeRanges` | e.g. `ADULT 26–99`, `CHILD 4–15`. |
| **Concurrency limit** | per‑company | Max parallel runs OSCAR fires at this vendor. Lower it if the vendor is fragile under load (see §8). |

**The golden rule:** *a scenario can only switch on what the framework
authorises.* If a control is greyed out during scenario authoring, the reason is
almost always "enable it in the Test Framework first."

### 3.2 Test data — train sets (routes + timetables)

A scenario doesn't carry its own train — it **references** one of the **train
sets** you define here (the **🚆 Train Resources** section). A train set is:

- a **route** — **Label** (short display name, e.g. *"Sqills IC BAS/AMS"*),
  **Operator Code** (`urn:uic:rics:NNNN`), **Origin / Destination station URN**,
  and optional **Product category** (ref / name / short name);
- a **Services (timetable)** — one or more individual departures that run that
  route, each with a **vehicle number** and **departure / arrival** times;
- **Operating days** — set‑level (applies to every service in the set);
  **empty = daily**. Lets you model "runs Mon–Fri only", etc.

Controls:

| Button | Does |
|---|---|
| **➕ Add Train** | Create a new train set and fill the route + services by hand. |
| **🗐 Duplicate** | Copy an existing set, then tweak the vehicle # / times — the fast way to add a sibling departure or a near‑identical route. |
| **💾 Save all trains** | Persist every set you've opened/edited in one go. |

A scenario then points at a set via its **Trip** (requirement) — `tripType`
**SEARCH** (let the vendor find the train from O&D + date) or **SPECIFICATION**
(pin the exact train/legs).

### 3.3 Journeys (multi‑leg)

The **🧭 Journeys** section chains train sets into a **reusable multi‑leg
itinerary** (e.g. *Basel → Amsterdam → Paris*). Build it once with **➕ Add
Journey** (or **🗐 Duplicate**), and a scenario can then **Apply a Journey** to
fill **all** its legs at once instead of typing each leg. Ideal for testing
multi‑leg / connection offers consistently.

**🔎 Probe** asks the provider whether it offers a saved journey (trip search
on the next 3 days its trains run; nothing is changed). When the provider
offers it as defined, the probe says so. When it does not, but offers other
trips between the same stop places, one button **🔁 Replace this journey with
the N trip(s) offered** replaces the journey by one journey per trip offered,
after a confirmation: their trains are added to (or merged into) the train
sets, and the old journey is removed. Train sets are never removed. Under
**Find journeys** results, which are not saved yet, each trip keeps its own
**➕ Use this trip** button.

### 3.4 Timetable Discovery

Don't know which trains a sandbox actually runs? Use **🔍 Discover timetable**
(in the Train Resources section) to reverse‑engineer them:

1. Enter an **Origin** and **Destination** (UIC URN or bare code — both work).
2. Set **Days to scan** (1–14, default **7**).
3. Click **Discover**.

OSCAR queries the sandbox server‑side (`POST /offers`, with a `/trips-collection`
fallback) across the next N days, harvests every train it offers, and
**creates/updates the train sets** accordingly — including the **travel/service
classes and ancillaries** the vendor actually returns, and splitting sets by
**operating‑days pattern** (so a weekday‑only train and a daily train become
separate sets). **Your manual edits are preserved** — discovery merges, it never
clobbers. It's the fastest way to seed a brand‑new provider's test data.

> Discovery and train/journey editing are `test_manager` actions; they're hidden
> for plain testers.

---

## 4. Authoring a scenario

A scenario is built in the **Scenarios** section. The good news (issue #172):
**only three things are required** — everything else is optional and defaults
sensibly.

### Your scenarios and shared scenarios

The badge on each scenario card in Test Config tells you whose it is, and what you can do with it:

| Badge | Whose it is | What you can do |
|---|---|---|
| ✏️ **Yours** | You created it | Edit, rename, delete it, and tick it for your runs |
| 🔒 **Shared** | Your Test Manager shared it with every tester | Read it and run it. You cannot edit or delete it; **📋 Duplicate** gives you an editable copy of your own |
| 🔒 **Company** | An older scenario that has no owner | The same as a shared one |

You don't see other testers' private scenarios, and they don't see yours.

When you open a 🔒 Shared or 🔒 Company scenario, a banner at the top says it
is read-only and every field on the card is greyed out. You can still expand its
sections, open a passenger's details with **View ▾**, tick it for your runs, and
**📋 Duplicate** it. Nothing else on the card responds. To change it, duplicate
it and edit your copy.

**Save & Apply** saves only your own scenarios. The server enforces this as
well, so nothing you do can change or delete a shared scenario, a company
scenario, or another tester's. If the save confirmation ever lists a scenario
under *"Not changed — read-only for testers"*, your copy of that read-only
scenario no longer matched the stored one. The most likely reason is that your
Test Manager changed it after you opened Test Config. Reload the page to see the
current version.

If a new scenario's code is already used by someone else's scenario (for
example when two testers duplicate the same shared scenario), yours is saved
under the next free code, such as `…_COPY_2`. The save confirmation tells you
the new code.

Your Test Manager sees and manages every scenario in the company.

### 4.1 The minimal scenario

| Required | Notes |
|---|---|
| **Origin** | A station reference. UIC URNs (`urn:uic:stn:…`) and vendor URNs (`urn:x_<vendor>:stn:…`) are both accepted. |
| **Destination** | As above. |
| **Departure date** | Resolved dynamically at run time (`%TRIP_DATE%`), so a saved scenario never goes stale. |

That alone is a valid **SALE** search. Add the options below only when you want
to exercise them.

### 4.2 Scenario type

| Type | Flow exercised |
|---|---|
| **SALE** | Offer → booking → (optional steps) → fulfillment. The default. |
| **REFUND** | Sale, then refund‑offer → refund. An `overruleCode` makes it a technical cancellation (§4.10). |
| **EXCHANGE** | Sale, then exchange‑offer → exchange operation. |

For REFUND and EXCHANGE, the **Action** field says how the after-sale ends
(#663):

| Action | REFUND | EXCHANGE |
|---|---|---|
| **PATCH** | The refund offer is confirmed (`13. PATCH Refund Offer`). | The exchange is confirmed by its fulfilment (step 14). |
| **DELETE** | The refund offer is withdrawn (`15. DEL Refund Offer`). | The exchange offer is withdrawn (`16. DEL Exchange Offer`). |
| — none — | Stops after asking for the refund offer: only that request is tested, and the run log says so. | Same as PATCH. |

Before 1.11.250, an exchange with Action PATCH (the wizard's default) stopped
before its confirmation without saying so.

### 4.3 Offer criteria (optional)

Narrow what you ask the vendor for. Each value is constrained to what the
framework authorised.

- **Currency** (e.g. `EUR`) — *recommended even though optional*: some strict
  vendors `400`/`500` on an empty `offerSearchCriteria` with no currency.
- **Service class** — `STANDARD`, `BEST`, `HIGH`, `BASIC`, `ANY_CLASS`.
- **Travel class** — `FIRST`, `SECOND`, `ANY_CLASS`.
- **Travel class per leg** (#600) — the class expected on each leg, in the
  order of the legs, e.g. `FIRST, SECOND` for a trip whose second train has no
  first class. It replaces the travel class above: the request asks for every
  class named. The offer is chosen among those that give each leg its class;
  none doing so fails the scenario, with the combinations offered, and stops
  it. A provider may sell first class on one leg as a first-class admission of
  its own, or as a second-class admission for the whole trip and a supplement
  (an upgrade product) on that leg: both are accepted, and the check names the
  form found. The booking must give each leg the same class. Use a
  specification trip, whose legs are listed.
- **Offers by trip id** (#602) — OSDM's third way to ask for offers, besides
  search criteria and a trip specification. On, OSCAR first sends
  `POST /trips-collection` with the origin, destination and time of the
  scenario's SEARCH trip (without its train filter). From the trips answered it
  takes the one running the trip's train number when the trip names one, or
  else the first leaving at the time asked or later, and asks `POST /offers`
  with `tripIds` naming it. No such trip fails the scenario and stops it. The
  answer is checked (an `id`, trips with ids and legs, none twice; a trip from
  another stop is a warning), and so are the offers: each must cover the trip
  asked. These checks show in step `01. POST Get Offer`, which makes the call
  itself, so that a retry or the next scenario asks the trips again. One-way
  only: a return, or a SPECIFICATION trip, is asked as before, with a warning.
- **Idempotency-Key test** (#604) — on: `POST /bookings` and `POST
  /bookings/{id}/fulfillments` carry an `Idempotency-Key`. Each is sent again
  with the same key, and the same booking, or the same fulfillments, must
  come back, with no second booking. The booking is also sent with another
  key, which must give a new booking; that booking is left pre-booked and
  expires on its own. The checks show in steps 02 and 06.
- **Unknown trip id refused** (#602) — the negative test: on, `POST /offers`
  names a trip id the provider never gave, and must be refused (`4xx` with an
  RFC-9457 Problem). The scenario ends there.
- **Requested offer parts** — `ADMISSION`, `RESERVATION`, `ANCILLARY`, `FARE_*`,
  `CONTINUOUS_SERVICE`, `ALL`. (Include `RESERVATION` if you intend to pick seats.)
- **Flexibility** — `FULL_FLEXIBLE`, `SEMI_FLEXIBLE`, `NON_FLEXIBLE`.
- **Expected product** (#598) — the product (tariff) the offer must hold: its
  code, as `GET /products` or an offer lists it (matched exactly), or else
  words of its name (matched in the product's summary, then description,
  without case). The offer is chosen among those that hold it, then on the
  flexibility. No offer holding it fails the scenario, with the list of
  products offered, and stops it. After fulfillment, the booking must hold the
  product and each fulfillment must cover a part of it.
- **Expected product absent** (#599) — the negative test: on, no offer may
  hold the expected product (a group its rules exclude: too many passengers,
  too many adults, a weekday). It passes when none does and fails when one
  does; the scenario ends after the offer either way.
- **Offer mode** — `INDIVIDUAL`, `COLLECTIVE`. The OSDM spec defines:
  - `INDIVIDUAL` — each passenger gets their **own** admission/reservation (N admissions for N passengers). Refund of a **single passenger** is possible.
  - `COLLECTIVE` — the admissions/reservations are **shared across the group** (one admission with N `passengerRefs`). The group is **atomic** — you cannot refund an individual passenger; the whole booking moves together.
  - If a provider does **not support** the requested mode, the spec mandates that it **fall back** to the supported mode and emit a **warning** in the response.
  - With only **one passenger**, `COLLECTIVE` is semantically degenerate ("collective of one"). Depending on the provider, OSCAR may see the request **accepted as-is**, **silently fallen back to INDIVIDUAL** (with a warning), or **rejected** with an error (e.g. minimum group size). Today OSCAR doesn't constrain or fully assert this — see #222 for the broader test build-out.
  - **Group tariffs** (#599). Ask `COLLECTIVE` and name the group product in
    **Expected product**. OSCAR then checks the chosen offer: on each trip it
    covers, one `COLLECTIVE` admission for the whole group, naming the
    passenger type applied to each passenger (`appliedPassengerTypes`; a
    warning when the provider gives none, since OSDM does not require it). It
    then sends the same request in the `INDIVIDUAL` mode (step
    `01d. POST Get Offer Individual`) and compares: a group dearer than the
    cheapest offer of the same class (and flexibility) for the same passengers
    alone fails, the same price is a warning. For a weekend group that is a
    return on one ticket, set the return model to both directions in one offer
    and **Return fulfillments** to one. Use **Departure day** on the trip to
    travel on a Saturday or a Sunday.

### 4.4 Return trip (optional)

Leave empty for a **one‑way**. To make it a **return**, set:

- **Return offset (days)** — `0` = same day, `1`, `2`, … Default suggestion is
  **2** (covers night trains). The return date is derived as *outbound departure
  date + offset*, so it tracks the dynamic departure date.
- **Return time** (optional `HH:MM`) — overrides the time‑of‑day; otherwise the
  outbound departure time is mirrored.

- **Return model** — what the second offer call names (issue #594):
  - *Separate directions* (default): the chosen outbound offer
    (`returnSearchParameters.outwardOfferIds`). The provider answers with
    inbound offers, and OSCAR books the outbound and the inbound offer together.
  - *Both directions in one offer* (OSDM 3.7 and later): the chosen outbound
    trip (`returnSearchParameters.outboundTripIds`). The provider answers with
    offers that cover both trips (`tripCoverage` + `inboundTripCoverage`), and
    OSCAR books that one offer.
- **Return fulfillments** (optional) — how many fulfillments the confirmed
  booking should have: one for the whole return, one per direction, or one per
  passenger. Empty = not checked.

The Test Framework declares which return models the provider supports
(*Sales Flows* → 🔁 *Return journeys*, issue #619). The *Return model* list
offers only those. A scenario that already asks for a model the framework
does not declare keeps it, marked ⚠: it still runs, and the run log shows a
`[WARNING]` naming the model. When the framework declares no model, the return
fields of a one-way scenario are locked. *Both directions in one offer* needs
OSDM 3.7 or later, and the Test Framework says so when its version is lower.
A framework from before 1.11.236 declares, the first time it is opened, the
models its scenarios already use.

The return date goes with the first offer call: from OSDM 3.7 as
`offerSearchCriteria.inboundDate`, before as the deprecated
`returnSearchParameters.inwardReturnDate`. Then comes the **two‑step return**
(outbound offer → inward offer → booking). OSCAR checks the second answer
against the first: a trip goes back, the passengers are the same, and the
offers cover what the model says. If a vendor rejects a combined two‑offer
booking, OSCAR automatically falls back to two separate bookings and records a
trackable finding (issue #180); the fulfillment count is then not checked.

### 4.5 Sales‑flow actions (optional opt‑in steps)

These are extra steps inserted into a **SALE** flow. **All default OFF** — opt in
to each one you want to test. An action that the framework doesn't authorise is
shown disabled with the reason.

| Action | Icon | What it does | Requires |
|---|---|---|---|
| **PATCH passengers** | 👤 | Updates passenger details between booking and fulfillment. | — |
| **Place selection** | 🪑 | Picks specific seats (see §4.6). | A reservation ticket type **+** the graphical seat map ticked in the framework (§3). |
| **Add ancillary** | 🧳 | Adds an ancillary offer part to the booking. | ≥1 ancillary in the framework. |
| **GET booking** | 🔄 | Reads the booking back for a consistency check. | — |
| **Delete ancillary** | ✕ | Removes a previously added ancillary (reverse path). | ≥1 ancillary. |

### 4.6 Seat‑selection mode (when Place selection is on)

This is where the **Test Framework** and the **scenario** connect. It's a
two‑place setup — declare the capability once on the framework, then pick from it
on each scenario:

**In the Test Framework → 🪑 Seat Selection (§3):**
1. Tick **“Does the system offer a graphical seat map?”** (`placeSelection.seatMap`).
2. Under **Supported seat‑selection modes**, tick the option(s) the vendor
   really supports — **🪑 Seat map at offer** and/or **➕ Add reservation to a
   booking** (one or both).

**In the scenario (here):**
3. Turn on the **Place selection** sales‑flow action (§4.5).
4. Pick **one** mode from the **Seat‑selection mode** picker — it shows
   **exactly** the option(s) you ticked in step 2, nothing else.

> If the framework lists only one mode, the scenario pre‑selects it — **still
> click the pill so the choice is saved**. An unsaved/stale value can silently
> run the other flow (this is the cause of "I chose *Seat map at offer* but the
> offer‑time step never ran"; see §8).

The two modes — the same labels appear in the framework and the scenario:

| Mode (`placeSelectionMode`) | Label (UI) | When the seat is chosen |
|---|---|---|
| `SEATMAP_AT_OFFER` | **🪑 Seat map at offer** | *Before* the booking. OSCAR `GET`s the offer‑time seat map, picks an available seat per passenger, and carries it into the `POST /bookings`. The seat may affect the price. |
| `ADD_TO_BOOKING` | **➕ Add reservation to a booking** | *After* the booking. A reservation offer part is added to the existing booking (e.g. SNCF first‑class TGV). |

**Adaptive behaviour (issues #182/#184/#186/#188):**
- `SEATMAP_AT_OFFER` is the discovery‑friendly choice: it tries the offer‑time
  map and, **if that fails, automatically falls back** to the after‑booking path.
  So for an unknown vendor, authorise *both* modes in the framework and choose
  `SEATMAP_AT_OFFER`.
- The seat picked is **availability‑aware** (occupied/reserved places are
  skipped) and **one seat per passenger**. There is intentionally **no
  "seat‑passengers‑together"** optimisation yet.
- A reservation must exist in the offer for a seat map to apply. If it doesn't,
  the seat‑map step is skipped cleanly ("not applicable") rather than erroring.

**Mandatory and optional seat reservations (#601).** These are separate from
seat selection: here OSCAR only books the reservation, and the provider
allocates the seats.

- OSCAR reads each admission's `reservations` relations to know what is
  required. A relation whose `minGroupItemsToBeBooked` is above 0 is a
  **mandatory** reservation, and OSCAR always books it with the booking, in
  `placeSelections` naming its trip and leg (#742), or in
  `optionalReservationSelections` when the offer does not say which leg it
  covers. A relation at 0 is **optional**.
- **Optional reservations** (Booking Flow Actions) says how the optional ones
  are booked:
  - `RESERVATION_SELECTION`: `optionalReservationSelections` in the booking;
  - `PLACE_SELECTION`: `placeSelections` in the booking, naming the trip and
    the leg;
  - `ADD_LATER`: added after the booking with `POST
    /bookings/{id}/booked-offers/{id}/offer-parts` (step 09);
  - empty: the optional ones are not booked.
- The older **Book via optionalReservationSelections** switch now means
  "book the optional ones too".

#### Passengers updated

**Passengers updated** (Booking Flow Actions) says which passengers step 03
updates: all of them (the default), or the **main passenger only**, for a
provider that lets only the first passenger be changed. Step 04 then expects
the new details for the passengers updated and the booked ones for the
others.

After the update, a detail the provider does not return at all (a date of
birth, a phone number, a co-traveller's name) is a `[WARNING]`: OSDM does not
oblige a provider to keep it. A detail returned with a different value is a
failure.
- **Checks:**
  - every relation names reservation parts of the offer and fits its group;
  - the booking holds each reservation booked, on the same leg;
  - the place each reservation was given is reported (a warning when there
    is none).
- Some providers (ČD) sell a reservation for all passengers or none, on one
  leg at most. OSDM does not require this, so OSCAR reports it as a warning.

### 4.7 Passengers & fulfillment (optional)

- **Passengers** — type (`PERSON`, `BICYCLE`, `DOG`, `PRM`, …), date of birth,
  and optional patch values (name/email/phone) used by the PATCH‑passengers step.
- **Reduction cards** (#597) — the provider's card codes, as its
  `GET /reduction-cards` lists them. Each is sent as an OSDM card reference
  (`{ type: REDUCTION_CARD, code, issuer }`) with the offer, booking and
  exchange requests; the issuer comes from the provider's list (a warning when
  the list cannot be read or does not hold the code). OSCAR then checks that
  the chosen offer names the card on the passenger (`appliedPassengerTypes`),
  and asks the same offers again without cards (`01c. POST Get Offer without
  Cards`): the card holder must pay less, the others the same (a warning).
- **Fulfillment** — media (`PDF_A4`, `UIC_PDF`, `RETAILER_APP`, …) and type
  (`ETICKET`, …), constrained to the framework's `fulfillment`.
- **Fulfilment documents** (#603) — after the booking is confirmed:
  - OSCAR reads each ticket with `GET /fulfillments/{id}` (step `06b. GET
    Fulfillment`). A provider that does not implement it (`501`, `404`, …)
    gets a passing "not implemented" row, as for the other optional reads.
  - Step 07 checks the booking's documents. They are read where the version
    puts them: in each fulfillment up to 3.7; in 3.8, in the booking's
    `fulfillmentDocuments`, each fulfillment naming its own in
    `fulfillmentDocumentRefs`.
  - What is checked: every medium asked for is delivered; each document's
    format fits its medium (`PDF_A4` is `application/pdf`, `RETAILER_APP` a
    PNG or JPEG image); its content is that format; for `RETAILER_APP`, one
    document per fulfillment.
  - A PDF that covers more than the fulfillment read (one PDF merged for the
    whole booking, as ČD delivers it) is reported at 06b.
  - **Every one of these is a warning, never a failure.**
- **Refund receipt wait (min)** (#603, refund scenarios) — some providers add
  a receipt (a document of type `INFORMATION`) to the booking some minutes
  after a refund.
  - Set 1 to 60 minutes. After the refund, step `14b. GET Booking Refund
    Receipt` reads the booking every 15 seconds until the receipt appears, in
    `documents` or in `fulfillmentDocuments`.
  - No receipt within the wait fails the scenario. Leave the field empty not
    to wait.
  - The run's time limit grows by the wait, as for the expiry tests.

> **Passenger reference format (since server‑v1.11.98).** The wizard generates
> passenger references as 5‑digit zero‑padded strings (`"00001"`, `"00002"`,
> …) — these become the OSDM `externalRef` on every passenger‑bearing call.
> OSDM v3.8 permits any non‑null string, but at least one production provider
> (Paxone) enforces a numeric / zero‑padded shape and rejects `"PAX1"`-style
> references with a catch‑all `Schema validation error`. **Scenarios authored
> before v1.11.98** still carry the old `PAX1`, `PAX2`, … format in their
> data file and will continue to fail on Paxone. Two paths to fix them:
> (1) **re‑author the scenario** in the wizard — passengers regenerate with
> the new format; or (2) **hand‑edit the data file** — rename every `PAXn`
> to its zero‑padded equivalent. The reference appears in three places per
> scenario: `passengersList[].passengers[].reference`,
> `bookingPassengerReferences` (flat array of strings), and any echoed
> `externalRef` inside `offerPassengerSpecifications` /
> `bookingPassengerSpecifications` if you materialised those fields by hand.
> Bileto, Sqills, Turnit and Benerail accept both formats and are unaffected.

### 4.8 Non Happy Flow customisation — negative tests and conformance probes

These probes drive a scenario into a **non‑happy** path and assert the provider
**rejects** it in a conformant way (typically `4xx` + an RFC‑9457 `Problem`
body). They all default OFF — a saved scenario keeps behaving as before until
you opt in.

**Wizard layout (since server‑v1.11.100).** The NHF section is organised into
two collapsible sub‑groups, each with a badge showing how many of its probes
are currently armed:

```
▼ Non Happy Flow customisation        — N probes armed
    ▶ ⏰ Expiry timers                  — N of 6 armed
         (Expired offer / booking / add‑res / add‑anc / refund‑offer / exchange‑offer)
    ▶ 🪪 Field‑shape & payload probes  — N of 2 armed
         (RequestedInfo probe, Passenger external‑ref format)
```

Each sub‑group auto‑expands when anything inside it is armed and auto‑collapses
when it isn't. Manual toggles are preserved across re‑renders.

`requestedInformationProbe` lives in this section since **v1.11.100** — it was
previously rendered in the SCENARIO PARAMETERS panel, but the Tester Guide
always classified it as NHF; the wizard now matches.

#### Passenger external‑ref format probe (`passengerExternalRefFormat`)

Override the default `00001`-style passenger reference with a custom
printf‑style pattern, applied at scenario‑parse time and propagated through
every downstream call (offer, booking, refund, exchange). Designed to
document provider variance — at the time of writing, **Paxone rejects
`PAX1`‑style refs with a catch‑all `Schema validation error`** while Bileto,
Sqills, Turnit and Benerail accept any non‑empty string per OSDM v3.8 spec.

| Pattern (wizard input) | Generated refs for a 3‑pax scenario |
|---|---|
| *(empty — default)* | `"00001"`, `"00002"`, `"00003"` |
| `PAX%04d` | `"PAX0001"`, `"PAX0002"`, `"PAX0003"` |
| `ABC-%03d-XYZ` | `"ABC-001-XYZ"`, `"ABC-002-XYZ"`, `"ABC-003-XYZ"` |
| `%d` | `"1"`, `"2"`, `"3"` (no padding) |
| `%05d` | `"00001"`, `"00002"`, `"00003"` (same as default) |

The pattern must contain a `%d` or `%0Nd` placeholder. Without one, the
probe is ignored at runtime and a `[WARNING]` is logged — the run continues
with the default refs.

The wizard renders a **live preview** under the input box so you can see
what the first three passenger refs will look like before saving.

#### Passenger `requestedInformation` probe (`requestedInformationProbe`) — #258

OSDM lets a provider demand additional passenger info (a `requestedInformation`
block in the offer/booking response). OSCAR auto‑feeds the demanded fields on
the happy path. This probe lets you also test the **negative** path:

| Mode | What OSCAR does |
|---|---|
| **`off`** *(default)* | Auto‑feed the demanded fields so the happy flow completes. |
| **`omit`** | **Withhold** required fields → assert the provider rejects with a conformant `Problem`. |
| **`invalid`** | Send **invalid values** (per passenger field, one at a time) → assert the provider rejects with a conformant `Problem`. |

> **Provider‑fair severity.** Only the genuinely strict fields (`gender` enum,
> `dateOfBirth` format) are hard FAILs when the provider *accepts* invalid
> input. Free‑form fields (`firstName`, `lastName`, `email`, `phoneNumber`) are
> WARN‑level because OSDM doesn't constrain their content.

#### Purchaser placement & probe (`bookingPurchaserMode`) — #258 / #203

Where (and whether) the purchaser is supplied for a booking. Covers both the
happy path and the negative path in one field.

| Mode | What OSCAR does |
|---|---|
| **`inline`** *(default)* | Purchaser is sent in the `POST /bookings` request. Historic behaviour. |
| **`deferred`** | Omit purchaser at booking, then upsert it afterwards via the dedicated endpoint. OSCAR does a **GET first** and chooses `PATCH /bookings/{id}/purchaser` (purchaser already present and empty) or `POST` (none yet). Also exercises any purchaser `requestedInformation` raised by the booking. |
| **`omit`** | Never supply a purchaser → assert that bookings missing the purchaser are still acceptable (purchaser is optional per OSDM `BookingRequest`). |
| **`invalid`** | Omit at booking, then `POST` an **invalid** purchaser → assert the provider rejects with a conformant `Problem`. Iterates one field at a time (`firstName`/`lastName`/`email`/`phoneNumber`). |

#### Expired‑booking test (`expiredBookingTest`) — #204

Asserts that a booking left to expire **cannot be fulfilled**.

| Mode | What OSCAR does |
|---|---|
| **`off`** *(default)* | Normal flow. |
| **`on`** | After the booking is created, **wait until 15 s past** the booking's effective confirmation deadline. The deadline is resolved in this order: **(1)** `booking.confirmationTimeLimit` (OSDM‑standard at the booking level); else **(2)** `booking.confirmableUntil` (Bileto puts it here at the booking level); else **(3)** the **earliest** `bookedOffers[].{admissions \| reservations \| ancillaries}[].confirmableUntil` — Paxone exposes the deadline only here, which is in fact OSDM's own placement for that field. Then `POST /fulfillments`. The fulfillment **MUST be rejected** (`4xx` + `Problem`) — a hard FAIL if the provider fulfills an expired booking. The follow‑up `GET /bookings` must show admissions/reservations **EXPIRED / RELEASED / CANCELLED** (a `404` purge is accepted). |

**Max wait (`expiredBookingMaxWaitMinutes`)** — optional per‑scenario timer
shown next to the **Expired‑booking test** dropdown. Integer minutes, 1–60.
When set, OSCAR uses this as the wait budget for **this scenario** instead of
the server's `RUN_TIMEOUT_MS`, and the runner **auto‑extends the worker
SIGTERM** to cover it. Use it when the provider's deadline is longer than
the server default (Bileto / Paxone are ~15 min → set **20**). Leave empty
to use the server default. The server clamps the effective timeout at
`RUN_HARD_MAX_TIMEOUT_MS` (default 30 min); raise that env var if you ever
need to test providers with deadlines longer than ~25 min.

> **Run‑budget guard.** If waiting until the deadline would exceed the run's
> `RUN_TIMEOUT_MS` (default 10 min), the test **skips with a `[WARNING]`** that
> tells you the minimum seconds to raise the timeout to — instead of being
> killed mid‑wait. For a provider whose `confirmationTimeLimit` exceeds ~9 min,
> raise `RUN_TIMEOUT_MS` on the server before running.

**Automatic OAuth token refresh.** Long‑running scenarios (and long batches)
used to fail at the very end with a provider `403 "not authenticated"` because
the access token issued at run start outlived its TTL during the wait.
OSCAR now refreshes the token automatically — you don't have to configure
anything, but it's worth knowing the layers so the log lines make sense:

- **Per‑scenario** — `01. POST Get Offer` checks at the start of every scenario
  whether the cached token needs renewing (cheap cache hit when it doesn't).
- **After the expired‑booking wait** — `06. POST Obtaining Fulfillments` forces
  a fresh token just before the late `POST /fulfillments`, so the wait can't
  outrun the token.
- **Background watchdog** — the runner ticks every 5 min while the run is in
  flight (operator‑tunable via `TOKEN_WATCHDOG_INTERVAL_MS`, see the Server
  Admin Guide) to keep the cached token warm under long runs.

If you ever **do** see a `401`/`403` from the provider, OSCAR explicitly flags
it as an auth failure — *not* a booking‑expiry rejection — with a
`[WARNING] … this is likely a token problem (refresh failed), not a
booking‑expiry rejection`. So you'll never mis‑read an auth error as a test
pass.

#### Expired‑offer test (`expiredOfferTest`)

Asserts that an offer left to expire **cannot be booked**. Same pattern as the
expired‑booking test above, one step earlier in the flow.

| Mode | What OSCAR does |
|---|---|
| **`off`** *(default)* | Normal flow. |
| **`on`** | After the offer is selected, **wait until 15 s past** the earliest `OfferPart.validUntil` from the chosen offer (scanned across admission / reservation / ancillary parts and the fare‑* equivalents). Then `POST /bookings`. The booking **MUST be rejected** (`4xx` + `Problem`) — a hard FAIL if the provider accepts a booking against an expired offer. The post‑booking happy path (passenger PATCH, GET, fulfillments) is then **skipped** for this scenario because no booking was created. |

**Max wait (`expiredOfferMaxWaitMinutes`)** — optional per‑scenario timer
shown next to the **Expired‑offer test** dropdown. Same semantics as
`expiredBookingMaxWaitMinutes`: integer 1–60 minutes; OSCAR uses it as the
wait budget for this scenario instead of the server's `RUN_TIMEOUT_MS`, and
the runner auto‑extends the worker SIGTERM to cover it (clamped at
`RUN_HARD_MAX_TIMEOUT_MS`). Typical: **15** (most provider offer windows are
≤ 15 min). Leave empty to use the server default.

> **Same run‑budget guard, same WARNING.** If waiting until the deadline
> exceeds the run's budget, the test **skips with a `[WARNING]`** that tells
> you the minimum minutes to raise the **Max wait** to. The token‑refresh
> safety net described above applies identically — no `401`/`403` mis‑reads.

> **Combining multiple timers on one scenario auto-expands into sub-runs.**
> Each enabled timer kills the flow at a different request, so OSCAR runs the
> scenario **N times** when N timers are armed — one pass per timer, in flow
> order: Offer → Booking → AddReservation → AddAncillary → RefundOffer →
> ExchangeOffer. Each sub-run's assertions are prefixed
> `[NHF_<3-letter>_<scenario_code>]` in the report — `OTO` (offer), `BTO`
> (booking), `ARO` (add-reservation), `ATO` (add-ancillary), `RTO` (refund),
> `ETO` (exchange). A leading `NHF_` on the scenario code is stripped so you
> don't get `NHF_BTO_NHF_…`. The worker SIGTERM budget is the **sum** of the
> enabled Max waits, clamped at `RUN_HARD_MAX_TIMEOUT_MS` (default 30 min);
> raise that env var if you arm 3+ timers with long waits.

#### Expired post-booking add-reservation test (`expiredAddReservationOfferTest`)

Asserts that an offer-part **cannot be added** to an existing booking once its
`validUntil` has passed.

| Mode | What OSCAR does |
|---|---|
| **`off`** *(default)* | Normal flow. |
| **`on`** | Just before `09. POST Add Reservation to Booking` fires, OSCAR waits until 15 s past the `validUntil` of the specific `reservationOfferPart` that 09 is about to send. Then fires 09. The **POST must be rejected** (`4xx` + `Problem`). The downstream post-booking happy path (Add Ancillary / PATCH passenger / GET passenger) is **skipped** because the reservation was not added. |

Only meaningful when the scenario uses **Place selection** in **ADD_TO_BOOKING** mode (enable it in the **Booking Flow Actions** section). When the offer carries no `validUntil` on its reservation parts the test skips with a `[WARNING]`.

**Max wait (`expiredAddReservationOfferMaxWaitMinutes`)** — same semantics as `expiredOfferMaxWaitMinutes`. Typical: 15.

#### Expired post-booking add-ancillary test (`expiredAddAncillaryOfferTest`)

Asserts that an ancillary offer-part **cannot be added** to an existing booking once its `validUntil` has passed.

| Mode | What OSCAR does |
|---|---|
| **`off`** *(default)* | Normal flow. |
| **`on`** | Just before `10. POST Add Ancillary to Booking` fires, OSCAR waits until 15 s past the **earliest** `validUntil` across the ancillary offer-parts that 10 will send. The deadline is sourced from `11. additional-offers` (primary — booking-specific add-ancillary offers) or the original offer's `ancillaryOfferParts` (fallback). Then fires 10. The **POST must be rejected** (`4xx` + `Problem`). The downstream PATCH/GET passenger chain is **skipped**. |

Only meaningful when **Add ancillary** is enabled in the **Booking Flow Actions** section. If `11. additional-offers` returns nothing addable, the test skips with a `[WARNING]`.

**Max wait (`expiredAddAncillaryOfferMaxWaitMinutes`)** — same semantics.

#### Expired refund-offer test (`expiredRefundOfferTest`)

Asserts that a refund offer **cannot be confirmed** once its `validUntil` has passed.

| Mode | What OSCAR does |
|---|---|
| **`off`** *(default)* | Normal flow. |
| **`on`** | After `10. POST Refund Offers` returns the proposed refund, OSCAR waits until 15 s past `refundOffers[0].validUntil`. Then fires `13. PATCH Refund Offer` with `status: "CONFIRMED"`. The **PATCH must be rejected** (`4xx` + `Problem`). The downstream `14. GET Booking after Patch Refund` / `15. DEL Refund Offer` / `16. GET Booking after Delete Refund` steps are **skipped**. |

**REFUND scenarios only** — the field is shown in the wizard only when `scenarioType = REFUND`. There is no separate "refund confirmation" timeout because OSDM refund execution is synchronous (no PREBOOKED→CONFIRMED holding state).

**Max wait (`expiredRefundOfferMaxWaitMinutes`)** — same semantics. Typical refund-offer windows are similar to sale offers (~15 min) — set 20.

#### Expired exchange-offer test (`expiredExchangeOfferTest`)

Asserts that an exchange offer **cannot be turned into a booking** once its
**`preBookableUntil`** has passed.

> **Spec naming quirk.** Every other expired-X test waits past a `validUntil`. The exchange flow waits past **`preBookableUntil`** — same semantic ("the latest moment this offer can still be accepted"), but the OSDM spec uses a different field name on `ExchangeOffer` for it. See [OSDM Spec Deviations #25](../OSDM/OSDM_Spec_Deviations_Observed_2026-05-28.md) for the cross-resource naming inconsistency this surfaces.

| Mode | What OSCAR does |
|---|---|
| **`off`** *(default)* | Normal flow. |
| **`on`** | After `10. POST Exchange Offers` returns the proposed exchange, OSCAR waits until 15 s past `exchangeOffers[0].preBookableUntil`. Then fires `11. POST Exchange Operations`. The **POST must be rejected** (`4xx` + `Problem`). The downstream `GET booking before fulfillment` / `POST fulfillments` chain is **skipped**. |

**EXCHANGE scenarios only.** No separate "exchange confirmation" timeout is needed — accepting an exchange creates a **new booking** with its own `confirmationTimeLimit`, which is already covered by `expiredBookingTest` running on a post-exchange leg.

**Max wait (`expiredExchangeOfferMaxWaitMinutes`)** — same semantics.

#### Auto-expansion: multi-timer scenarios → one sub-run per timer

When a scenario has **2 or more** expired-X timers enabled, OSCAR doesn't try
to run them all in one pass (impossible — each one kills the flow at a
different request). Instead it **auto-expands** the scenario into **N
sub-runs**, one per armed timer, executed sequentially in the order the
timers fire in the flow:

1. **Offer** (`OTO`) — `expiredOfferTest`
2. **Booking** (`BTO`) — `expiredBookingTest`
3. **Add-reservation** (`ARO`) — `expiredAddReservationOfferTest`
4. **Add-ancillary** (`ATO`) — `expiredAddAncillaryOfferTest`
5. **Refund-offer** (`RTO`) — `expiredRefundOfferTest`
6. **Exchange-offer** (`ETO`) — `expiredExchangeOfferTest`

**How to read the report.** Each sub-run's Bruno assertions are prefixed with
`[NHF_<3-letter>_<scenario_code>]`. For a scenario named `SC_PARIS_LYON` with
`expiredOfferTest` + `expiredBookingTest` both on, you'll see two distinct
sub-runs' assertions interleaved in the report:

```
[NHF_OTO_SC_PARIS_LYON] Expired offer: POST /bookings is rejected with a client error...
[NHF_OTO_SC_PARIS_LYON] Expired offer: error body is an RFC-9457 Problem...
[NHF_BTO_SC_PARIS_LYON] Expired booking: fulfillment is rejected with a client error...
[NHF_BTO_SC_PARIS_LYON] Expired booking: error body is an RFC-9457 Problem...
[NHF_BTO_SC_PARIS_LYON] Expired booking: admissions/reservations are EXPIRED/RELEASED/CANCELLED...
```

If your scenario code already starts with `NHF_`, the prefix isn't doubled:
`NHF_SC_FOO` + `OTO` → `[NHF_OTO_SC_FOO]`, not `[NHF_OTO_NHF_SC_FOO]`.

**Gating skips.** Timers that can't physically fire on the scenario are
silently dropped from the queue (with a `[WARNING]` log line so you know):

- `expiredRefundOfferTest` on a SALE scenario → skipped, REFUND only
- `expiredExchangeOfferTest` on a SALE scenario → skipped, EXCHANGE only
- `expiredAddReservationOfferTest` without `salesFlow_placeSelection` +
  `placeSelectionMode=ADD_TO_BOOKING` → skipped
- `expiredAddAncillaryOfferTest` without `salesFlow_addAncillary` → skipped

**Wait-budget math.** The worker SIGTERM budget for a scenario is the **sum**
of its enabled Max waits (each + 60 s buffer for the request and assertions
that follow). Three timers at 15 min each = ~46 min total, which would
exceed the default `RUN_HARD_MAX_TIMEOUT_MS` of 30 min — the runner clamps
and emits a clear `[WARNING]`. Either raise `RUN_HARD_MAX_TIMEOUT_MS` on the
server, or lower the per-timer Max waits.

**Backwards compatibility.** Single-timer scenarios behave identically to
before — same assertion names (no `NHF_…` prefix), same flow, same budget.
The auto-expansion mechanism only kicks in when the per-scenario queue has
2+ entries.

### 4.9 Partial refund (`partialRefundByLeg` / `partialRefundByPax` / `partialRefundByFulfillment`) — issues #218, #595

For **REFUND** scenarios only. Scopes the refund-offer request to a subset of
the booking via OSDM's `RefundOfferRequest.refundSpecifications[]` (each entry
carries a `fulfillmentId` plus optional `bookingPartIds[]` for the per-leg axis
and `passengerIds[]` for the per-passenger axis).

| Field | Values | What it scopes |
|---|---|---|
| **`partialRefundByLeg`** | `off` / `on` | When on, the refund covers only one *leg* of a multi-leg booking (i.e. one of the admissions plus its linked reservations and ancillaries). |
| **`partialRefundLegSelection`** | `first` / `last` / `outbound` / `inbound` | Which leg. `outbound` / `inbound` only appear in the wizard for return-trip scenarios; on a one-way trip OSCAR falls back to `first`. |
| **`partialRefundByPax`** | `off` / `on` | When on, the refund covers only one passenger of a multi-passenger booking. |
| **`partialRefundPaxSelection`** | `first` / `last` | Which passenger (by booking-order). |
| **`partialRefundByFulfillment`** | `off` / `on` | When on, the refund covers one whole fulfillment (#595). Only `fulfillmentIds` is sent, without `refundSpecifications`: for providers that refund per fulfillment and refuse a scope by leg or passenger. It takes precedence over the two axes above. |
| **`partialRefundFulfillmentSelection`** | `first` / `last` / `outbound` / `inbound` | Which fulfillment: the first or last of the booking, or the one holding the outbound or inbound trip of a return. What a fulfillment holds depends on how the provider divides the booking (one per booking, per direction, per passenger…). |

Both axes can be combined — `byLeg=on` + `byPax=on` refunds one passenger on one leg.

**Several refund offers (#595).** Some providers answer a refund request with
one refund offer per fulfillment. OSCAR then confirms every offer in turn and
reads the booking after each: the fulfillments of the confirmed offers must be
`REFUNDED` and the others unchanged. A full refund ends with every fulfillment
refunded. Each offer must name fulfillments of the booking, and no fulfillment
may be in two offers.

#### Setup-time validation (wizard)

The wizard blocks save with an inline warning when:

- `partialRefundByPax` is on but the resolved `passengersList` has fewer than 2 passengers
- `partialRefundByLeg` is on, the trip is a `SPECIFICATION` trip, and that trip has fewer than 2 legs
- `partialRefundLegSelection` is `outbound` / `inbound` but the trip isn't a return-trip → OSCAR auto-falls-back to `first`

`SEARCH`-mode trips can't be statically checked at authoring time (the offer is only known at run time) — the wizard shows an info note instead.

#### Runtime degradation (offer-time)

In `10. POST Refund Offers`'s before-request, OSCAR looks at the actual booking just retrieved by `07. GET Booking after Fulfillments` and resolves the scope:

- Per-leg requires the booking to have **≥ 2 admissions**. If the SEARCH-mode offer returned only 1 leg, the test **degrades** with `[WARNING] Partial refund degraded to full: booking has fewer than 2 admissions — leg-partial-refund requires a multi-leg booking.`
- Per-pax requires the booking to have **≥ 2 passengers** in `bookedOffer.passengerRefs` (with fallback to `booking.passengers[].id`).
- If either degradation fires, OSCAR sets `__partialRefundDegradedToFull=true` and the request is sent without `refundSpecifications` → a full refund happens, the regular full-refund assertions still fire, but the partial-scope assertions skip.

#### Assertions

When partial refund is armed AND not degraded:

| Assertion | Replaces |
|---|---|
| `refundFee + refundableAmount < confirmedPrice` (strict-less) | The standard full-refund `=` identity (which would fail by design) |
| `refundableAmount + refundFee` = the price of the parts in scope (#595: the fee is counted) | — |
| `refundOfferBreakdownItems[].bookingParts[] ⊆ requested bookingPartIds` | (additional structural check; logs INFO when the response omits a breakdown) |

When partial refund is degraded: the standard full-refund financial-identity check fires unchanged.

> **One scenario, one shape today.** A scenario can either run a full refund OR a partial refund. To test "first-leg refund AND second-leg refund AND full refund" on the same booking, duplicate the scenario in the wizard with different `partialRefund*` settings — same auto-expansion pattern as the expired-X family, except today it's scenario-level (no `NHF_*` prefix for partial refunds).

### 4.10 Technical cancellation (`overruleCode` / `overruleCodeExpectRejection`) — issue #596

For **REFUND** scenarios. An `overruleCode` (for example `CONNECTION_BROKEN`,
`PAYMENT_FAILURE`, `SALES_STAFF_ERROR`, `TECHNICAL_FAILURE`) is sent in the
refund-offer request: the refund is then a technical cancellation, the whole
price is given back and no fee is kept, whatever the product's own refund
conditions. The picker shows the codes the Test Framework declares for refunds
(Refund → IROPS). Make one scenario per code the provider supports.

What OSCAR checks with a code:

| Check | When |
|---|---|
| `appliedOverruleCode` is the code sent | every refund offer |
| `refundFee` = 0 | every refund offer |
| `refundableAmount` = the booking's `confirmedPrice` | one refund offer for the booking |
| the refund offers together give back the `confirmedPrice` | one refund offer per fulfillment (#595) |

**A code the provider does not support.** Set **Overrule code refused**
(`overruleCodeExpectRejection`) to `on` and pick a code the provider does not
support; while it is on, the picker offers every listed code. OSCAR then expects
`10. POST Refund Offers` to answer **4xx with an RFC-9457 Problem**, which should
name `overruleCode` (a warning if it does not), and the scenario ends there.
A provider that accepts the code fails the scenario; its refund offer is left
proposed. Without an overrule code the flag is ignored with a warning.

### 4.11 Logging verbosity (`loggingType`, optional)

Per‑scenario verbosity for the execution log embedded in the report. Affects
log volume only — never assertion outcomes.

| Value | When to use |
|---|---|
| **`FULL`** | Maximum detail (default for new scenarios). Use for first‑time debugging or when reporting a bug. |
| **`INFO`** | Steps + key counts; skips the bulky per‑offer dumps. Recommended for routine runs. |
| **`DEBUG`** | INFO + the `[DEBUG]` traces the framework emits. |
| **`ERROR`** | Errors and warnings only — quietest. |

---

## 5. Running tests

- **Run one scenario** or **Run the collection** (every scenario in *your* run
  list, from the top). A run starts at `GET /versions`, which also resets all
  per‑run state.
- **Your run list is yours.** The scenarios you tick **✓ In run** in Test Config
  are your own selection, taken from your scenarios and the shared ones. Another
  tester's ticks never change what you run, and yours never change theirs. Until
  you tick anything, you start from your Test Manager's selection.
- **Concurrency** — OSCAR can run several sessions in parallel up to the global
  limit **and** the per‑company limit (the lower wins). If a vendor misbehaves
  under parallel load, set that company's limit to **1** to serialise.
- You'll get a **run** in the dashboard with a live status; when it finishes the
  **report** and a downloadable **JSON results** artifact are attached.

---

## 6. Reading the report

The run detail page has two collapsible cards (everything starts collapsed):

### Assertions
Two levels: **main area (suite)** → **endpoint (request)** → individual
assertions, with pass/fail counts at each level. Filters let you show all /
failed only.

- A green count = conformant. A red **N failed** on an otherwise `200` request
  means **OSDM compliance assertions** failed — i.e. the *response* deviates from
  the spec. That's a **finding about the vendor**, not an OSCAR error.
- Watch for the deliberately **trackable** assertions:
  - `[OSDM] Vendor serves a pre-booking (OFFER-context) seat map`
  - `[OSDM] Vendor serves a post-booking (BOOKING-context) seat map`
  - `[OSDM] Vendor supports booking multiple offers (round trip) in one booking`

  These are written to **fail loudly** when a vendor lacks an optional capability,
  so you can filter the report for "what this vendor can't do." A matching
  `⚠️ [VENDOR GAP]` line appears in the execution log. The flow still completes
  via the adaptive fallback.
- A **passing** row named `… not implemented by this provider (auto-detected)`
  on one of the optional, read-only steps — the System-Information catalogs
  (`01-System Infos Requests`), `04. GET Passenger`, `11. GET Refund Offer`,
  `12. GET Exchange Offer` — means the vendor answered that endpoint with a
  "not implemented" signal (501, an OSDM Problem `OPERATION_NOT_PERMITTED`, or
  a bare 404) or with a bare 403/405/500. That is **not a failure**: OSDM makes
  those endpoints optional. The execution log carries the detail — an `[INFO]`
  line for the clean signals, a `[WARNING]` line for a bare 403/405/500 (by the
  HTTP standard those codes mean something else; the line asks the vendor to
  answer 404 or 501 with a Problem body instead). A `401` on the same step is a
  token problem and still fails. In **Report Builder**, the Vendor Capability
  Matrix shows these same steps as `NOT_IMPLEMENTED` rather than `ERROR` — read
  it as the list of what the vendor supports and what it doesn't.
- After a **confirmed refund** (`14. GET Booking after Patch Refund`) or a
  **completed exchange** (`15. GET Booking after Fulfillment`), the booking
  check looks for `confirmedPrice`, not `provisionalPrice` — OSDM defines the
  confirmed price as the confirmed parts minus the confirmed refunds, and
  nothing is pre-booked any more at that point. An `[INFO]` line shows the
  confirmed price before and after the operation; whether it *should* drop by
  the refunded amount is still being clarified with the OSDM test-scenario
  team, so it is shown, not asserted.

### HTTP Traffic — Request & Response
Same suite → endpoint structure. Click any endpoint to lazily load its full
request body + response body (pretty‑printed) and headers. Use this to confirm
exactly what OSCAR sent (e.g. that `resourceId` resolved, or that
`placeSelections.places[]` has the right shape).

**HTTP status vs. assertion failures are different things.** A request can be
`200` (HTTP OK) and still have failed assertions (spec deviations), and vice‑versa.

### Test Framework coverage (Report Builder)

The **Test Framework Coverage** card of the Report Builder is not tied to one
run. It reads the latest finished run of each scenario of the company or
provider selected, over the period chosen (365 days by default). Choose
**Show coverage**. It opens **By capability**, the way an assessment is
written.

**By capability.** One row per capability: an offer search, a sale, a full
refund, a seat near a given place… Each row shows:

- what the Test Framework says of it;
- its tests and their forms (search, specification, trip id);
- the number of other runs that went through it on the way;
- its result;
- the numbers of its points to look at.

A failed check counts only against the capability its scenario is for. A
failure at an optional operation (a reference data read, the fulfilment read,
a withdrawal, the refund receipt) counts only against that operation. The
results:

| Result | Meaning |
|---|---|
| Passed | Every run that reached it passed. |
| Passed with deviation | It passed, except for deviations that are accepted (see below). |
| Passed with points | It went through, with checks to look at. |
| Blocked | No run got as far as this capability. |
| Not supported by the provider | The provider answered 501, or "not implemented" on an optional read. |
| Not tested | Declared in the Test Framework, but no run reached it. |
| Out of scope | Not declared, or declared as not supported. |

**Expected refusals** (the `NHF_` scenarios and the refusal probes) are listed
apart: refused as expected, not refused, or not run. They never change the
result of the capability they probe.

**Optional parameters of the offer request.** When the offer request options
scenario (`OTST_OFFER_OPTION_DISCOVERY`) has run, the report states each of
its results, from the latest run of each form:

- the request with the mandatory parameters only: answered or not;
- each optional parameter sent alone: supported, ignored, refused, no offer,
  not tested…, and whether the Test Framework declares it;
- each combination of parameters found supported, and all of them at once:
  answered, no offer or refused.

The capability's row gives the latest run's counts in one line; each run is
folded under its own line. A point is raised only for:

- the mandatory request not answered;
- a declared parameter the provider does not take;
- a refused combination (an error status for parameters that each worked
  alone).

A combination without offer is only stated, since it can be legitimate. The
Markdown and the workbook (sheet *Offer request parameters*) hold the same.

**Points to look at.** Each distinct problem appears once, with a number,
however many forms, runs and steps showed it. In the tables, click a point's
number to open that point under its row, and click it again to close it. The same check failing at
several steps of a test is one point that lists those steps. Each point
shows:

- the capability it counts against;
- the step(s) and, for an error answer, the HTTP status and problem code;
- **Expected:** what the check expects, as its title says it;
- **Seen:** what the latest run that showed it got instead, as that run's
  failure text gives it (for example the flexibilities the offers came back
  with). A report published before 1.11.413 has no *Seen* line;
- the tests and scenario codes that showed it, and the first and last day
  it was found;
- whether it blocked the run: an HTTP status the step did not expect, a script
  that broke or a missing prerequisite blocks it, any other failed check does
  not;
- the finding it is recorded as, and links to its runs.

The points come in four lists:

- **For the provider**: the provider's points.
- **Accepted deviations**: the finding is classified *provider deviation* and
  resolved, or the run met a status baselined as a known deviation. The
  capability then reads *Passed with deviation*.
- **Questions on the specification**: the finding is a *spec question*.
- **OSCAR's own points**: the finding is an *OSCAR issue*, the suggested
  finding was marked as OSCAR's, or the check is OSCAR's own request check.
  These do not count against the provider.

Below the points, two folded lists:

- the declared functions no scenario run tests;
- the scenarios set apart: neither in the run list nor run, such as copies
  made twice.

**The other two views.** *By flow and element* and *By function declared* are
the detail behind it: one row per element a flow tests, and one per function
the Test Framework declares, with their scenarios (folded).

**Exports.** *Export Markdown* and *Download Excel* save the same report in
the same order: the capabilities, the expected refusals and the points to look
at first, then the two detailed views. The workbook has seven sheets: Summary,
Capabilities, Expected refusals, Points to look at, By flow and element, By
scenario, By function.

### Published coverage reports (Test Managers and certifiers)

A Test Manager can **publish** the coverage shown, with *Publish this
report*. A published report is numbered (1, 2, 3… for each company or
provider) and frozen: later runs do not change it. To correct one, publish
a new one.

In the **Published Coverage Reports** card:

- **Share with the certifier** gives the certifier the report and every run
  it reads. A report is shared once.
- **Withdraw** takes a shared report away from the certifier. The report
  stays in the list, marked withdrawn, and its runs stay shared; unshare a
  run on its own page if needed. Sharing and withdrawing are recorded in the
  audit log.
- **View** shows the report as it was published. **Excel** downloads it.

**What changed.** Each report is compared with the last report shared with
the certifier and not withdrawn, at the moment it is published:

| Change | Meaning |
|---|---|
| Fixed | A point of the previous report is gone, and its tests were run again. |
| Still open | A point of the previous report is seen again. |
| New | A point the previous report did not have. |
| Not run again | A point of the previous report is gone, but its tests were not run again: nothing can be said of it. |

The capabilities whose result changed are listed too. In the workbook, this
comparison is the second sheet, *Since report N*.

Only Test Managers publish and read the published reports: a report holds
every scenario, testers' private ones included.

**Certifiers** see, in the same card, the reports companies have shared with
them: whose they are, when they were published and shared, the report, what
changed, and the workbook. They also read the runs of a shared report. They
see no e-mail address of the company's users.

---

## 7. Reference tables

### 7.1 Scenario parameters → where they go

| Parameter | Values | Affects request |
|---|---|---|
| Scenario type | `SALE` / `REFUND` / `EXCHANGE` | Which flow runs |
| Origin / Destination | station URN | `POST /offers` trip |
| Departure date | dynamic (`%TRIP_DATE%`) | `POST /offers` `departureTime` |
| Return offset (days) + return time | `0,1,2…` + `HH:MM` | `offerSearchCriteria.inboundDate` (3.7+) or `returnSearchParameters.inwardReturnDate` |
| Return model | separate directions / both directions in one offer | inbound call: `returnSearchParameters.outwardOfferIds` / `.outboundTripIds` |
| Return fulfillments | not checked / one / per direction / per passenger | check after confirmation |
| Currency | `EUR`, … | `offerSearchCriteria.currency` |
| Service class | `STANDARD` `BEST` `HIGH` `BASIC` `ANY_CLASS` | `offerSearchCriteria` |
| Travel class | `FIRST` `SECOND` `ANY_CLASS` | `offerSearchCriteria` |
| Travel class per leg | `FIRST, SECOND`, one per leg | `offerSearchCriteria.travelClasses`; which offer is chosen; checked on the booking |
| Requested offer parts | `ADMISSION` `RESERVATION` `ANCILLARY` `FARE_*` `CONTINUOUS_SERVICE` `ALL` | `offerSearchCriteria` |
| Flexibility | `FULL_FLEXIBLE` `SEMI_FLEXIBLE` `NON_FLEXIBLE` | `offerSearchCriteria` |
| Expected product | a product code, or words of its name | which offer is chosen; checked on the booking |
| Expected product absent | `off` / `on` | negative test: no offer may hold the product |
| Refund receipt wait (min) | `1`–`60` (optional) | after the refund, reads `GET /bookings/{id}` until a receipt (type `INFORMATION`) appears; none within the wait fails |
| Idempotency-Key test | `off` / `on` | `Idempotency-Key` on the booking and the confirmation, each sent again with the same key |
| Offers by trip id | `off` / `on` | `POST /trips-collection` first, then `POST /offers` with `tripIds` (one-way SEARCH trips) |
| Unknown trip id refused | `off` / `on` | negative test: `POST /offers` with a trip id never given must be refused |
| Offer mode | `INDIVIDUAL` `COLLECTIVE` | `offerSearchCriteria` |
| Overrule code | the codes the Test Framework declares (§4.10) | refund/exchange request |
| Sales‑flow actions | patchPassengers, placeSelection, addAncillary, getBooking, deleteAncillary | inserts the matching step |
| Seat‑selection mode | `SEATMAP_AT_OFFER` / `ADD_TO_BOOKING` | seat‑map step + `placeSelections` |
| Passenger type | `PERSON` `BICYCLE` `DOG` `PRM` … | passenger specs |
| Fulfillment type / media | `ETICKET`… / `PDF_A4`… | `requestedFulfillmentOptions` |
| `requestedInformationProbe` | `off` / `omit` / `invalid` | passenger‑info auto‑feed *or* a negative probe (§4.8) |
| `bookingPurchaserMode` | `inline` / `deferred` / `omit` / `invalid` | where the purchaser is sent + negative probe (§4.8) |
| `expiredBookingTest` | `off` / `on` | wait past the effective confirmation deadline (booking‑root `confirmationTimeLimit` / `confirmableUntil`, or the earliest part‑level `confirmableUntil`), assert rejection (§4.8) |
| `expiredBookingMaxWaitMinutes` | `1`–`60` (optional) | per‑scenario wait budget for `expiredBookingTest`; auto‑extends the worker SIGTERM, clamped at `RUN_HARD_MAX_TIMEOUT_MS` (§4.8) |
| `expiredOfferTest` | `off` / `on` | wait past the earliest `OfferPart.validUntil`, assert `POST /bookings` is rejected (§4.8) |
| `expiredOfferMaxWaitMinutes` | `1`–`60` (optional) | per‑scenario wait budget for `expiredOfferTest`; auto‑extends the worker SIGTERM, clamped at `RUN_HARD_MAX_TIMEOUT_MS` (§4.8) |
| `expiredAddReservationOfferTest` | `off` / `on` | wait past the reservation-part `validUntil`, assert `09. POST Add Reservation` is rejected (§4.8). ADD_TO_BOOKING scenarios only |
| `expiredAddReservationOfferMaxWaitMinutes` | `1`–`60` (optional) | per‑scenario wait budget (§4.8) |
| `expiredAddAncillaryOfferTest` | `off` / `on` | wait past the earliest ancillary-part `validUntil`, assert `10. POST Add Ancillary` is rejected (§4.8). Add-ancillary scenarios only |
| `expiredAddAncillaryOfferMaxWaitMinutes` | `1`–`60` (optional) | per‑scenario wait budget (§4.8) |
| `expiredRefundOfferTest` | `off` / `on` | wait past `RefundOffer.validUntil`, assert `13. PATCH Refund Offer` is rejected (§4.8). REFUND scenarios only |
| `expiredRefundOfferMaxWaitMinutes` | `1`–`60` (optional) | per‑scenario wait budget (§4.8) |
| `expiredExchangeOfferTest` | `off` / `on` | wait past `ExchangeOffer.preBookableUntil` *(spec-naming quirk)*, assert `11. POST Exchange Operations` is rejected (§4.8). EXCHANGE scenarios only |
| `expiredExchangeOfferMaxWaitMinutes` | `1`–`60` (optional) | per‑scenario wait budget (§4.8) |
| `partialRefundByLeg` | `off` / `on` | scope refund to one leg via `RefundSpecification.bookingPartIds` (§4.9). REFUND scenarios only |
| `partialRefundLegSelection` | `first` / `last` / `outbound` / `inbound` | which leg (§4.9) |
| `partialRefundByPax` | `off` / `on` | scope refund to one passenger via `RefundSpecification.passengerIds` (§4.9). REFUND scenarios only |
| `partialRefundPaxSelection` | `first` / `last` | which passenger (§4.9) |
| `loggingType` | `FULL` / `INFO` / `DEBUG` / `ERROR` | execution‑log verbosity (§4.11) |

### 7.2 Sale‑flow step → OSDM request

| Step (collection) | OSDM call |
|---|---|
| `01 POST Get Offer` | `POST /offers`; with offers by trip id, `POST /trips-collection` first |
| `01b POST Get Return Offer` | `POST /offers` (inward leg) |
| `08 GET Place Maps` | `GET /availabilities/place-map?contextType=OFFER` |
| `08b GET Place Map Post-Booking` | `GET /availabilities/place-map?contextType=BOOKING` |
| `02 POST Create Booking` | `POST /bookings` |
| `06b GET Fulfillment` | `GET /fulfillments/{id}`, once per fulfillment |
| `14b GET Booking Refund Receipt` | `GET /bookings/{id}`, every 15 s until the refund receipt appears |
| `09 POST Add Reservation` | `POST /bookings/{id}/booked-offers/{id}/{offer-parts\|reservations}` |
| `03 PATCH Multi Passenger` | `PATCH …/passengers` |
| `06 POST Fulfillments` | `POST /fulfillments` |

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `400 "Invalid request content"` on `POST /offers` | `offerSearchCriteria: {}` empty (no currency) on a strict vendor | Add a **currency** to the scenario's offer criteria. |
| `400` with `resourceId=%7B%7BreservationId%7D%7D` in the place‑map URL | The offer had **no reservation part**, so `reservationId` was empty | Use a train/class that includes a reservation; or expect the seat map to be skipped as "not applicable". |
| `400 "Invalid request content"` on `POST /bookings` after a seat pick | Malformed `placeSelections.places[]` | Should be fixed (OSDM `SelectedPlace = {coachNumber, placeNumber, passengerRef}`). If it recurs, capture the booking body and report it. |
| Intermittent `500`, same request sometimes works | Vendor **fragile under parallel load** | Lower the company **concurrency limit** to 1. |
| `501 parameter_not_supported` | Vendor conformantly **declines an optional capability** (e.g. no BOOKING‑context map) | Expected; the adaptive fallback continues. It's a capability finding, not a bug. |
| A step **passes** with `… not implemented by this provider (auto-detected)` plus an `[INFO]` or `[WARNING]` line | The vendor doesn't implement an **optional** endpoint (System-Info catalogs, GET Passenger, GET Refund/Exchange Offer) | Expected — nothing to fix in OSCAR. If the line is a `[WARNING]` (bare 403/405/500), ask the vendor to answer 404 or 501 with an OSDM Problem body. A `401` on the same step is a token problem and still fails. |
| `[WARNING] confirmedPrice absent at booking stage` REFUNDED / EXCHANGED | The vendor's booking omits `confirmedPrice` after a refund or exchange | A warning since 1.11.248 (#661): OSDM does not require the member, and after a full refund it would hold only what is still confirmed. Before the refund it is still required. |
| Seat map step (`08`) **missing** from the report on a `SEATMAP_AT_OFFER` scenario | The scenario's **mode wasn't actually saved** (stale value), so it ran `ADD_TO_BOOKING` | Open the scenario, click the **Seat map at offer** pill, save, re‑run. |
| Many "failed" assertions on `200` responses | OSDM **compliance** deviations in the vendor's responses | These are the conformance findings — review them; they're the point of the tool. |
| Test Config shows **❌ Error: … could not be loaded …** instead of the editor, or the scenario wizard answers **The scenario was not generated** | OSCAR could not read what is stored (connection lost, server busy, rate limit). It stops there on purpose: carrying on from an empty page could replace the stored configuration | **Reload the page.** Nothing was changed. If it keeps happening, wait a minute and try again, and report the reason shown in the message. |
| A red notification appears in Test Config after **Refresh**, deleting a train or **Save all trains** | The action failed, and the notification gives the reason (for example "The test configuration could not be loaded"). Before 1.11.204 such a failure showed nothing | **Reload the page and try again.** The page kept what it had. If it keeps happening, report the reason shown. |
| Saving in Test Config answers **This text contains "{{" and cannot be saved** | A scenario, or one of its trips, passengers, purchasers or fulfillment options, holds two opening curly braces. The test engine reads what follows them as the name of a variable and puts that variable's value in its place. | Remove the `{{` from the place named in the message, then save again. A single `{` is fine. |
| Every run fails at once with **This run was not started: the data file holds text that contains "{{"** | The same, in text stored in your company's data file before this rule existed. The test engine reads the whole data file before every run, so one such text stops every run of the company. Nothing was sent to the provider. | The message says where. If it is in one of your scenarios, open it in Test Config, remove the `{{` and save. If the message says the text is in a part of the data file that you cannot see, ask your Test Manager, whose own run says where. |

---

## 9. Testing OSCAR with the OSDM simulator

The OSDM simulator is a test provider made for OSCAR. It answers like a real
OSDM system, and it can answer **with errors chosen on purpose**, to check
that OSCAR sees them. Its installation is in
[OSCAR - OSDM Simulator](../Server_Operations/OSCAR%20-%20OSDM%20Simulator.md);
this section is how a Test Manager uses it.

### 9.1 The simulated providers

| Provider | OSDM version | Endpoint |
|---|---|---|
| `alpha` | 3.6.0 | `https://<simulator-host>/alpha` |
| `beta` | 3.7.0 | `https://<simulator-host>/beta` |
| `gamma` | 3.8.0 | `https://<simulator-host>/gamma` |
| `delta` | 3.9.0 | `https://<simulator-host>/delta` |
| `epsilon` | 3.10.0 | `https://<simulator-host>/epsilon` |
| `zeta` | 3.12.0, in development (follows the OSDM `master` branch) | `https://<simulator-host>/zeta` |

All of them offer the same functions; each answers in the shapes of its own
OSDM version. Ask your OSCAR administrator for the simulator's address and
for a client id and secret per tester (the simulator keeps them in its
`clients.json`).

### 9.2 Setting up a company for the simulator

Use a company, or a provider of your company (§2.1), made **only** for the
simulator: the steps below replace its scenarios, Test Framework and Test
Data.

1. **API Config**: the endpoint of the provider (table above); each tester
   enters the OAuth2 credentials: token URL
   `https://<simulator-host>/<provider>/oauth/token`, their client id and
   secret, scope empty.
2. **Test Config → 🔗 Reference configuration** (since 1.11.335): choose
   `simulator-alpha`, `simulator-beta`, `simulator-gamma`, `simulator-delta`,
   `simulator-epsilon` or `simulator-zeta`, then
   **Update from the reference**. OSCAR fills in the scenarios, the Test
   Framework, the Test Data and the run list of that provider. The endpoint
   and the credentials are not touched; the replaced data file can be got
   back with *Restore previous file*.
3. When the simulator's scenarios change in the repository, Test Config and
   the **New Run** page say the configuration is **not up to date**. Press
   **Update from the reference** again.

### 9.3 A normal run

Run the run list as usual (§5). The expected result of every scenario, its
checks and its warnings, is in
[OSCAR - OSDM Simulator scenarios](../Server_Operations/OSCAR%20-%20OSDM%20Simulator%20scenarios.md).
A failure there that the page does not list is OSCAR's or the simulator's to
look at, never a provider's.

### 9.4 Tests with errors (faults on demand)

The simulator can break one kind of answer on request, for example a booking
that loses a passenger or a refund that gives back too much. Each fault has a
code, and OSCAR is expected to report it at a known step (the table of codes
and expected checks is in
[OSCAR - OSDM Simulator § 6b](../Server_Operations/OSCAR%20-%20OSDM%20Simulator.md#6b-faults-on-demand-833)).
The bookings the simulator keeps are not changed, only the answers.

Three ways to ask for faults:

- **Ready-made scenarios** (gamma): the data file holds one scenario per
  fault, `SIM_FAULT_<CODE>_38` (for example
  `SIM_FAULT_BOOKING_PASSENGER_DROPPED_38`). They are not in the run list,
  because they fail on purpose: tick the ones you want in the run list in
  Test Config, then start the run from **New Run**.
- **On a scenario of your own**: in Test Config, open the scenario and fill in
  **Simulator faults** with one or more codes separated by commas, for
  example `offer.price-below-parts, booking.passenger-dropped`. Every request
  of that scenario then asks the simulator for those faults. Leave the field
  empty on a scenario meant for a real provider; a real provider never
  receives it anyway when it is empty.
- **For a whole provider**: a tester puts `sim-faults:code,code` in the
  **scope** field of their API Config. Every request made with that token is
  then faulty. Do this on a second provider of your company (for example
  "Gamma (faults)") pointing at the same endpoint, so that the normal one
  stays clean.

A code the simulator does not know is refused (HTTP 400 `UNKNOWN_FAULT`, or
`invalid_scope` when the token is asked), so a typing mistake shows as an
error and never as "OSCAR detected nothing".

### 9.5 Did OSCAR see the faults?

1. Open **AI Analysis**, choose the batch, and press **Faults detected in this
   batch**. For each fault a run asked for, OSCAR says whether it was
   detected (every expected check seen, some, or none) and which checks it
   saw. No AI service is called for this.
2. If your company uses the AI analysis (menu **AI Analysis**), analyse the same
   batch, then press **Score against the simulator's faults** under the
   result: for each fault OSCAR failed, it says whether the analysis
   explained it (the provider named as owner, at the right step), blamed
   someone else, or missed it. Analysing the same batch with two models gives
   two scores to compare.

A fault that OSCAR reports only as a WARNING is shown as detected but is not
scored: the AI analysis sees the warnings, but is scored on the failures only.


## Glossary

- **OSDM** — Open Sales and Distribution Model (the rail retailing API standard).
- **Offer / Booking / Fulfillment** — the three OSDM sale stages.
- **Admission / Reservation / Ancillary** — kinds of *offer part* (the ticket,
  the seat, the extras).
- **Trackable assertion** — a deliberately‑failing check used to flag a vendor
  capability gap so it's easy to filter in the report.
- **Adaptive fallback** — OSCAR automatically takes an alternate path when a
  vendor rejects the spec‑preferred one (e.g. seat after booking; two bookings
  for a round trip).
