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

`ask` detects common Google Chrome installations on Windows, macOS, and Linux. Set up the dedicated Ask profile once:

```console
ask setup
```

Ask opens an ordinary Chrome window with browser automation disabled. Sign in to ChatGPT, then **fully quit that Ask Chrome instance**. Ask reopens the same dedicated profile as a managed headed Chrome session, verifies that the message box is ready, and minimizes its window. Daily prompts remain fully actionable without foregrounding Chrome, while avoiding the verification pages used by some headless browsers. Your personal Chrome profile is never copied, attached, or modified, and no extension is required.

Then run a normal prompt:

```console
ask "Explain why the sky is blue"
```

If you skip `ask setup`, the first interactive send detects the missing login, opens the same ordinary-Chrome setup flow, and resumes the original prompt after verification. Concurrent first-use sends for the same provider coordinate that setup, so only one ordinary Chrome sign-in window opens; waiting commands recheck readiness and resume their own prompt. Headless and non-interactive commands remain fail-fast because they cannot safely ask for credentials.

`ask login` remains as an alias for `ask setup`. Automatic discovery intentionally finds branded Google Chrome only. Set `ASK_CHROME_PATH` when Chrome is installed somewhere unusual or when you intentionally use another Chromium-based executable.

For Gemini, open its login page and sign in the same way:

```console
ask setup --provider gemini
ask --provider gemini "Explain why the sky is blue"
```

Gemini text-only sends use the same exactly-once coordinator as ChatGPT: Ask
selects one verified click action and never falls back to Enter or retries after
an uncertain click. Gemini attachments are intentionally unavailable for these
sends for now. `--provider gemini --attach ...` fails before dispatch because
Ask cannot yet prove that Gemini has finished processing every file; use Gemini
manually for attachment workflows.

## Commands

| Command | Purpose |
| --- | --- |
| `ask [prompt...]` | Send a prompt in a minimized headed Chrome session and wait for the response; reads stdin when omitted |
| `ask setup` | Sign in once with ordinary Chrome, then verify the dedicated profile in the background |
| `ask login` | Alias for `ask setup` |
| `ask open [url\|prompt...]` | Open a conversation or fill a prompt in the visible browser; `--send` runs it in the background |
| `ask get` | Print the latest response from the current provider page |
| `ask dump` | Print or save the current provider page HTML |
| `ask screenshot` | Save a screenshot of the current provider page |
| `ask status` | Show Chrome and readiness status for every provider |
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
| `--send` | `open` | Submit the prompt from a minimized headed Chrome session and wait for completion |
| `--headless` | Prompt, `get`, `dump`, `screenshot` | Require headless Chrome; some providers may show bot verification instead |
| `--timeout <ms>` | All commands | Set one deadline for browser readiness, authentication, submission, and response |
| `-v, --verbose` | All commands | Print browser and session details |
| `-V, --version` | Top level | Print the CLI version |
| `-h, --help` | All commands | Show command help |

Run `ask --help` or `ask <command> --help` for the generated reference.

### Provider status

`ask status` inspects the existing ask-managed Chrome session without launching, recovering, restoring, or moving Chrome. It shows every configured provider by default:

```console
$ ask status
Chrome: running · ask-managed · background · port 51437

PROVIDER  STATUS    AUTH              MESSAGE BOX
ChatGPT   ready     signed-in-likely  available
Gemini    not open  unknown           not checked
```

Use `ask status --provider gemini` to filter the report. `ASK_PROVIDER` does not filter status output. Here, **message box** means the provider's text editor where `ask` enters a prompt. The Chrome placement is observed read-only and is reported as `headless`, `background`, `visible`, or `unknown`; `unknown` means CDP could not fully inspect every headed window. Use `ask status --verbose` to include page URLs, readiness flags, notes, and the placement detail.

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

Each execution uses a fresh temporary tab and closes it afterward. Headed send paths start and remain minimized, including after a response timeout. The sole exception is `PROMPT_DELIVERY_UNKNOWN`: that tab remains open and minimized so you can determine whether the provider accepted the prompt without risking a duplicate send. Requests using the same provider and conversation name run sequentially. `--continue` waits for all active work for that provider so the meaning of “previous conversation” remains deterministic. Setup/login and Chrome visibility-mode changes are rejected while prompt executions are active.

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
| `ASK_CHROME_PATH` | Strict path to Chrome; also required for intentionally using an alternate Chromium browser |
| `ASK_HOME` | State and browser-profile directory; defaults to `~/.ask` |
| `ASK_REMOTE_DEBUGGING_PORT` | Pin the Chrome debugging port; when unset, Chrome selects and ask persists a safe port |

