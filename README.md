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

Open the dedicated browser profile and sign in:

```console
ask login
ask "Explain why the sky is blue"
```

For Gemini:

```console
ask --provider gemini login
ask --provider gemini "Explain why the sky is blue"
```

## Common usage

| Command | Purpose |
| --- | --- |
| `ask "prompt"` | Start a new conversation and return the response |
| `ask --continue "prompt"` | Continue the previous conversation |
| `ask -a image.png "prompt"` | Attach a file; repeat `-a` for more files |
| `git diff \| ask "Review this diff"` | Send piped input |
| `ask "prompt" -o answer.md` | Save the response to a file |
| `ask --provider gemini "prompt"` | Use Gemini instead of ChatGPT |
| `ask open "prompt"` | Fill a prompt in the visible browser |
| `ask get` | Print the latest response from the current page |
| `ask screenshot` | Capture the current provider page |
| `ask status --verbose` | Inspect browser and login status |

Run `ask --help` for all commands and options.

## Output

Interactive runs show the provider, elapsed time, and conversation URL before the response:

```text
✓ ChatGPT · continued · 2.4s
↗ https://chatgpt.com/c/example

Hi! 👋
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

`ask` keeps login state in its own Chrome profile under `~/.ask/chrome-profile` on macOS/Linux or `%USERPROFILE%\.ask\chrome-profile` on Windows. It never copies or reuses your normal Chrome profile.

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
```
