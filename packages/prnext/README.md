<p align="center">
  <a href="https://prnext.dev">
    <picture>
      <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/Lorkydey/PRNext/main/.github/assets/prnext-logo-metallic-static.png">
      <img src="https://raw.githubusercontent.com/Lorkydey/PRNext/main/.github/assets/prnext-logo-metallic.gif" alt="PRNext logo with a metallic finish" width="160" height="160">
    </picture>
  </a>
</p>

<!-- Logo effect rendered with React Bits Metallic Paint, copyright 2026 David Haz (MIT + Commons Clause): https://reactbits.dev/animations/metallic-paint -->

<h1 align="center">PRNext</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@thomas.f/prnext"><img src="https://img.shields.io/npm/v/%40thomas.f%2Fprnext?style=for-the-badge&amp;label=npm&amp;labelColor=161b22&amp;color=007ec6" alt="npm version"></a>
  <a href="https://github.com/Lorkydey/PRNext/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Lorkydey/PRNext?style=for-the-badge&amp;labelColor=161b22&amp;color=98d6ac" alt="MIT License"></a>
</p>

A React framework with a Rust-powered runtime.

## Install

Run in your application directory:

```sh
npm i @thomas.f/prnext
```

Node.js **22.23.4+, 24.22.1+ or 26.12.1+**. Windows, macOS and Linux (glibc), x64 and ARM64. No Rust installation needed.

**Experimental alpha.** Next.js compatibility is partial. Start a new app with the [quickstart](https://github.com/Lorkydey/PRNext/blob/main/packages/prnext/docs/ai/quickstart.md).

<details>
<summary><strong>Use an existing Next.js app</strong></summary>

Preview changes with `npx --no-install prnext migrate --dry-run`. Review the output, then run:

```sh
npx --no-install prnext migrate
npx --no-install prnext check
npx --no-install prnext dev
```

Read the [compatibility guide](https://github.com/Lorkydey/PRNext/blob/main/packages/prnext/docs/ai/compatibility.md) before migrating.

</details>

<details>
<summary><strong>Build for production</strong></summary>

```sh
npx --no-install prnext build
npx --no-install prnext start
```

After upgrading PRNext, rebuild your app and restart it.

</details>

<details>
<summary><strong>Use with AI assistants</strong></summary>

Read the guides included with your installed version:

```sh
npx --no-install prnext docs --ai
```

Run `npx --no-install prnext docs --ai --init` to add a guide reference to your project's `AGENTS.md`.

</details>

<details>
<summary><strong>Develop from this repository</strong></summary>

```sh
npm ci
npm run build:native
npm run dev -- examples/app
```

Source builds require Rust 1.98 and native build tools: Visual Studio C++ tools and a Windows SDK on Windows, Xcode command line tools on macOS, or a C/C++ toolchain and pkg-config on Linux. Install NASM on macOS, Linux and Windows x64.

</details>

## Documentation

[Guides](https://github.com/Lorkydey/PRNext/blob/main/packages/prnext/AI.md) · [Releases](https://github.com/Lorkydey/PRNext/releases) · [Contributing](https://github.com/Lorkydey/PRNext/blob/main/CONTRIBUTING.md) · [MIT License](https://github.com/Lorkydey/PRNext/blob/main/LICENSE)
