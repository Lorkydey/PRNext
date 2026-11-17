# Host source synchronization

This feature is unreleased. It requires a CLI build containing `pull` and `push`
and a Host server advertising `capabilities.sourceSync.protocol: 1`. Installing a
previously published CLI version does not add these commands.

## Pull, edit, push, deploy

```sh
prnext login --server https://app.prnext.dev
prnext pull my-site --project PROJECT_UUID
cd my-site
# Edit your source files locally.
prnext push --message "Update the menu"
prnext push --deploy
```

On Windows, use `prnext` or `prnext.cmd`. The Unix alias `prn` is a reserved
Windows device name.

The first pull uses an empty destination. Later pulls preserve local changes
when upstream did not change the same file. If both sides edited a file, pull
stops before replacing any source. Reconcile the changes or pull into a separate
empty directory; the CLI does not perform a three-way text merge.

Push transfers only added or modified files and explicit removals of previously
tracked files. The server checks the base revision before saving a new immutable
snapshot. A stale push fails with `source_conflict`; no force option is provided.
Normal project access, resource limits and billing still govern deployment.
`push --deploy` pins the saved revision and checks that it is still the current
source before queuing a deployment. A queued deployment is not a ready site.

## Connected GitHub repositories

The workspace owner chooses the repository and branch, then enables source
access in the project's Source page. Permission to open pull requests is a
separate choice. Team members cannot use this connection to choose another
repository owned by that account.

Pull captures an immutable commit from the authorized branch. Push creates a
separate `prnext/source-*` branch and a pull request. It does not modify the
configured branch, force-push, merge, bypass repository checks or deploy the PR.
Review it in GitHub, wait for required checks, merge, pull the merged source and
run `prnext push --deploy`.

A folder remembers its submitted PR to avoid duplicate requests. Until those
changes appear on the configured branch, another changed push requires merging
and pulling or explicitly clearing the local submission with `push --cancel`.
Use your Git client for larger branch workflows. The Host GitHub path currently
supports 100 changed files per push and 10 MiB per changed file. GitHub Actions
workflow changes and Git links must be managed through GitHub/Git directly.

## Recovery, history and exclusions

- Interrupted pushes retain the same request ID and resume verified chunks.
  Retry the same command with the same local bytes. If you need to change those
  bytes, `prnext push --cancel` clears the unfinished transfer first. Saved
  versions, queued deployments and already-created GitHub PRs remain intact.
- Pull verifies every downloaded file and stages replacements with a recovery
  journal. A subsequent command recovers an interrupted installation. If a newer
  local edit conflicts with recovery, the CLI preserves it and the backup and
  reports the recovery directory for manual resolution.
- `pull --revision VERSION_UUID` retrieves a retained older snapshot into the
  selected folder. Pushing that stale baseline still requires reconciliation.
  The dashboard can explicitly deploy a retained version without rewriting it.
- `pull --dry-run` and `push --dry-run` list planned changes without replacing or
  uploading source. An unfinished local recovery must be resolved first.
- Secrets in environment variables are never downloaded. `.env*`, private keys,
  credential files, dependencies, Git metadata and build/cache output are excluded;
  root `.gitignore` and `.prnextignore` are respected when pushing. Inline values
  written in application code remain part of that code. Never commit secrets.
- Terminal credentials stay outside the project. `.prnext-cloud/` contains only
  local linking/synchronization metadata and temporary source recovery files;
  it is always excluded from PRNext source uploads.

## Protocol 1

All endpoints require the authenticated workspace/project identity. Browser
mutations additionally require the application Origin and CSRF token. Machine
credentials have scoped route access. Source downloads are private responses;
no bearer token is embedded in a download URL.

| Endpoint under `/api/projects/:projectId/source` | Purpose                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| `GET /`                                          | Manifest, limits, current/deployed revision and paginated file metadata |
| `POST /pull`                                     | Capture the authorized GitHub commit, or return autonomous source       |
| `GET /file?revision=&path=&offset=&length=`      | Exact file bytes as bounded base64 chunks                               |
| `GET /download?revision=`                        | Authenticated ZIP of a retained revision                                |
| `GET /history`                                   | Retained source version metadata                                        |
| `POST /changesets`                               | Reserve a push with UUID, base revision, message and explicit changes   |
| `PUT /changesets/:id/files/:index/chunks/:part`  | Upload one 1 MiB chunk, including retry checksum checks                 |
| `POST /changesets/:id/commit`                    | Verify and atomically save; return a revision or GitHub PR              |
| `GET /changesets/:id`                            | Recover the originating actor's transfer/result                         |
| `DELETE /changesets/:id`                         | Cancel that actor's uncommitted temporary transfer                      |
| `PUT /github`                                    | Owner dashboard authorization for the configured repository             |

Manifest files contain portable relative `path`, byte `size` and hexadecimal
`sha256`. The manifest `sourceHash` is SHA256 of UTF-8
`JSON.stringify(files.map(({path,size,sha256}) => [path,size,sha256]))` in the
server's manifest order. Pagination pins the same revision and order. File reads
are at most 256 KiB; source limits are returned by the server and clamped by the
client. Request IDs are reused for retries and cannot be reused with changed
metadata. Deletions require explicit paths; omission of an unchanged file does
not delete it.

Paths use NFC-normalized Unicode, reject Windows device names and ambiguous
case collisions, and cannot contain links or traverse outside the project.

MCP source access uses a separate `source` permission in addition to the required
base `read` permission. Existing read grants do not gain source access. Source
push/refresh/cancel tools also require `deploy`. MCP pushes accept 50 changed
files and 1 MiB of changed bytes; the CLI supports the server's larger limits.
