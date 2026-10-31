# Node File Trace

The `out/` files and MIT license are unchanged files from `@vercel/nft` 1.11.0.
`upstream.json` records the exact npm archive integrity and every file's SHA-256.
`node scripts/vendor-nft.mjs verify` checks those bytes and the complete inventory.

This copy uses PRNext's explicit dependencies, including glob 14.0.2 and
minimatch 11.0.1. Upstream 1.11.0 still declares glob 13; overriding a workspace
lockfile would not repair that dependency for independently installed consumers.
The tracing implementation itself has no local patches. Its runtime, resolver,
filesystem, native tracing and relocated standalone contracts are tested with
the patched dependency versions.

When upstream supports the patched dependencies, prefer returning to its normal
package after validating the same contracts. Updates to this copy must retain
the upstream license, reviewed archive integrity and complete byte inventory.
