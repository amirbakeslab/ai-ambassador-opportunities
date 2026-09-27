# Maintaining the catalog

The Google Sheet is the published catalog. Public users can view it but not edit it. Maintainers edit it either directly in Google Sheets or through the commands below.

## Credentials

Automated edits use a dedicated Google service account with Editor access to this spreadsheet only, and the Google Sheets API enabled. Keep its key file outside any repository, readable only by you (`chmod 600`):

```sh
export AMBASSADOR_GOOGLE_CREDENTIALS=/secure/path/service-account.json
# or a short-lived token from an account that can edit the Sheet:
export AMBASSADOR_GOOGLE_ACCESS_TOKEN="$(gcloud auth print-access-token)"
```

Student commands never read these. `ambassador doctor` warns if the key file is readable by other users.

## Publishing changes

```sh
ambassador review candidate.json --output changes.json    # validate and show the diff
ambassador sync --dry-run --changes changes.json          # compare with the Sheet as it is now
ambassador sync --apply --changes changes.json --sheet-id <spreadsheet-id>
ambassador backup                                         # Opportunities and Sources tabs
ambassador restore <backup.json> --dry-run
ambassador restore <backup.json> --apply --sheet-id <spreadsheet-id>
```

Writes always need an explicit `--sheet-id` (or `AMBASSADOR_SHEET_ID`). For a public copy without credentials, use `ambassador export`.

What sync guarantees:

- Records are matched by Opportunity ID. Sync never changes an ID or deletes a row. To retire an entry, set its status to Closed or Historical.
- A reviewed change is written only if the Sheet still holds the value it was reviewed against. If someone edited that cell since, sync stops and writes nothing. Changesets older than 14 days need `--allow-stale`.
- Only cells that change are written. Text is written literally, so it never becomes a formula.
- Before writing, sync checks the Sheet's protected ranges and names any cell the current account cannot edit.
- Before changing any cells, sync saves a backup (default `./ambassador-backups`). It then writes all changes in one request and reads every value back. Running the same changeset again changes nothing, so it makes no backup.

**Use one sync writer at a time.** Google Sheets cannot lock cells. An edit made between sync's final check and its write goes undetected, and the local lock only covers one computer. Pause direct edits while a sync runs.

## Routine care

- Check deadlines weekly and other entries monthly. When you verify a program's facts against its sources, update **Last checked** and the Sources tab. Wording-only edits do not change Last checked.
- **Rotating credentials:** create a new key, point the environment at it, check with `sync --dry-run`, then delete the old key in Google Cloud.
- **Removing an editor:** remove their Sheet access. If they held a service-account key, rotate it.
- **Handing off ownership:** transfer the Sheet in Google Drive, confirm the protected ranges (header rows and the ID column) and sharing settings, and re-share the service account if needed.

## Development

```sh
npm install
npm test            # offline tests, including a local stand-in for the Sheets API
npm run typecheck
npm run compile     # commit the updated dist/ with source changes; CI checks they match
```

GitHub installs copy the committed `dist/` and build nothing. Do not add `build`, `prepare` or install scripts: npm runs them for Git installs, and that breaks global installs and upgrades. A test guards this.

`npm run test:live` runs the Google Sheets tests against a disposable copy of the catalog. Set `AMBASSADOR_TEST_SHEET_ID` to the copy and `AMBASSADOR_GOOGLE_CREDENTIALS` to credentials that can edit it. The tests refuse to write to the published catalog and restore the copy when they finish.

`npm run snapshot` (after `npm run compile`) refreshes the offline snapshot bundled in `data/` from the public feed.
