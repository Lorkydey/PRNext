# Automatic presentation pipeline

These changes describe the unreleased source candidate after 0.1.22-alpha.
They are not claims about the already published 0.1.22-alpha packages.

The additional DOM/packet work targets the 0.1.23-alpha candidate. It remains
automatic under the same `presentationComponents` configuration.

Production Node App Router builds choose an ordinary React path, a checked
compact template, or a build-prepared literal subtree. The application does not
need a directive, a component API change, or a manual file split. The existing
top-level `presentationComponents: false` setting opts out of all three compiler
transformations.

## Automatic blocks inside normal server modules

The compiler can extract a checked host subtree inside a module containing
imports, asynchronous work, other exports and interactive siblings. For example,
an async page can load data, render a Client Component, and then render a large
pure table. The data loading and Client Component stay on their original paths;
the table can use a compact template independently.

Imported Server Components are examined when their own modules are compiled.
The compiler does not execute imports, inline arbitrary application functions,
or transfer their implementations into a browser bundle.

Extraction calls its internal server renderer synchronously at the original JSX
position. On rejection it evaluates a separate ordinary closure there. This
preserves lexical reads and the ordering of getters, sibling expressions and
effects, rather than rendering the source twice or deferring a rejected subtree.
Keyed host roots retain their existing outer element; eligible unkeyed
descendants can still be extracted.

Discovery only replaces output owned by the renderer. Children/props passed to
unknown custom components, JSX inspected by calls such as `cloneElement`, stored
element variables and arbitrary callback results remain ordinary: those
consumers can legitimately inspect or modify element types and props.

The checked display language remains conservative. URL/resource elements,
unverified attributes, dynamic styles, spreads, refs, custom JSX transformations,
forms and controls, client/action/cache boundaries, opaque values and unknown
syntax keep ordinary rendering. An unsupported parent does not exclude an
otherwise admissible child. Authentication and authorization stay in the
application's server code.

## Fused validation and display projection

Generated server code validates descriptor values into local variables and uses
those same values to calculate the displayed slots. It does not construct an
intermediate packed input tree or reread each source property for projection.
Map traversal validates dense ordinary arrays and emits the final display rows.
Schema preparation and code generation happen during compilation; there is no
request-time eval or dynamic Function construction.

Getters and proxies are not invoked by admission. Unsupported data selects the
ordinary closure/function, which preserves the application's actual behavior.
Traversal remains bounded by schema depth, array length and a per-request visit
budget. Data, calculated results and account state are never cached by this
projection machinery.

## Shared structural templates

Checked templates are pooled by their generated browser implementation, with
content-based identities independent of temporary build directories. Separate
source components keep their own server calculations and schemas.

Literal text, attribute values and literal styles are supplied as display
metadata rather than embedded in a template module. Structurally identical
English/French components can therefore share the same browser and SSR template.
Only literals reached by an evaluated display region are included: a label or
style inside an empty nested list is absent from both its browser module and
the compact response. A fallback carries the actual ordinary server-rendered
output, not the unused literal dictionary.

A source also imported by an existing Client Component keeps its ordinary public
props API. Internal template/tuple/literal properties are not application APIs.

## Specialized HTML rendering

For verified intrinsic templates the SSR entry builds escaped HTML directly,
avoiding a React element allocation for every repeated host node. The entry uses
an ordinary React intrinsic root with its actual tag and attributes; it does not
introduce a wrapper, a new Flight record type or suppressed hydration warnings.
Legacy templates keep the normal React browser path; admitted DOM plans use the ownership model below.

The writer preserves adjacent-text separators, empty/boolean text behavior,
attribute aliases and escaping. Literal CSS is serialized by React once per
used style for the component, rather than once per row. No cross-request style
or output cache is introduced. Unsupported shapes or writer limits use the
ordinary template. Parent Suspense, streaming and Server Actions remain owned
by the existing React/framework pipeline.

The optimized HTML assembly is capped at 4,194,304 UTF-16 characters. Individual
optimized text/style fields are capped at 262,144 characters. Exceeding these
limits selects ordinary React rendering; these are writer bounds, not new
application response limits.

## Build-prepared literal HTML

Large wholly literal intrinsic subtrees can be serialized during compilation
without creating a presentation client module. Only a bounded literal AST is
converted; application modules and helpers are never executed for discovery.
The surrounding function, its parameter evaluation, guards and request-specific
branches stay in place. A prepared string is only returned where that original
subtree would have been rendered, including behind authorization checks.

This is not a cache of SQL results, cookies, user data, dates or arbitrary
functions. The initial selector requires at least 64 intrinsic elements and
1,024 bytes of literal markup.

## Cost selection and diagnostics

The compiler estimates repeated Flight element/prop-name overhead and charges
the compressed template plus a cold-module allowance. Legacy repeated models have a minimum floor of 32 rendered entries; expensive templates can require more. DOM plans retain valid small models to preserve ownership, as described below.
Scalar-only repeated models without enough structural saving remain ordinary.
The estimate is an admission heuristic, not a measured network/CPU guarantee.
Runtime data validation and HTML-size checks still apply.

