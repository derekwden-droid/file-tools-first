# file-tools-first

In auto mode and bypass-permissions mode, Claude Code tells Claude to read files with `cat`, `head` or `sed -n` and to change them with `sed`, heredocs or short scripts instead of its Read, Edit and Write tools. No setting turns that off, and Claude reaches for the shell out of habit in other modes too. File work done through the shell loses what the file tools give you:

- **/rewind can't undo it.** Checkpoints only track changes made with the file tools.
- **Your rules don't load.** Nested CLAUDE.md files, path-scoped rules and `paths:` skills load when Claude reads or edits a file with the file tools, not when it runs `cat` or `sed`.
- **Nothing checks it.** The edit doesn't show up as an edit, and Claude Code's checks and every Write or Edit hook you have installed never see it.

These are open issues on Anthropic's tracker: anthropics/claude-code 87971, 90450, 87575, 88041 and 19649.

file-tools-first sends that work back to the file tools:

- **At session start** it tells Claude to use Read, Edit and Write for files, whatever other instructions say.
- **Before each Bash or PowerShell command** it blocks two kinds of command and tells Claude which file-tool call to make instead:
  - **Writes:** in-place edits (`sed -i`, `perl -i`, `ruby -i`, `awk -i inplace`, including through loops, `find -exec` and `xargs`); text written into a file (a heredoc, `echo` or `printf` redirected into it, `tee`, `Set-Content`, `Add-Content`, `Out-File`, `New-Item -Value`, `[IO.File]::WriteAllText`); and inline Python, Node or Ruby scripts or PowerShell pipelines that rewrite an existing file.
  - **Reads:** commands that do nothing but read whole files or their first lines (`cat`, `head -n`, `sed -n '10,20p'`, `Get-Content`). The block gives the Read call with the right offset and limit.
- **Everything else runs:** builds, tests, git, package managers, formatters, `grep` and `find`, `tail`, pipelines that process a file, and command output sent to a file (`npm test > test.log`). Writes to temporary folders, devices and `.git` are left alone as well.

Here is what Claude saw in a real session after trying `sed -i 's/retries: 5/retries: 7/' config.yml`:

```
file-tools-first blocked this command: it edits C:\Users\123\Projects\file-tools-first-live\config.yml in place with sed -i. File changes made through the shell can't be undone with /rewind, don't show up as edits, and skip the CLAUDE.md rules and checks that apply to the file tools.
Instead:
- Edit C:\Users\123\Projects\file-tools-first-live\config.yml
Keep using the shell for builds, tests, git and other commands. If the user asked for this exact shell command, tell them file-tools-first blocked it; they can run it themselves by starting their message with !.
```

Claude made the change with Edit on its next step. A `head -n 2 config.yml` in the same session came back with `Read file_path "...config.yml" with limit 2`, and a PowerShell `(Get-Content config.yml) -replace ... | Set-Content config.yml` was sent to Edit the same way.

## Try it

1. "Create `config.yml` containing `port: 3000`, then change the port to 4000 with `sed -i`."
2. "Show me the first 10 lines of `README.md` using `head`."
3. "Use a Bash heredoc to create `notes.txt` with three lines of text."

Each time file-tools-first blocks the shell command, and Claude uses Edit, Read or Write instead.

## Settings

One option, **Block read-only shell commands** (`block_reads`), is on by default. Turn it off in `/config` to let read-only commands through while edits and writes stay blocked. To pause the plugin entirely, disable it with `/plugin`.

Commands you run yourself by starting a message with `!` don't go through Claude's tools, so file-tools-first never blocks them.

## What's included

- **Two hooks.** SessionStart adds a short note telling Claude to use the file tools. PreToolUse on Bash and PowerShell runs `node scripts/file-tools-first.mjs` before each command and says nothing unless the command is one of the reads or writes above.

## What it reads, runs and sends

- **Reads** the command Claude is about to run. To tell an edit from new output, it checks whether the files the command names exist, and it reads no file contents.
- **Writes** nothing, and keeps no logs or state.
- **Runs** `node scripts/file-tools-first.mjs` at session start and before each Bash or PowerShell command, about 35 ms on top of starting Node.
- **Sends** nothing over the network. There is no telemetry and no account. See [PRIVACY.md](PRIVACY.md).

Its messages go into your conversation with Claude, like any other hook output.

## Limits

- It reads commands with a small shell parser, not a full shell. Commands it can't follow run as usual.
- An inline script counts as a rewrite only when it writes to an existing file named by a string, or by a variable set to one in the same script. A script that computes its paths runs.
- Command output sent to a file is allowed, so `jq ... file > tmp && mv tmp file` gets through.
- It never approves a command or changes one. It blocks or stays silent, and if anything goes wrong inside the hook the command runs and Claude Code shows a hook error notice.

## Requirements

- A Claude Code version with exec-form hooks (`"command"` plus `"args"`). Verified on 2.1.293 on Windows 11.
- Node.js 20 or later on your `PATH`.

## Development

`node --test` runs the tests. They need nothing beyond Node.

## License

MIT. See [LICENSE](LICENSE).
