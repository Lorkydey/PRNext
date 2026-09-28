<a href="https://prnext.dev"><img src="https://prnext.dev/favicon.svg" alt="PRNext logo" width="80" height="80"></a>

# PRNext

[Website](https://prnext.dev) · [GitHub](https://github.com/Lorkydey/PRNext) · [Report an issue](https://github.com/Lorkydey/PRNext/issues)

A Rust-powered runtime for Next.js projects, with React and npm modules running on Node.js.

> **Very early alpha — 0.1.0-alpha.1**
>
> Built for experimentation and feedback, not production applications. Next.js compatibility is partial. Expect bugs, missing features and breaking changes.

## Install and migrate

Node.js 22+ is required. This alpha uses matching React, React DOM and React Server Components versions:

```sh
npm install @thomas.f/prnext@alpha react@19.3.0 react-dom@19.3.0 react-server-dom-webpack@19.3.0
npx --no-install prn migrate --dry-run
npx --no-install prn migrate
npx --no-install prn check
npx --no-install prn dev
```

The package provides both `prnext` and its shortcut `prn`. Migration backs up your package files and keeps Next.js and your application source. The preflight check does not guarantee full compatibility with your application.

## Build and run

```sh
npx --no-install prn build
npx --no-install prn start
```

Balanced is the default production profile. Choose a profile with:

```sh
npx --no-install prn start --profile balanced
npx --no-install prn start --profile speed
npx --no-install prn start --profile memory
npx --no-install prn start --profile classic
```

## Platforms

Prebuilt packages support macOS arm64/x64 and Linux glibc arm64/x64. Use WSL on Windows. Alpine/musl and native Windows do not yet have prebuilt packages. Linux binaries are built on Ubuntu 22.04 with glibc 2.35.

Keep npm optional dependencies enabled: PRNext automatically installs the binary for your platform. Rust is not required to use the published package.

## Links and feedback

- Website and benchmarks: [prnext.dev](https://prnext.dev)
- Source and contributions: [Lorkydey/PRNext](https://github.com/Lorkydey/PRNext)
- Bug reports: [GitHub Issues](https://github.com/Lorkydey/PRNext/issues)
- Questions and suggestions: [contact@heythomas.dev](mailto:contact@heythomas.dev)

## License and credits

PRNext is licensed under the [MIT License](LICENSE), copyright © 2026 Thomas (Lorkydey). Commercial use, modification, and redistribution are permitted; keep the copyright and license notice when distributing copies or substantial portions of the software. Third-party components retain their own licenses.

If PRNext helps your project, a credit such as **“PRNext by Thomas (Lorkydey)”** with a link to [prnext.dev](https://prnext.dev) would be appreciated. A public credit is optional, not an additional license condition.
