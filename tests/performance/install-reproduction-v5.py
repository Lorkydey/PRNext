"""Reproduce original/fixed npm ci in fresh, bounded source copies; never a benchmark.

Prepared during HTTP screening. Execute only after the benchmark owner frees the
machine. The archive, fixtures, logs, npm caches and result are never overwritten.
No dependency upgrade, root node_modules mutation, or cleanup deletion is done.
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import time
import zipfile


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "artifacts/performance-v5/install-reproduction"
COMMIT = "63847087826f178de3a32f165231b20b6c66b92e"
PROOF = ROOT / "artifacts/performance/npm-ci-node24.19.json"
EXPECTED_NODE_SHA = "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237"
EXPECTED_LOCK_SHA = "7ee2fd2fc24826ecd159f9b6bf7e23845ebf72d90af9dff459f3b8b399ec4029"
NATIVE = (
    "prnext-darwin-arm64", "prnext-darwin-x64",
    "prnext-linux-arm64-gnu", "prnext-linux-x64-gnu",
    "@thomas.f/prnext-win32-arm64-msvc", "@thomas.f/prnext-win32-x64-msvc",
)


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    # Every evidence file is written once. Interrupted attempts remain inspectable.
    with Path(path).open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def bounded(path, parent):
    resolved, resolved_parent = Path(path).resolve(), Path(parent).resolve()
    if resolved == resolved_parent or not resolved.is_relative_to(resolved_parent):
        raise ValueError(f"Path outside the intended directory: {resolved}")
    return resolved


def source_map(folder, files):
    return {name: sha(bounded(folder / name, folder)) for name in files}


def extract(archive, destination):
    """Validate every entry before creating the fresh extraction directory."""
    destination = bounded(destination, OUT)
    if destination.exists():
        raise FileExistsError(f"Refusing existing fixture: {destination}")
    entries, names, total = [], set(), 0
    reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)),
                *(f"LPT{i}" for i in range(1, 10))}
    with zipfile.ZipFile(archive) as source:
        for item in source.infolist():
            name = item.filename
            parts = name.rstrip("/").split("/")
            if (not name or name.startswith(("/", "\\")) or "\\" in name
                    or any(part in ("", ".", "..") or ":" in part
                           or part.rstrip(" .") != part
                           or part.split(".")[0].upper() in reserved for part in parts)):
                raise ValueError(f"Unsafe archive path: {name!r}")
            canonical = PurePosixPath(*parts).as_posix()
            if canonical.casefold() in names:
                raise ValueError(f"Duplicate/case-alias archive path: {name!r}")
            names.add(canonical.casefold())
            mode = item.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or stat.S_ISLNK(mode):
                raise ValueError(f"Archive link/special file rejected: {name!r}")
            target = bounded(destination.joinpath(*parts), destination)
            total += item.file_size
            if item.file_size > 256 * 1024**2 or total > 2 * 1024**3:
                raise ValueError("Source archive exceeds the extraction bound")
            entries.append((item, target, canonical))
        destination.mkdir()
        files = []
        for item, target, canonical in entries:
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(item) as src, target.open("xb") as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
                if target.stat().st_size != item.file_size:
                    raise ValueError(f"Extracted size mismatch: {canonical}")
                files.append(canonical)
    return sorted(files)


class Job:
    """Own npm's descendant tree, including cleanup on timeout or interruption."""
    def __init__(self):
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.api.CreateJobObjectW.restype = wintypes.HANDLE
        for name, arguments in (
            ("AssignProcessToJobObject", [wintypes.HANDLE, wintypes.HANDLE]),
            ("SetInformationJobObject", [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]),
            ("TerminateJobObject", [wintypes.HANDLE, wintypes.UINT]),
            ("CloseHandle", [wintypes.HANDLE]),
        ):
            operation = getattr(self.api, name)
            operation.argtypes, operation.restype = arguments, wintypes.BOOL
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        class BasicLimits(ctypes.Structure):
            _fields_ = [("processTime", ctypes.c_int64), ("jobTime", ctypes.c_int64),
                        ("flags", wintypes.DWORD), ("minWorkingSet", ctypes.c_size_t),
                        ("maxWorkingSet", ctypes.c_size_t), ("activeLimit", wintypes.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                        ("scheduling", wintypes.DWORD)]
        class Limits(ctypes.Structure):
            _fields_ = [("basic", BasicLimits), ("io", ctypes.c_ulonglong * 6),
                        ("processMemory", ctypes.c_size_t), ("jobMemory", ctypes.c_size_t),
                        ("peakProcess", ctypes.c_size_t), ("peakJob", ctypes.c_size_t)]
        limits = Limits()
        limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE, also if this harness dies.
        if not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.WinError(ctypes.get_last_error())
            self.api.CloseHandle(self.handle)
            raise error

    def assign(self, process):
        if not self.api.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self):
        # Termination after npm exits also removes an unexpected surviving child.
        # Nothing outside this newly created Job belongs to this cleanup scope.
        failure = None
        if not self.api.TerminateJobObject(self.handle, 1):
            failure = ctypes.WinError(ctypes.get_last_error())
        if not self.api.CloseHandle(self.handle) and failure is None:
            failure = ctypes.WinError(ctypes.get_last_error())
        if failure is not None:
            raise failure


