# Upgrading an application to PRNext 0.2.1-alpha

This patch focuses on the starter and development tools. Check the exact version
on npm and its matching GitHub prerelease before upgrading. The framework remains
an experimental alpha with partial Next.js compatibility.

## Update matching packages

```sh
npm install @thomas.f/prnext@0.2.1-alpha
```

Keep the framework and native package on the same exact version. Node
requirements remain 22.23.4+, 24.22.1+ or 26.12.1+, with matching React,
React DOM and react-server-dom-webpack 19.3.1 peers.

Stop managed applications with their current CLI before replacing packages,
using the same process-manager home. Rebuild application output with the new
version and restart workers. Keep a matching previous build for rollback.
For upgrades from 0.1, also read the [0.2 upgrade guide](UPGRADING-0.2.0.md).

## Starter and developer tools

Newly created JavaScript and TypeScript projects receive a minimal welcome page
with AI setup, documentation and an editor link. Updating an existing application
does not replace its page or layout.

Drag the client console by its title bar and resize it using its edges or
corners. Console filters and window geometry are remembered, along with the
preview device, width, rotation, fold and frame settings. Settings synchronize
between tabs and detached windows; they contain tool preferences only.

The Duo preview models a continuous folding display with an outer screen and
animated inward closing. It preserves the running page while folding and
docking. This visual preview does not emulate Device Posture or Viewport
Segments browser APIs.

Export the visible preview as a flat PNG, optionally including its device frame.
Exports preserve nested scroll positions and the selected responsive image.
Copy image falls back to a local download when clipboard writing is unavailable.
Visible embedded frames report unsupported content instead of disappearing.

Use Reset tools to restore the tool defaults. It preserves application data,
console messages and the live page's React state.

## Hydration and hot reload

Development HMR tracking no longer writes build attributes onto React's document
root. The ColorZilla body marker is handled without hiding genuine application
hydration errors. These changes do not suppress mismatches caused by application
data, markup or other extensions.

Verify your application's hot reload, navigation and state retention after the
upgrade. This patch does not establish that every previously observed layout
reset or deployment-transition issue is resolved.