Command-line options override environment defaults.

Without `ASK_REMOTE_DEBUGGING_PORT`, `ask status` shows `port auto` before the first managed session exists and the persisted assigned port afterward. A pinned port never falls back to another endpoint.

## Sessions and privacy

`ask` keeps login state in its own Chrome profile under `~/.ask/chrome-profile` on macOS/Linux or `%USERPROFILE%\.ask\chrome-profile` on Windows. During setup, that profile is opened in ordinary Chrome without a remote-debugging endpoint; only after Chrome fully exits does Ask reopen it as a managed headed session and minimize it. Named conversation URLs are stored in `~/.ask/conversations.json` or its Windows equivalent. It never copies or reuses your normal Chrome profile.

Prompts and attachments are sent to the selected provider. Treat the ask home directory as sensitive and do not commit it.

When a send reaches `PROMPT_DELIVERY_UNKNOWN`, Ask leaves that worker tab open and records only the provider, CDP target id, known conversation URL (if any), managed-session generation, and timestamp under `ASK_HOME`. It never records the prompt, page HTML, cookies, account data, or DOM content there. Inspect the preserved tab, then close that tab yourself once delivery is resolved. Until the tab is gone, Ask refuses Chrome setup or mode/background restarts that would close the managed browser; retrying the requested operation after closing the tab safely clears the stale record.

## Troubleshooting

- Run `ask status` for a quick readiness check or `ask status --verbose` for details.
- Run `ask setup` (or `ask login`) to complete sign-in before sending a prompt. If an interactive send (`ask ...` or `ask open --send ...`) discovers a missing login before submission, it starts setup in ordinary Chrome and retries once within the same command deadline.
- Fully quit the ordinary Ask Chrome window after signing in; closing only its active tab is not enough. Ask cannot safely reuse the profile while Chrome still owns it.
- Headless and non-interactive commands cannot complete sign-in; run `ask setup` once from an interactive terminal first.
- When `ASK_REMOTE_DEBUGGING_PORT` is unset, ask avoids external port conflicts automatically. An explicitly pinned port remains strict and fails rather than taking over another process.
- Provider execution failures identify the failed stage and a stable code, then print a suggested next action. A response timeout still returns any partial response on stdout and exits with code `2`; confirmed delivery is unsafe to resend, so reopen or continue the saved conversation.
- `PROMPT_DELIVERY_UNKNOWN` means ask performed at most one send action but could not prove acceptance. The worker tab is left open for inspection; do not rerun the prompt until you confirm whether it was delivered. After inspection, close that worker tab yourself, then retry any setup or mode-changing command that was blocked to let Ask reclaim its safety record.

## Development

```console
npm test
npm run typecheck
npm run build
```

`npm test` runs the portable unit suite. It intentionally excludes all real-Chrome and account-backed suites, so it does not need a local Chrome installation, a signed-in profile, or an open debugging port. The GitHub Actions matrix runs `npm ci`, type-checking, a build, and this portable suite on Linux, macOS, and Windows. Its Chrome discovery, path-comparison, and port-policy cases use injected environment/platform/process seams rather than the host operating system.

`ASK_CHROME_PATH=/path/to/chrome npm run test:browser` is an explicit real-Chrome opt-in: it verifies automatic endpoint reuse, multiprocess startup, cross-profile ownership, and isolated pages. `ASK_CHROME_PATH=/path/to/chrome npm run test:e2e:features` uses the same opt-in browser process to verify all-provider status, exactly-once ChatGPT and Gemini DOM dispatch, and structured failure cleanup against locally intercepted provider fixtures. With an already-running, signed-in Ask Chrome page, `ASK_LIVE_CAPABILITY_TEST=1 npm run test:live:capabilities` performs a non-sending ChatGPT capability smoke test. The separate opt-in `ASK_LIVE_TEST=1 npm run test:live:parallel` command sends six real prompts, creates provider conversations, and consumes account usage; both live tests remain outside normal CI.
