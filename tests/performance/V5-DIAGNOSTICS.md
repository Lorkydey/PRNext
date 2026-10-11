# V5 GC and ETW diagnostics

Prepared separately from the uninstrumented HTTP comparisons. Do not run during a build, throughput measurement, idle cycle, or endurance test. No runtime module imports these probes.

## GC observer and Windows runner

First validate the observer in a dedicated short window:

```powershell
& .\artifacts\performance\node24\node.exe --test tests/performance/gc-observer-v5.test.cjs
```

Then reserve approximately five minutes for six instrumented SSR runs (10 seconds warmup + 30 seconds diagnostic each):

```powershell
python tests/performance/windows-gc-v5.py --execute --output artifacts/performance-v5/gc/final-comparison
```

The variants are v4 (`reference-v4/prnext-v4.exe`, `.prnext-v4-final`), no-size (`candidates/no-size/prnext.exe`, `.prnext-v5-no-size`), and final (`prnext-v5.exe`, `.prnext-v5-final`), each with `balanced` and `memory`. `--final-binary` permits an explicit alternative final binary. All builds must exist before the command can reserve its output. Defaults: exact Node 24.19, SSR/64 connections, server CPU 10, generator CPUs 8/9, port 32960. All commands, observer/generator/runner snapshots, source hashes, raw logs, Job samples, and isolate traces are retained. An existing output directory is always refused; an interrupted attempt requires a new name.

`NODE_OPTIONS --require` loads the copied observer in the host and RSC isolates, including the RSC worker's explicit `execArgv`. The prepared smoke test verifies actual worker coverage before trusting a campaign. Node documents that `--require` modules preload in workers. [Node 24.19 command-line documentation](https://nodejs.org/download/release/v24.19.0/docs/api/cli.html#-r---require-module)

Each isolate records its PID/threadId, Node/V8 versions, arguments, relevant environment flags, V8 flag fingerprint, worker resource limits, GC counters by kind, and heap samples every second. The sampler is unref'ed and stops without stopping application work. Defaults bound the run to 64 exclusively claimed files and each trace to 512 KiB, 120 records, and 120 seconds. Limits reserve a final stop record; hitting a limit invalidates campaign coverage. No per-GC-event array is retained. GC uses the current `entry.detail.kind` API and elapsed durations from performance entries. [Node 24.19 GC details](https://nodejs.org/download/release/v24.19.0/docs/api/perf_hooks.html#garbage-collection-gc-details)

Interpretation rules:

- CPU and process RSS come from the existing Windows Job accounting, including terminated children. Isolate `heapUsed`, `heapTotal`, `external`, and `arrayBuffers` are reported separately. Shared process RSS is omitted from isolate files; never sum RSS by thread. [Node 24.19 memory accounting](https://nodejs.org/download/release/v24.19.0/docs/api/process.html#processmemoryusage)
- GC event duration is not CPU time. Events and isolates may overlap; the report does not sum them into a CPU percentage.
- Window counters use first/last samples entirely within the diagnostic phase and expose their exact coverage. Observer delivery is asynchronous, so these are sampled diagnostic boundaries rather than an exact attribution of all events to HTTP requests.
- Synchronous trace writes, performance observation, heap sampling, and the extra interval affect execution. Throughput and latency logged here describe the instrumented run only; they are not evidence of an end-to-end speedup.
- Job termination may skip JS exit hooks. Periodic JSONL records are durable; a missing exit record alone does not prove a leak. Missing host/worker traces, truncated JSON, resource caps, insufficient phase coverage, concurrent builds, changed application inputs, or HTTP errors fail the run explicitly.

## ETW

The separate `windows-etw-v5.py` and `analyze-etw-v5.py` prepare the two static v4/final traces without changing the V4 scripts or evidence. Consult their command-line help before execution. ETW's instrumented resource distribution must remain separate from the uninstrumented performance comparison.

## Lifecycle analysis after the campaign

```powershell
python tests/performance/lifecycle-v5.py --output artifacts/performance-v5/lifecycle-final.json
python tests/performance/report-v5.py
```

The analyzer is read-only and refuses to overwrite its JSON output. The report also analyzes the raw sources directly, so an old standalone summary cannot silently become current evidence. Metrics and metadata files plus benchmark, idle, soak, and functional server logs are hashed. Test logs containing deliberately injected failures are excluded. Invalid JSON lines, timestamp gaps, non-monotonic counters, incomplete phase coverage, and nonzero gauges at the end of expected quiet fixture phases remain visible.

`hostStarts`, normal consumer cancellations, failed requests, discarded transport lanes, idle retirements, graceful drains, and watchdog kills remain separate columns. Counter deltas cover the displayed sample boundaries. Sub-second resume probes cannot be expected to have two one-second metric samples. Log categories are non-exhaustive and may overlap; untimed messages are not assigned an invented phase. Neither discarded lanes nor log counts are reported as an exhaustive count of killed Node hosts or RSC isolate replacements.

Prepared parser checks (no server or load generator):

```powershell
python -m unittest discover -s tests/performance -p test_lifecycle_v5.py
python -m unittest discover -s tests/performance -p test_report_v5.py
```
