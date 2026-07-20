# ask-chat-cli

Bring ChatGPT and Gemini into your terminal—no API keys required.

`ask` uses a dedicated, signed-in Chrome profile to send prompts, attach files, continue conversations, and return clean output for shell pipelines.

## Why use it?

Use your existing web-chat allowance for everyday LLM tasks and reserve coding-agent usage for work that needs repository context, file edits, and tools.

- Ask questions, brainstorm, rewrite, and summarize from the terminal
- Avoid consuming coding-agent usage for simple prompts
- No API keys, SDK setup, or per-token API billing
- Pipe responses into files and other commands
- Continue the same conversation in your browser

Messages still count toward your ChatGPT or Gemini web-chat limits.

## Requirements

- Node.js and npm
- Google Chrome
- A ChatGPT or Gemini account
- Windows, macOS, or Linux

## Install

```console
git clone https://github.com/julianchun/ask-chat-cli.git
cd ask-chat-cli
npm install
npm run build
npm link
```

## First run

Windows detects common Chrome installation paths automatically. On macOS or Linux, set the Chrome executable first:

```sh
# macOS
export ASK_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Linux—adjust for your distribution
export ASK_CHROME_PATH="/usr/bin/google-chrome"
```

Run `ask login` to open Chrome with a dedicated `ask` profile:

```console
ask login
```

Sign in to ChatGPT in the browser window. The dedicated Chrome profile preserves that login and is reused by later commands, so you normally only need to sign in once.

After signing in:

```console
ask "Explain why the sky is blue"
```

For Gemini, open its login page and sign in the same way:

```console
ask --provider gemini login
ask --provider gemini "Explain why the sky is blue"
```

## Commands

| Command | Purpose |
| --- | --- |
| `ask [prompt...]` | Send a prompt and wait for the response; reads stdin when omitted |
| `ask login` | Open the dedicated Chrome profile for sign-in |
| `ask open [url\|prompt...]` | Open a conversation or fill a prompt in the visible browser |
| `ask get` | Print the latest response from the current provider page |
| `ask dump` | Print or save the current provider page HTML |
| `ask screenshot` | Save a screenshot of the current provider page |
| `ask status` | Show provider, browser, login, and readiness status |
| `ask conversations list` | List locally named conversations |
| `ask conversations forget <name>` | Forget a local name without deleting the provider chat |

### Options

| Option | Applies to | Purpose |
| --- | --- | --- |
| `--provider <chatgpt\|gemini>` | All commands | Select the web-chat provider |
| `-a, --attach <file>` | Prompt, `open` | Attach a file; repeat for multiple files |
| `-o, --output <file>` | Prompt, `get`, `dump`, `screenshot` | Write output to a file |
| `--new` | Prompt, `open` | Start a new conversation; this is the default |
| `--continue` | Prompt, `open` | Continue the previous conversation |
| `--conversation <name>` | Prompt, `open` | Resume a named conversation, or create it if missing |
| `--send` | `open` | Submit the filled prompt and wait for completion |
| `--headless` | Prompt, `get`, `dump`, `screenshot` | Run the managed Chrome session headlessly |
| `--timeout <ms>` | All commands | Set the operation timeout |
| `-v, --verbose` | All commands | Print browser and session details |
| `-V, --version` | Top level | Print the CLI version |
| `-h, --help` | All commands | Show command help |

Run `ask --help` or `ask <command> --help` for the generated reference.

## Named conversations

Use names for recurring workflows that should keep separate context:

```console
git diff | ask --conversation code-review "Review these changes"
ask --conversation release-notes "Draft notes for the next release"
ask --provider gemini --conversation research "Continue the comparison"
```

The first use creates a provider conversation and saves its URL locally. Later uses resume that conversation. Names are lowercase, provider-specific, and may contain letters, numbers, dots, underscores, or hyphens.

Start over while keeping the same name with `--new`:

```console
ask --conversation release-notes --new "Plan the next release"
```

Inspect or forget local mappings:

```console
ask conversations list
ask conversations list --provider chatgpt --json
ask conversations forget release-notes --provider chatgpt
```

Forgetting a name does not delete the conversation from ChatGPT or Gemini. `--continue` still resumes the most recently used unnamed or named conversation for backward compatibility.

When creating a name through `ask open`, include `--send`; the provider must create a conversation URL before `ask` can save the name. Existing named conversations can be opened without sending.

## Parallel execution

Prompt commands may share one Chrome profile and remote-debugging port while running in parallel:

```console
ask --conversation research-a "Compare option A" >a.txt &
ask --conversation research-b "Compare option B" >b.txt &
wait
```

`ask` allows four active prompt executions and four waiting executions. A ninth request fails immediately. Waiting requests use a global FIFO queue and time out after five minutes; this queue wait is separate from `--timeout`, which starts after execution begins.

Each execution uses a fresh temporary tab and closes it afterward. Requests using the same provider and conversation name run sequentially. `--continue` waits for all active work for that provider so the meaning of “previous conversation” remains deterministic. Login and Chrome visibility-mode changes are rejected while prompt executions are active.

## Output

Interactive runs show the provider, elapsed time, and conversation URL before the response:

```console
$ ask --continue "Summarize that explanation in one sentence"
✓ ChatGPT · continued · 2.4s
↗ https://chatgpt.com/c/example

The sky appears blue because Earth's atmosphere scatters shorter blue wavelengths of sunlight more strongly than longer red wavelengths.
```

Responses go to stdout while progress and session details go to stderr, so pipelines stay clean:

```console
ask "Return JSON" | jq
git diff | ask "Review this diff" -o review.md
```

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `ASK_PROVIDER` | Default provider: `chatgpt` or `gemini` |
| `ASK_CHROME_PATH` | Path to the Chrome executable |
| `ASK_HOME` | State and browser-profile directory; defaults to `~/.ask` |
| `ASK_REMOTE_DEBUGGING_PORT` | Chrome debugging port; defaults to `9222` |

Command-line options override environment defaults.

## Sessions and privacy

`ask` keeps login state in its own Chrome profile under `~/.ask/chrome-profile` on macOS/Linux or `%USERPROFILE%\.ask\chrome-profile` on Windows. Named conversation URLs are stored in `~/.ask/conversations.json` or its Windows equivalent. It never copies or reuses your normal Chrome profile.

Prompts and attachments are sent to the selected provider. Treat the ask home directory as sensitive and do not commit it.

## Troubleshooting

- Run `ask status` for a quick readiness check or `ask status --verbose` for details.
- Run `ask login` again if the provider is signed out.
- If port `9222` is already in use, set a different `ASK_HOME` and `ASK_REMOTE_DEBUGGING_PORT`.

## Development

```console
npm test
npm run typecheck
npm run build
npm run test:browser
```

`npm run test:browser` requires `ASK_CHROME_PATH` and runs isolated pages in a real Chrome process over one debugging port. The opt-in `ASK_LIVE_TEST=1 npm run test:live:parallel` command sends six real ChatGPT prompts, creates provider conversations, and consumes account usage; it is intentionally excluded from the normal test suite.
