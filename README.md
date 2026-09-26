# AI Ambassador Opportunities

A command-line tool for browsing, researching and proposing student ambassador, campus-leader and community programs run by AI, developer-tool and cloud companies.

The catalog lives in a public Google Sheet, which is the authoritative copy. The CLI reads the Sheet's published CSV feed. Browsing needs no Google account and no API keys.

- **Catalog (view only):** https://docs.google.com/spreadsheets/d/1TKibIwQrSLoJOYSswXYuqfRsFrkRyVIsqiw4F6dp-Rc/edit
- **Published feed:** the Sheet's Opportunities tab, published as CSV (see `src/config.ts`)

The default catalog was compiled for students at the University of Pittsburgh, so it includes a "Pitt applicability" column. Listing a program does not mean a partnership with, or endorsement by, any company or university.

## Install

Requires Node.js 22 or newer.

```sh
npm install -g github:amirbakeslab/ai-ambassador-opportunities
ambassador --help
```

Or run it once without a global install:

```sh
npx github:amirbakeslab/ai-ambassador-opportunities list
```

The package is not published to the npm registry. Both commands install it straight from this repository, which includes the compiled `dist/` output, so nothing is built during installation.

## Browse the catalog

```sh
ambassador list                             # all entries, including closed and historical ones
ambassador list --status rolling            # one status; comma-separate several
ambassador list --open                      # Rolling, Registration available, Interest form available
ambassador list --assessment "worth considering" --company microsoft
ambassador list --text "stipend"            # word search across every field
ambassador show anthropic-campus-2026       # full record and its source URLs
ambassador export --format csv --output opportunities.csv
ambassador export --format json --status closed
ambassador doctor                           # checks feed, cache, keys (presence only) and formatters
```

Every listing states where its data came from and when that copy was fetched:

| Origin | When it is used |
| --- | --- |
| Live published feed | Default. The CSV is fetched and cached. |
| Cached copy | Reused for 15 minutes, and used when the network is down or with `--offline`. Shows the original fetch time. |
| Bundled snapshot | Used only when there is no cache and the feed is unreachable. Labelled as possibly out of date. |

`--refresh` always fetches the live feed and fails instead of falling back. Google can take a few minutes to republish after a Sheet edit. Fetch time is separate from each record's **Last checked** date, which is when a person last verified the program's source pages.

## Data definitions

| Column | Meaning |
| --- | --- |
| Opportunity ID | Stable lowercase slug. Tools match records by ID, never by row number. |
| Company, Program, Category, Description | What the program is. |
| Application status | One of: Rolling, Registration available, Interest form available, Future interest only, Closed, Historical, Needs verification, Invitation only. |
| Assessment | Editorial judgement: Worth considering, Needs clarification, Low value, Not a student role. |
| Assessment reason | Why that assessment was given. |
| Application / program URL | Official application, interest form or program hub. A working Apply button does not prove a current intake. |
| Deadline | Exact date only when a source states one. **Blank means unknown, not rolling.** |
| Deadline / intake notes | Time zones, windows and caveats. |
| Program dates / duration, Time commitment | Approximate periods stay as text. |
| Ambassador benefits | Benefits for the individual ambassador. |
| Benefits for students / club | Benefits for other students or the club. Personal credits are not campus-wide benefits. |
| Expectations, Eligibility, Geography, Restrictions / exclusivity | Obligations and limits. |
| Pitt applicability | Local fit for the catalog's original audience. |
| Source IDs | Keys into the Sheet's Sources tab, which maps each ID to a URL and what it supports. |
| Last checked | Date a person last reviewed the sources. |

## Research new programs (optional, uses your own keys)

Search and page fetching use **your own** API keys, set in your own shell. The tool never ships, stores or prints key values. `doctor` reports only whether each key is set.

```sh
export EXA_API_KEY=...          # default search provider   https://exa.ai/pricing
export FIRECRAWL_API_KEY=...    # optional alternative      https://www.firecrawl.dev/pricing
export OPENROUTER_API_KEY=...   # optional formatting       https://openrouter.ai

ambassador search "AI student ambassador program"
ambassador search --provider firecrawl "campus developer programs" --limit 5
ambassador propose https://example.com/campus-program --output candidate.json
```

- Search results are leads, not verified openings. Results already in the catalog are marked.
- Free allowances are each provider's account policy and can change. This tool does not guarantee free use. Check their pricing pages.
- Each command makes at most 5 provider requests by default (`--max-requests`, `AMBASSADOR_MAX_REQUESTS`). Retries are bounded and honour `Retry-After`. When a provider reports exhausted credits or budget, the command stops. It never switches to another provider or a paid model.
- Identical search and page requests are cached for 24 hours. Use `--no-cache` to skip the cache.
- Search queries go to the provider you chose. Include only public information in them.

`propose` fetches one page and writes a local candidate JSON file. The page text is stored as evidence, with source links and fetch times. Without `EXA_API_KEY` or `--provider`, it fetches the page directly. Direct fetches refuse local and private addresses, check every redirect, connect only to the DNS answer they validated, and stop reading pages over 3 MB.

### Optional model formatting

Formatting is off by default. The no-model workflow always works: every unknown field stays `null`, for you to fill in from the evidence.

```sh
ambassador propose <url> --format-with dots     # dots-studio/dots-3-note-preview:free
ambassador propose <url> --format-with laguna   # poolside/laguna-s-2.1:free
```

