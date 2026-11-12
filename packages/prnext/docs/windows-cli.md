# Windows CLI commands

Install and use the portable command in PowerShell or CMD:

```powershell
npm install -g @thomas.f/prnext
prnext --help
prnext --version
prnext login --server https://app.prnext.dev
```

`prnext` exposes every command, including login, deploy and update. The Unix
shortcut `prn` remains available on Linux and macOS. Windows 10, Windows 11 and
Windows Server reserve `PRN` as a device name, case-insensitively and with any
extension. npm can create files named `prn`, `prn.cmd` and `prn.ps1`, but their
presence does not guarantee Windows command resolution. This also explains why
invoking a full path to `prn.cmd` can fail. Use `prnext`; reinstalling the same
package, changing file associations or adding a directory to PATH cannot make
the reserved name portable. See [Microsoft's filename rules](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file#naming-conventions).

If **`prnext` itself is not recognized**, inspect the installation:

```powershell
npm.cmd ls -g @thomas.f/prnext --depth=0
npm.cmd prefix -g
Get-Command prnext -All
$env:PATHEXT
```

npm puts global launchers directly in the global prefix on Windows. That exact
directory must be present in the terminal's PATH, and PATHEXT must include
`.CMD`. A custom npm prefix or multiple Node installations can select another
directory; verify the prefix in the same terminal used for installation.
Open a new terminal after an installer changes PATH. See [npm's folder layout](https://docs.npmjs.com/cli/v11/configuring-npm/folders/#executables).

If PowerShell reports that **script execution is disabled**, the `.ps1` launcher
was found, but the execution policy prevents it from running. Use npm's standard
CMD launcher directly, without changing the system policy:

```powershell
prnext.cmd --help
prnext.cmd --version
prnext.cmd login --server https://app.prnext.dev
```

PRNext does not edit shell profiles, execution policies or PATH during
installation. Use a supported Node version (22.23.4+, 24.22.1+ or 26.12.1+);
`node --version` and `npm.cmd --version` identify the active installation.
