# ask-chat-cli

Use ChatGPT or Gemini web chat from the terminal without API keys or per-token API billing.

`ask` is an unofficial, Windows-first CLI that drives the provider's website through a dedicated Google Chrome profile. It supports prompts, local attachments, shell pipelines, output redirection, and conversation continuation. ChatGPT is the default provider.

> [!IMPORTANT]
> This project uses your existing provider account and consumes the provider's normal web-chat allowance. It does not bypass subscriptions, usage limits, authentication, or access controls.

## Project status

**Alpha — useful for personal workflows, but not yet production-stable.**

- ChatGPT and Gemini are supported through their web interfaces.
- The automated test suite covers CLI parsing, sessions, browser ownership, provider behavior, conversation continuity, and output handling.
- Windows is the primary target. Build, type-check, and unit-test workflows are host-independent, and development on macOS is supported.
- Live provider UI changes can temporarily break login detection, prompt submission, attachments, or response extraction.

Compatibility reports and focused bug reports are welcome.

## Why use it?

Codex is designed for repository-aware software engineering. Sometimes a terminal workflow only needs a direct web-chat response: summarize a diff, inspect an attachment, rewrite text, or produce structured output.

`ask` brings that workflow to the shell:

- No provider API key or SDK setup
- Clean stdout for pipelines and redirection
- Multiple file and image attachments
- Persistent login in an isolated Chrome profile
- Separate ChatGPT and Gemini conversation state
- Background operation after interactive login

## Quotas and billing

`ask` does not call the OpenAI or Gemini APIs. Using it does not create per-token API charges; it uses the limits attached to the account signed in on the provider's website.

For OpenAI accounts, ordinary ChatGPT model/message limits and Codex agentic usage are currently documented separately. Codex shares its agentic usage pool with products including ChatGPT Work, ChatGPT for Excel, and Workspace Agents. Therefore, a prompt sent by `ask` to ordinary ChatGPT web chat consumes the web-chat allowance rather than the Codex agentic allowance.