`.prnext/presentation-report.json` records whole components and extracted blocks,
partial modules, static blocks, pooled template identities, shared source counts,
SSR/fused paths and available cost metadata. A compiler decision does not prove
that every request uses the compact path. Some unknown syntax is intentionally
not a candidate and remains ordinary.

## Compiled DOM ownership and hydration

For an admitted intrinsic plan, React continues to own the actual root element,
its attributes and component lifecycle. The server and first browser render use
the same escaped HTML writer. No wrapper or suppressed hydration warning is
introduced. Descendants are opaque inner HTML, with no React-managed child
fibers; a layout effect adopts the existing nodes and applies checked bindings.
Keyed lists reuse and move their existing host nodes. Focus and text selection
are retained around these moves, without changing the application's tab order.
Forms, controls, resources and custom components keep their ordinary paths.

The initial HTML baseline is local to the mounted component. It stays stable
while the DOM ownership mode is active and is reset when switching modes. Valid
small models continue through that same mode, avoiding a remount just because
a list shrank. Unsupported input still runs the original server fallback; a
failed browser adoption switches that instance to ordinary React. It does not
retry indefinitely. Authentication-driven component resets remain unchanged.

Plans reject ambiguous HTML nesting and unsupported ownership, including keyed
roots outside mapped rows. A map's specialized row root must be an intrinsic
element. More general shapes retain the existing React template.

## Direct packed display data

The fused projector can reserve rows directly in one bounded scalar pool. It
does not allocate an intermediate array for each row. Nested lists contain
checked offsets and strides. A bounded prefix probe keeps ordinary numeric or
mostly unique short-string tables flat; a complete estimate can select typed
numeric/tag columns and deduplicated strings when it predicts at least 25%
uncompressed saving. This estimate is not a gzip/Brotli saving guarantee.
Only official Flight binary records carry these columns.

A build-generated HTML writer reads this packet directly. The specialized SSR
path does not reconstruct row arrays or a React element for each host node.
Routing, the outer Flight decoder, streaming, Suspense and Server Actions remain
under the existing React pipeline. This is not a replacement of the Flight
protocol or an elimination of all encode/decode work.

The scalar pool is capped at one million cells; existing input, HTML and node
budgets also apply. Ordinary React recovery reads the same plan and packet, without a duplicate JSX template or reconstruction of the original row arrays. No shared request/output cache is introduced. Reports include DOM
eligibility, packet mode, template bytes and cold-runtime cost estimates. Those
estimates describe a workload, not a universal speedup or a runtime size cutoff.

## Conditions, local helpers and static SVG

Equivalent JSX shapes are merged into server-evaluated scalar choices. Thus two
equal outputs do not disclose the condition that selected their source branch.
A branch selector is allowed only for distinguishable host geometry or checked
literal markup. Only active display-region fields and literals are transferred;
unknown equivalence retains ordinary rendering.

Checked tag and attribute names remain browser-visible template structure.
Inactive literal values, private operands and source helper implementations are
not part of that template.

Discovery can inline immutable, local scalar helper expressions in its analysis
copy. It resolves lexical bindings, bounds expansion, checks declaration order
and requires every argument to be used. Imports, recursion, effects, boundaries,
opaque closures and unverified calls remain ordinary. The original fallback
closure retains the source helper call, arguments and evaluation order.

Literal SVG supports a small checked set of shapes and attributes with proper
SVG namespaces. Resource references, event handlers, animation, `foreignObject`
and dynamic SVG input remain ordinary. No application function is executed for
static discovery.

## Validation and measurement

Relevant checks include:

```sh
npm run test:unit
npm run test:types
npm run test:browser:compat -- tests/browser/presentation.spec.mjs
NODE_ENV=production node --expose-gc tests/performance/presentation-pipeline.mjs result.json
```

The last command is an algorithm-only microbenchmark: fused versus two-pass
projection, and specialized versus normal React SSR on the same checked model.
It checks equal output and alternates three sample pairs. It is not a
release-versus-release HTTP or end-user performance claim. Compare complete
builds, response bytes, cold browser JavaScript and representative applications
before making a release-level claim. The synthetic table multiplier from
0.1.22-alpha does not describe every page or Next.js.

For a complete local HTTP comparison against a separate verified 0.1.22-alpha
checkout with its build dependencies installed:

```sh
NODE_ENV=production node tests/performance/presentation-release-comparison.mjs /path/to/baseline-checkout result.json
```

This uses the same fixtures, Node process executable and native server for both
builders. It alternates three sample pairs, validates every measured response,
compares exact presentation HTML and checks fresh browser contexts. The report
records source/executable hashes, decoded response bytes, browser resources and
individual measurement windows. It requires the test browser installation and
a verified native binary, like the integration tests. Its short windows on a
shared development machine are diagnostic evidence, not production latency
guarantees or results for a different application.
