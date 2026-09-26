import { parseArgs } from 'node:util';
import { DEFAULT_SHEET_URL, TOOL_VERSION } from './config.js';
import { CliError } from './errors.js';
import { commands } from './commands.js';
const HELP = `ambassador ${TOOL_VERSION} — student AI / developer-tool ambassador programs

Browse (no account or API key needed):
  ambassador list [--status rolling] [--open] [--assessment "worth considering"]
                  [--company NAME] [--category TEXT] [--text WORDS] [--json]
  ambassador show <id> [--json]
  ambassador export [--format csv|json] [--output FILE] [list filters]
  ambassador doctor [--offline]

Research (uses your own API keys, only when you run these):
  ambassador search "AI student ambassador" [--provider exa|firecrawl] [--limit 8]
  ambassador propose <url> [--provider exa|firecrawl|direct] [--format-with dots|laguna]
                     [--output candidate.json]

Maintainers (need separate Google edit credentials):
  ambassador review <candidate.json...> [--output changes.json]
  ambassador sync --dry-run [--changes changes.json]
  ambassador sync --apply --sheet-id ID [--changes changes.json]
  ambassador backup [--sheet-id ID] [--output-dir DIR]
  ambassador restore <backup.json> --dry-run | --apply --sheet-id ID

Common options:
  --offline        use the cached copy (or bundled snapshot) without network
  --refresh        always fetch the live published feed
  --max-requests N cap provider requests for one command (default 5)
  -h, --help       show help;  -v, --version  show version

Catalog: ${DEFAULT_SHEET_URL}
`;
export async function main(argv, io = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }) {
    const [name, ...rest] = argv;
    if (!name || name === '-h' || name === '--help' || name === 'help') {
        io.out(HELP);
        return 0;
    }
    if (name === '-v' || name === '--version') {
        io.out(TOOL_VERSION);
        return 0;
    }
    const spec = commands[name];
    if (!spec) {
        io.err(`Unknown command "${name}". Run "ambassador --help".`);
        return 2;
    }
    try {
        const { values, positionals } = parseArgs({
            args: rest,
            options: { ...spec.options, help: { type: 'boolean', short: 'h' } },
            allowPositionals: true,
            strict: true,
        });
        if (values.help) {
            io.out(HELP);
            return 0;
        }
        return (await spec.run(positionals, values, io)) ?? 0;
    }
    catch (e) {
        if (e instanceof CliError) {
            io.err(`Error: ${e.message}`);
            return e.exitCode;
        }
        if (e instanceof TypeError && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS')) {
            io.err(`Error: ${e.message}. Run "ambassador ${name} --help".`);
            return 2;
        }
        io.err(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
}