Plans, eligibility, and limits can change. Check the current [ChatGPT pricing](https://chatgpt.com/pricing/), [Codex pricing](https://chatgpt.com/codex/pricing/), and [Codex plan documentation](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) before relying on a particular allowance. Gemini usage follows the limits of the signed-in Google account and plan.

## How it works

1. `ask login` opens a dedicated Chrome profile for interactive sign-in.
2. Worker commands connect to an ask-owned Chrome session through the Chrome DevTools Protocol.
3. Provider-specific automation enters the prompt, uploads attachments, submits the request, and waits for completion.
4. Progress and diagnostics go to stderr; the assistant response goes to stdout.

The CLI never copies or reuses your normal Chrome profile.

## Requirements

- Node.js and npm
- Google Chrome
- A signed-in ChatGPT or Gemini account
- Windows for the primary supported experience, or macOS for development and testing

## Install locally

```powershell
npm install
npm run build
npm link
```

## Usage

```powershell
ask --help
ask login
ask open "Plan a small refactor"
ask open --continue "Continue the previous chat"
ask open --send "Start this chat and return later"
ask "Write a short markdown plan" -o docs/plan.md
ask -a screenshot.png "Describe this image"
ask -a report.pdf -a data.csv "Compare these files"
git diff | ask "Plan this diff" -o docs/plan.md
ask get -o docs/latest.md
ask dump -o debug/page.html
ask screenshot
ask status
```

`ask` is the background worker command. `ask open` and `ask login` are explicitly interactive and may bring the dedicated browser into view; `open` does not accept `--headless`.

Prompt commands start a new conversation by default while reusing one background worker tab per provider. A new conversation does not create another tab. Use `--continue` to continue the last successful CLI conversation for the selected provider. If no previous conversation is available, `ask` reports that condition and starts a new conversation automatically.

Worker commands animate provider, conversation choice, and elapsed time on a single stderr line while keeping assistant responses on stdout. When a response finishes in an interactive terminal, the status becomes a compact completion summary followed by the conversation URL and a blank line before the response. They do not bring the browser page to the foreground. The spinner falls back to static text in CI or `TERM=dumb`. This means piping and redirection remain clean:

```text
✓ ChatGPT · continued · 2.4s
↗ https://chatgpt.com/c/example

Hi! 👋
```

```powershell
ask "Return a JSON object" | jq
ask "Write a short markdown plan" -o docs/plan.md
```

When `-o/--output` succeeds, `ask` confirms the resolved destination on stderr. Existing files are never overwritten.

## Providers

Use `--provider <chatgpt|gemini>` to choose the web app. There is no short alias.

```powershell
ask --provider gemini login
ask --provider gemini "Plan this"
ask --provider gemini open "Plan this"
ask --provider gemini get
ask --provider gemini dump
ask --provider gemini screenshot
ask --provider gemini status
```

Command-local placement also works:

```powershell
ask login --provider gemini
ask open --provider gemini "Plan this"
ask status --provider gemini
```

Set `ASK_PROVIDER=gemini` to make Gemini the default provider for later commands. An explicit `--provider` always wins over `ASK_PROVIDER`.

Gemini support is browser-driven. Log in with `ask --provider gemini login` or `ask login --provider gemini`; no `GEMINI_API_KEY`, SDK, or API setup is used.

## Browser session model

`ask` uses one dedicated Chrome profile under `%USERPROFILE%\.ask\chrome-profile`. ChatGPT and Gemini share that ask profile, but each provider has its own login/auth state, persisted conversation URL, and reusable worker tab.

Normal commands treat Chrome as an internal transport and reuse a background worker page. They still default to a visible ask-managed Chrome process for compatibility, but do not intentionally foreground it. Automated sends require the selected provider to appear signed in; guest, unknown, blocked, or login-required pages are rejected before the prompt is filled or submitted.

`--headless` requires the actual ask-managed Chrome process to run headlessly. If the verified ask-owned process is visible, the CLI gracefully closes it and restarts the same dedicated profile with `--headless=new`. A later `ask login` performs the reverse transition. External or unknown Chrome sessions are never replaced.

`ask login` is visible-only. If an ask-managed headless session is blocking login, the CLI can gracefully restart that ask-owned session as visible. It will not close unknown or external Chrome processes.

## Common options

- `-h, --help`: print help for `ask` or a subcommand, for example `ask open -h`.
- `--provider <chatgpt|gemini>`: choose the browser web-chat provider. Defaults to `ASK_PROVIDER`, then `chatgpt`.
- `-v, --verbose`: print browser launch and Chrome DevTools connection details.
- `-a, --attach <file>`: attach one or more local files to a prompt; repeat the option for multiple files.
- `--continue`: continue the previous provider conversation. If none is available, start a new conversation automatically.
- `--new`: explicitly request the default new-conversation behavior; retained for compatibility.
- `--timeout <ms>`: set the operation timeout in milliseconds.
- `--headless`: require the verified ask-managed Chrome process to run without a visible window, restarting its dedicated profile headlessly when needed.

## Status and login troubleshooting

Use `ask status` to inspect the current session without launching or repairing Chrome:

```powershell
ask status
ask --provider gemini status
ask status --provider chatgpt
```

Status separates usability from authentication:

- `Session`: `ask-managed`, `external`, `unknown`, or `absent`.
- `Prompt input`: whether the provider page appears ready to send.
- `Auth`: `signed-in-likely`, `guest`, `login-required`, `blocked`, or `unknown`.
- `Ready for headless`: only `yes` when the provider appears signed in and ready.

The default output starts with a short result such as `Status: ready` or `Status: login required`. Use `ask status --verbose` for Chrome mode, port, page counts, authentication detection, and other troubleshooting details.

Gemini may expose a usable guest chat prompt. That is not treated as signed in, and `ask --provider gemini "..."` will stop before sending until Gemini appears signed in. Run `ask login --provider gemini`, complete login in the opened browser, then confirm with `ask status --provider gemini`.

If port `9222` is used by an external Chrome session, `ask` will not kill it. Use `ask status` to inspect the ownership result, then either free that port outside of `ask` or choose a separate ask session:

```powershell
$env:ASK_HOME="$env:USERPROFILE\.ask-alt"
$env:ASK_REMOTE_DEBUGGING_PORT=9333
ask --provider chatgpt login -v
```

## Exit codes

- `0`: the command completed successfully.
- `1`: input, setup, authentication, browser, or file-output error.
- `2`: response waiting timed out; any latest partial response was still returned.

## Security and privacy

- Login state is stored in the dedicated Chrome profile under `%USERPROFILE%\.ask\chrome-profile`.
- Treat that directory as sensitive. Anyone who can access it may be able to access the signed-in provider sessions.
- Do not commit the ask home directory, browser profile, screenshots, page dumps, or private prompt output.
- Attachments and prompts are sent to the selected provider and are governed by that provider's terms and data controls.
- `ask` refuses to replace Chrome processes it cannot verify as ask-owned.

## Known limitations

- This is browser automation, not a supported provider API integration. Provider UI changes may require code updates.
- A successful `ask status` is a best-effort readiness check, not a guarantee that the next request will complete.
- Provider rate limits, abuse protections, login challenges, outages, and regional availability still apply.
- Headless browser behavior may differ from visible mode.
- The project is currently optimized for a single user and a dedicated local browser profile.

## Development

Run the automated checks before submitting a change:

```sh
npm test
npm run typecheck
npm run build
```

## Development on macOS

The product is Windows-first, but build and unit tests are host-independent. To exercise the dedicated Chrome profile on macOS, point the CLI at the installed browser executable:

```sh
export ASK_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ask login
ask status
```

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by OpenAI or Google. ChatGPT, Codex, Gemini, Chrome, and other product names belong to their respective owners. Use the project in accordance with each provider's terms and policies.