def run(label, command, cwd, env, timeout):
    record = {"command": [str(v) for v in command], "cwd": str(cwd),
              "startedAt": now(), "exitCode": None, "error": None,
              "stdout": str(OUT / f"{label}.stdout.log"),
              "stderr": str(OUT / f"{label}.stderr.log")}
    write_json(OUT / f"{label}.command.json", record)
    started, process, job = time.perf_counter(), None, None
    try:
        with open(record["stdout"], "xb") as stdout, open(record["stderr"], "xb") as stderr:
            job = Job()
            process = subprocess.Popen(record["command"], cwd=cwd, env=env,
                                       stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                       creationflags=subprocess.CREATE_NO_WINDOW)
            job.assign(process)
            record["exitCode"] = process.wait(timeout=timeout)
    except BaseException as error:
        record["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        if job is not None:
            try:
                job.close()
            except BaseException as error:
                record["cleanupError"] = {"type": type(error).__name__, "message": str(error)}
        if process is not None and process.poll() is None:
            # Covers assignment failure: only this npm root process is targeted.
            process.kill()
            process.wait(timeout=10)
        record["finishedAt"] = now()
        record["durationSeconds"] = time.perf_counter() - started
        for stream in ("stdout", "stderr"):
            path = Path(record[stream])
            if path.exists():
                record[stream + "Sha256"] = sha(path)
        write_json(OUT / f"{label}.exit.json", record)
    return record


def output(record):
    return "\n".join(Path(record[key]).read_text(encoding="utf-8", errors="replace")
                     for key in ("stdout", "stderr"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cpus", default="4,5")
    parser.add_argument("--timeout", type=int, default=1200)
    args = parser.parse_args()
    if os.name != "nt":
        raise SystemExit("This reproduction is pinned to the Windows installation evidence")
    cpus = [int(part) for part in args.cpus.split(",")]
    if not cpus or len(set(cpus)) != len(cpus) or any(c < 0 or c > 63 for c in cpus):
        raise ValueError("Invalid CPU affinity list")
    intended = bounded(OUT, ROOT / "artifacts/performance-v5")
    if intended != OUT.absolute() or OUT.exists():
        raise FileExistsError("The output must be a new non-redirected directory; nothing overwritten")
    for name in ("original", "lock-fixed"):
        bounded(OUT / name, OUT)
    OUT.mkdir()
    write_json(OUT / "started.json", {"startedAt": now(), "commit": COMMIT,
               "plannedDirectories": [str(OUT / v) for v in ("original", "lock-fixed")],
               "cpus": cpus, "harnessSha256": sha(__file__)})
    shutil.copyfile(__file__, OUT / "install-reproduction-v5.py")
    result = {"complete": False, "expectedOutcomeMatched": False,
              "referenceCommit": COMMIT, "cpus": cpus, "runs": [], "error": None,
              "note": "Installation reproduction, not throughput or cross-platform validation."}
    try:
        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.GetCurrentProcess.restype = wintypes.HANDLE
        api.SetProcessAffinityMask.argtypes = [wintypes.HANDLE, ctypes.c_size_t]
        api.SetProcessAffinityMask.restype = wintypes.BOOL
        if not api.SetProcessAffinityMask(api.GetCurrentProcess(), sum(1 << c for c in cpus)):
            raise ctypes.WinError(ctypes.get_last_error())
        proof = json.loads(PROOF.read_text(encoding="utf-8-sig"))
        node, npm = Path(proof["nodeExecutable"]), Path(proof["npmCli"])
        npm_package = npm.parent.parent / "package.json"
        if sha(node) != EXPECTED_NODE_SHA or sha(ROOT / "package-lock.json") != EXPECTED_LOCK_SHA:
            raise ValueError("Pinned Node or fixed lockfile changed; preserve this attempt and investigate")
        if json.loads(npm_package.read_text(encoding="utf-8"))["version"] != "11.12.1":
            raise ValueError("Existing npm is no longer 11.12.1; no implicit tool installation")
        # Keep credentials and unrelated npm config out of the reproduction.
        env = {key: value for key, value in os.environ.items()
               if not key.upper().startswith(("NPM_CONFIG_", "PRNEXT_"))
               and key.upper() not in ("NODE_OPTIONS", "NODE_ENV", "NODE_PATH", "NODE_V8_COVERAGE")}
        empty_user, empty_global = OUT / "user.npmrc", OUT / "global.npmrc"
        empty_user.touch(exist_ok=False)
        empty_global.touch(exist_ok=False)
        env.update(PATH=str(node.parent) + os.pathsep + os.environ.get("PATH", ""),
                   npm_config_userconfig=str(empty_user), npm_config_globalconfig=str(empty_global),
                   npm_config_cache=str(OUT / "cache-tooling"), NO_COLOR="1",
                   NEXT_TELEMETRY_DISABLED="1")
        result["tools"] = {"node": str(node), "nodeSha256": sha(node), "npmCli": str(npm),
                           "npmCliSha256": sha(npm), "npmPackageSha256": sha(npm_package),
                           "historicalEvidenceSha256": sha(PROOF)}
        result["environment"] = {
            "nodeDirectoryFirstInPath": str(node.parent),
            "removedInheritedVariables": ["NPM_CONFIG_*", "PRNEXT_*", "NODE_OPTIONS", "NODE_ENV", "NODE_PATH", "NODE_V8_COVERAGE"],
            "npmUserConfig": str(empty_user), "npmGlobalConfig": str(empty_global),
            "noColor": True, "nextTelemetryDisabled": True,
        }
        for name, command, expected in (
            ("node-version", [node, "--version"], "v24.19.0"),
            ("npm-version", [node, npm, "--version"], "11.12.1"),
            ("commit", ["git", "rev-parse", COMMIT + "^{commit}"], COMMIT),
        ):
            record = run(name, command, ROOT, env, 30)
            if record["exitCode"] != 0 or record["error"] or output(record).strip() != expected:
                raise RuntimeError(f"Pinned {name} check failed; see preserved logs")
        result["tools"].update(nodeVersion="v24.19.0", npmVersion="11.12.1")
        archive = OUT / "reference.zip"
        archived = run("git-archive", ["git", "archive", "--format=zip", "--output=" + str(archive), COMMIT], ROOT, env, 60)
        if archived["exitCode"] != 0 or archived["error"]:
            raise RuntimeError("git archive failed")
        result["archiveSha256"] = sha(archive)
        original, fixed = OUT / "original", OUT / "lock-fixed"
        files = extract(archive, original)
        if extract(archive, fixed) != files:
            raise ValueError("Archive source inventories differ")
        before = {"original": source_map(original, files), "lock-fixed": source_map(fixed, files)}
        if before["original"] != before["lock-fixed"]:
            raise ValueError("Archive source bytes differ before the lockfile replacement")
        shutil.copyfile(ROOT / "package-lock.json", fixed / "package-lock.json")
        before["lock-fixed"] = source_map(fixed, files)
        differences = [name for name in files if before["original"][name] != before["lock-fixed"][name]]
        if differences != ["package-lock.json"]:
            raise ValueError(f"Unexpected source differences: {differences}")
        result["sourceFileCount"] = len(files)
        result["sourceDifferences"] = differences
        write_json(OUT / "sources-before.json", before)
        for label, folder in (("original", original), ("lock-fixed", fixed)):
            local_env = {**env, "npm_config_cache": str(OUT / f"cache-{label}")}
            command = [node, npm, "ci", "--no-audit", "--no-fund", "--ignore-scripts=false",
                       "--include=dev", "--include=optional"]
            record = run(label, command, folder, local_env, args.timeout)
            record.update(label=label, scriptsEnabled=True, optionalDependenciesEnabled=True,
                          npmCache=local_env["npm_config_cache"])
            after = source_map(folder, files)
            write_json(OUT / f"{label}.sources-after.json", after)
            record["sourceChanges"] = [name for name in files if after[name] != before[label][name]]
            record["lockSha256Before"] = before[label]["package-lock.json"]
            record["lockSha256After"] = after["package-lock.json"]
            record["installedVersions"] = {}
            for package in ("react", "react-dom", "react-server-dom-webpack", "typescript", "esbuild", *NATIVE):
                package_file = folder / "node_modules" / package / "package.json"
                if package_file.is_file():
                    record["installedVersions"][package] = json.loads(package_file.read_text(encoding="utf-8"))["version"]
            combined = output(record)
            record["observedEusage"] = "EUSAGE" in combined
            record["allMissingEntries"] = re.findall(r"\bMissing:\s+(\S+)\s+from lock file", combined)
            record["missingNativeEntries"] = [name for name in NATIVE
                if f"Missing: {name}@0.1.11-alpha from lock file" in combined]
            result["runs"].append(record)
            # Always try the other copy after an unexpected exit code. A process
            # failure or cleanup failure is different: stop and retain its error.
            if record["error"] or record.get("cleanupError"):
                raise RuntimeError(f"Execution/cleanup failed for {label}")
        first, second = result["runs"]
        result["rootLockStillUnchanged"] = sha(ROOT / "package-lock.json") == EXPECTED_LOCK_SHA
        result["complete"] = True
        result["expectedOutcomeMatched"] = (
            first["exitCode"] != 0 and first["observedEusage"]
            and set(first["missingNativeEntries"]) == set(NATIVE)
            and set(first["allMissingEntries"]) == {name + "@0.1.11-alpha" for name in NATIVE}
            and second["exitCode"] == 0
            and not first["sourceChanges"] and not second["sourceChanges"]
            and result["rootLockStillUnchanged"])
    except BaseException as error:
        result["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        result["finishedAt"] = now()
        write_json(OUT / "result.json", result)
    print(json.dumps({"result": str(OUT / "result.json"), "complete": result["complete"],
                      "expectedOutcomeMatched": result["expectedOutcomeMatched"]}))
    return 0 if result["complete"] and result["expectedOutcomeMatched"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
