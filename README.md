# AI Ambassador Opportunities

Browse and research student ambassador, campus-leader and community programs run by AI, developer-tool and cloud companies.

The catalog is a public Google Sheet: https://docs.google.com/spreadsheets/d/1TKibIwQrSLoJOYSswXYuqfRsFrkRyVIsqiw4F6dp-Rc/edit. This command-line tool reads its published feed. Browsing needs no account and no API keys.

The catalog was compiled for University of Pittsburgh students, so it has a "Pitt applicability" column. A listing is not a partnership with, or an endorsement by, any company or university.

## Install

Requires Node.js 22 or newer.

```sh
npm install -g --install-links github:amirbakeslab/ai-ambassador-opportunities
```

Keep `--install-links`: without it, npm can leave a broken global install from a Git URL. To run it once without installing:

```sh
npx github:amirbakeslab/ai-ambassador-opportunities list
```

## Browse

```sh
ambassador list --open                      # programs with a current way to apply or register
ambassador list --status rolling --company microsoft
ambassador show anthropic-campus-2026       # full record and its sources
ambassador export --output opportunities.csv
```

Run `ambassador --help` for every filter and option.

Each listing says where its data came from and when it was fetched. The tool caches the feed for 15 minutes. If the network is down, or with `--offline`, it uses the cache or a snapshot bundled with the release. `--refresh` always fetches the live feed. Fetch time is not the same as a record's **Last checked** date, which is when a person last verified the program's sources.

Reading the catalog:

- **Application status** says whether and how you can apply now. **Assessment** is an editorial judgement of the program's value to students.
- A blank **Deadline** means no exact deadline has been confirmed. It does not mean rolling admission.
- **Ambassador benefits** go to the individual. **Benefits for students / club** go to other students or the club.
- **Source IDs** point to the Sheet's Sources tab, which lists each source's URL and what it supports.

## Research (optional)

Search and page fetching use your own API keys, set in your shell. The tool never stores or prints their values.

```sh
export EXA_API_KEY=...          # default search provider (https://exa.ai/pricing)
export FIRECRAWL_API_KEY=...    # alternative provider (https://www.firecrawl.dev/pricing)

ambassador search "AI student ambassador program"
ambassador propose https://example.com/campus-program --output candidate.json
```

- Search results are leads, not verified openings. Results the catalog already lists or cites are marked.
- Each command makes at most 5 provider requests unless you raise `--max-requests`. It stops when a provider reports exhausted credit, and never switches to another provider or a paid model. Free allowances are set by each provider and can change.
- Repeated identical requests are cached for 24 hours (`--no-cache` to skip).
- Search queries go to the provider you chose, so include only public information.

`propose` saves the page text and source link as a local candidate file; nothing is submitted. It uses Exa when `EXA_API_KEY` is set (or the provider you name with `--provider`). Otherwise it fetches the page directly, refusing local or private addresses and very large pages.

### Optional formatting

Formatting is optional; fill in missing fields from the source. With an `OPENROUTER_API_KEY`, one of two free OpenRouter models can draft the fields:

```sh
ambassador propose <url> --format-with dots     # dots-studio/dots-3-note-preview:free
ambassador propose <url> --format-with laguna   # poolside/laguna-s-2.1:free
```

The tool confirms the model is listed and free before each use, and never substitutes another model. It drops model values whose words it cannot find in the page text. That is a filter, not a guarantee, so check every value against the source. Models never set the status or assessment.

## Contributing

To suggest a program or a correction, [open a proposal issue](https://github.com/amirbakeslab/ai-ambassador-opportunities/issues/new?template=program-proposal.yml). Include the official program URL and what should change; a candidate file from `ambassador propose` is welcome but optional. Use public, official sources only, and leave out personal details. Pull requests for code are welcome.

Maintainers publish changes to the Sheet as described in [MAINTAINING.md](MAINTAINING.md).

## Sources and license

Program facts summarise public pages listed in the Sheet's Sources tab. Assessments are editorial. Program names and trademarks belong to their owners. Confirm details on the official page before applying.

Code is MIT licensed (see `LICENSE`).
