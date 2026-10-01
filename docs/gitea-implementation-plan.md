# Gitea PR lifecycle: implementation plan

Upstream baseline: `479a4a07476de474259580d8db59807770ca98da`.

Current branch status: the forge adapter, native Gitea webhook route, retrying delivery queue and provider identity columns are implemented. The worker stores the live PR state, exact head SHA and source fork identity. It queues teardown for an existing build when the live PR is closed or loses its deploy label. Configuration lookup for a Gitea PR is pinned to its head SHA, including a source fork. The native builder can clone that fork at the stored SHA after checking the live PR, with credentials in an ephemeral Kubernetes Secret and the configured CA mounted into the clone container. An enabled PR now creates a build, signals the existing reconciliation queue with an idempotent head token, and posts a marked Gitea status comment with service URLs. This path has unit coverage but has not yet been demonstrated against a running Gitea and Kubernetes setup.

## Existing path

- `src/pages/api/webhooks/github.ts` verifies a GitHub signature, serialises the request and queues it. `GithubService.dispatchWebhook` verifies again and routes PR, push, label and comment events.
- `GithubService.handlePullRequestHook` finds an onboarded repository by GitHub installation and repository IDs, reads `lifecycle.yaml` at the PR head SHA for the initial decision, creates the PR and build, and queues reconciliation. Push events drive later updates.
- `RepositoryService`, `PullRequestService`, `server/lib/github` and `GlobalConfigService` supply GitHub App authentication, repository/PR lookup and YAML. `DeployableService` reads config again during reconciliation. `DeployService` selects source SHAs.
- `nativeBuild`, `nativeHelm` and Helm/Codefresh paths use GitHub clone URLs or credentials. `ActivityStream` writes GitHub PR comments. `TTLCleanupService` re-reads GitHub labels; `BuildService` already has a retrying deletion queue and guards queued work against a closed PR.

## Review batches

1. Introduce a small forge contract and Gitea adapter for authenticated repository/PR lookup, exact-SHA file content, clone access and idempotent status comments. Add raw-body signature verification and event mapping using Gitea's delivery and event-type headers. Keep the existing GitHub route and adapter behaviour.
2. Add provider identity columns and a native Gitea webhook intake queue. Resolve each delivery against the current PR state, store its exact head SHA and exclude Gitea rows from the GitHub repository UI. Keep deployment disabled while the source and clone paths still assume GitHub.
3. Record the PR head repository identity, read its configuration at the exact head SHA, use current labels for the Gitea cleanup gate and queue teardown for existing builds when the current PR closes or loses its deploy label. Keep build creation disabled until the source and clone paths are complete.
4. Pin a native build to the stored Gitea source fork and exact SHA. Check the live PR before cloning. Supply Git credentials and the configured CA through an ephemeral Kubernetes Secret. Preserve the GitHub native build path.
5. Wire the stored Gitea PR to the existing build and deploy queues. Resolve source IDs without a GitHub repository ID, pin any Helm chart clone, and guard queued work against closure or a superseded head. Adapt status comments and TTL checks through the forge boundary. The first part is this batch: queue admission, null source IDs and status comments. Helm and TTL remain for a later batch.
6. Run the database migration and complete a local Gitea/Kubernetes open → deploy → update → close demonstration. Record configuration, commands, observed results, limitations and remaining GitHub-specific paths. Open a PR for each completed batch and wait for acceptance before merging.

The first release should support one onboarded repository and its PR lifecycle. Cross-repository YAML dependencies, Codefresh and agent workspace tooling remain GitHub-specific until a separate experiment establishes their Gitea requirements. The lab's Argo CD topology is outside this fork's change.

## Adapter configuration reserved for the Gitea integration

These variables are read by the Gitea adapter and webhook intake. The route is `/api/webhooks/gitea`; it returns 503 until all required variables are configured. Accepted deliveries refresh PR metadata and now signal build reconciliation or teardown. The local end-to-end demonstration is still pending.

| Variable | Purpose |
| --- | --- |
| `GITEA_BASE_URL` | HTTPS URL of the instance, including any installation path. Its presence enables adapter configuration loading. |
| `GITEA_TOKEN` | Bot personal access token for API reads, Git over HTTPS and issue comments. |
| `GITEA_USERNAME` | Bot username for Git over HTTPS. |
| `GITEA_WEBHOOK_SECRET` | Current HMAC secret. |
| `GITEA_WEBHOOK_SECRET_PREVIOUS` | Optional previous secret during rotation. Remove it after deliveries signed with the old secret have drained. |
| `GITEA_CA_FILE` | Optional PEM file for the API client and the native build clone container's trusted CA. |
| `GITEA_ALLOW_HTTP` | Set to `true` only for a loopback demonstration without TLS. |
| `GITEA_REPOSITORY` | The single allowed repository in `owner/name` form for this first release. |
| `GITEA_ENVIRONMENT_ID` | ID of an existing Lifecycle environment to bind to the Gitea repository row. |

The queue uses `X-Gitea-Delivery` as a deterministic job ID. Completed IDs remain for up to seven days or 100,000 jobs; a failed job is removed after five retry attempts so Gitea redelivery can requeue it. The worker fetches the current PR under a per-PR lock, so an old close delivery cannot overwrite a reopened PR's state. It stores no signed body in Redis or the database.

The native build service account needs permission to create and delete Secrets in each build namespace. The clone Secret contains the bot username, token and optional CA. It is deleted when the build finishes or fails; a worker crash can leave it behind until the namespace is removed. Job manifests contain only Secret references. The PR head is checked immediately before a native build; a later close or force-push still needs the existing build cancellation and reconciliation path to be fully connected.

The remaining integration conflict is in Helm chart cloning, cross-repository dependencies, Codefresh and TTL checks: they still use GitHub. The next experiment should pin the Helm chart path or explicitly scope the first release to a native service, add Gitea-aware lease cleanup, then exercise one PR against local Gitea and Kubernetes. The status comment uses the Gitea API and a stable marker; the existing GitHub comment flow remains in place.

The intended minimum Gitea token scopes are `read:repository` for PR and exact-commit content reads and `write:issue` for the status comment. The bot also needs read access to the code unit of every private repository it builds, including a PR's source fork. Repository webhook administration can be performed separately by an administrator; the runtime token does not need that permission. These scopes follow [Gitea's API token permissions](https://docs.gitea.com/1.26/development/api-usage/) and [repository units](https://docs.gitea.com/1.24/usage/permissions/).
