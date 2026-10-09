# file-tools-first plugin privacy policy

Last updated: October 9, 2026

The file-tools-first plugin for Claude Code collects no data. It has no servers, no accounts, no
analytics and no telemetry, and it never connects to the network.

## What the plugin accesses

Before each Bash or PowerShell command, Claude Code passes the plugin the command Claude is about
to run and the session's working folder. The plugin reads the command text. To tell an edit of an
existing file from a new file, it checks whether the files the command names exist on your
computer. It reads no file contents. At session start it receives the session's basic details and
uses none of them.

## What happens to that data

The plugin either says nothing or returns a short message to Claude: a note at session start, or,
when it blocks a command, a message that names the files involved and the file-tool call to use
instead. It writes nothing to disk and keeps no logs, caches or copies.

Its messages become part of your conversation with Claude, like any other hook output. How
Anthropic handles your conversations is covered by Anthropic's own privacy policy, not this one.

## Retention

None. Nothing outlives the hook call that read it.

## Changes and contact

Changes to this policy are made in this file and recorded in the repository's history. Questions
go to [github.com/derekwden-droid/file-tools-first/issues](https://github.com/derekwden-droid/file-tools-first/issues).
