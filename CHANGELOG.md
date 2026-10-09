# Changelog

## 1.0.0 - 2026-10-09

- SessionStart hook that tells Claude to use Read, Edit and Write for files.
- PreToolUse hook on Bash and PowerShell that blocks file work done through the shell and names
  the file-tool call to use instead:
  - in-place edits: `sed -i`, `perl -i`, `ruby -i`, `awk -i inplace`, also through loops,
    `find -exec` and `xargs`;
  - text written into files: heredocs, `echo` and `printf` redirects, `tee`, `Set-Content`,
    `Add-Content`, `Out-File`, `New-Item -Value`, `[IO.File]::WriteAllText`;
  - inline Python, Node and Ruby scripts and PowerShell pipelines that rewrite an existing file;
  - read-only commands (`cat`, `head -n`, `sed -n 'A,Bp'`, `Get-Content`), answered with the Read
    call's offset and limit.
- Leaves builds, tests, git, searches, pipelines, command output sent to files, and writes to
  temporary folders, devices and `.git` alone.
- `TOOL_ROUTER_READS=allow` and `TOOL_ROUTER=off` settings.
