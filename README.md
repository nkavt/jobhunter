# jobhunter

AI-powered CLI that discovers job feeds matching your CV, normalises listings from any source, and tracks them in a Google Sheet so you never see the same job twice.

> 🚧 Early development: commands are being built one by one.

## Install

```sh
npm install -g jobhunter
```

Requires Node.js 20 or newer.

## Commands

| Command                      | What it does                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `jobhunter init`             | Set up Claude, import your CV, answer a few questions and connect Google Sheets |
| `jobhunter discover`         | Let the AI find new job feeds that match your profile                           |
| `jobhunter hunt`             | Fetch all saved feeds, skip known jobs, and add new ones to your sheet          |
| `jobhunter map <source>`     | Generate a field mapping for a job feed sample                                  |
| `jobhunter convert <source>` | Convert a job feed to the canonical format using its saved mapping              |
| `jobhunter sync`             | Apply "Change status" picks from the status tabs to the master sheet            |

## Development

```sh
npm install
npm run build        # bundle to dist/ with tsup
npm link             # make `jobhunter` available globally from this checkout
npm test             # vitest
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run format       # prettier
```

## License

MIT