- Only these two exact OpenRouter model IDs are offered. Before each use, the tool checks OpenRouter's model list and refuses a model that is missing or has any non-zero price. It never substitutes another model.
- If OpenRouter lists structured-output support for a model (currently Dots), the tool requests an enforced JSON schema. Other models (currently Laguna) are prompted for JSON, and the tool validates the output itself.
- Model output is untrusted. Any value whose content is not found in the page text is discarded. So is a deadline date that does not appear on the page. Invalid output leaves a reviewable candidate with the raw response attached.
- Models never set the status, assessment or local applicability. Maintainers decide those.

## Contributing

Anyone can suggest additions or corrections. Nothing is posted automatically on your behalf.

1. Run `ambassador propose <official-url> --output candidate.json`, or write a correction by hand.
2. Check the candidate against the source page. Fill in facts you verified and leave the rest `null`.
3. Open an issue with the "Program proposal" template and paste the candidate JSON. You can also open a pull request that adds the file under `proposals/`.

Only official program pages or clearly identified recruitment partners count as sources. Do not include personal contact details, application answers or private discussions.

## Maintainers

Public users have view-only access to the Sheet and cannot change it. Maintainers edit through their own Google permissions:

- **People** edit the Sheet directly in Google Sheets.
- **Automation** uses a dedicated service account that has Editor access to this spreadsheet only. It needs no project IAM roles, and the Google Sheets API must be enabled.

Keep the key file outside any repository, readable only by you (`chmod 600`), and pass its location through the environment:

```sh
export AMBASSADOR_GOOGLE_CREDENTIALS=/secure/path/service-account.json
# or a short-lived token from an account with edit access:
export AMBASSADOR_GOOGLE_ACCESS_TOKEN="$(gcloud auth print-access-token)"
```

Student commands never load these credentials. Never run privileged automation on untrusted pull-request code.

### Workflow

```sh
ambassador review candidate.json --output changes.json   # validate and show a precise diff
ambassador sync --dry-run --changes changes.json         # compare with the current Sheet
ambassador sync --apply --changes changes.json --sheet-id <spreadsheet-id>
ambassador backup                                        # full backup of Opportunities and Sources
ambassador restore <backup.json> --dry-run
ambassador restore <backup.json> --apply --sheet-id <spreadsheet-id>
```

How sync protects the catalog:

- **Stable IDs.** Records are matched by Opportunity ID. Sync never changes an ID and never deletes a row. Retire an entry by setting its status to Closed or Historical.
- **Manual edits win.** A changeset records each field's reviewed value. A field is written only if the Sheet still holds that value. If the Sheet already has the new value, nothing is written. Anything else is a conflict, and the whole sync stops without writing.
- **Only changed cells are written.** Updates to existing records touch only the cells that change. Protected ID and header cells are never rewritten.
- **Protected ranges are checked first.** Sync reads the Sheet's protection metadata. If a write would touch a range the current principal cannot edit, sync stops before any backup or write and names the cells. For example, adding a record writes the protected Opportunity ID column. The owner must either allow the maintainer on that range or add the row by hand.
- **Backups and verification.** Every apply saves a local backup first (default `./ambassador-backups`; change it with `--backup-dir` or `AMBASSADOR_BACKUP_DIR`). It then re-reads the Sheet and stops if anything changed during planning. All changes go in one `spreadsheets.batchUpdate` call, which Google applies completely or not at all. Afterwards, sync reads every written value back to confirm it.
- **Literal values.** Text is written as typed string values, so `=`, `+`, `@` and `-` prefixes never become formulas. Dates are written as date serials. CSV exports prefix formula-like cells with `'`.
- **Idempotent.** Re-running the same changeset writes nothing.

**Use one designated sync writer.** Google Sheets has no compare-and-swap. An edit that lands between sync's final re-read and its write is not detected. The local lock only prevents two syncs on the same computer. Pause direct edits while a sync runs. If you ever need several writers, move publication to a single serialized service.

### Routine care

- Check deadlines weekly and other entries monthly. Update **Last checked** and the sources whenever you edit.
- **Rotate credentials:** create a new service-account key, update the local path, test with `sync --dry-run`, then delete the old key in Google Cloud.
- **Remove an editor:** remove their Sheet access. If they held a service-account key, rotate it.
- **Hand off ownership:** transfer Sheet ownership in Google Drive. Confirm the protected ranges (headers and the ID column) and sharing settings, then re-share the service account if needed.

## Development

```sh
npm install
npm test            # offline suite, including a local Sheets API stand-in
npm run typecheck
npm run build       # commit the updated dist/ with source changes; CI checks they match
```

`npm run test:live` runs the live Google Sheets tests. They run only against a disposable copy of the catalog: set `AMBASSADOR_TEST_SHEET_ID` to the copy and `AMBASSADOR_GOOGLE_CREDENTIALS` to credentials with Editor access to it. They refuse to write to the published catalog and restore the copy when they finish.

`node scripts/update-snapshot.mjs` (after a build) refreshes the bundled offline snapshot from the public feed.

## Sources and attribution

Program facts summarise public pages from each program's official site or a clearly identified recruitment partner. These pages are listed in the Sources tab of the Sheet and shown by `ambassador show`. Assessments and reasons are editorial opinions. Program names and trademarks belong to their owners. Always confirm details on the official page before applying.

## License

Code: MIT (see `LICENSE`).
