# Gitea PR lifecycle: implementation plan

Upstream baseline: `479a4a07476de474259580d8db59807770ca98da`.

Current branch status: the forge adapter, native Gitea webhook route, retrying delivery queue and provider identity columns are implemented. The worker stores the live PR state, exact head SHA and source fork identity. It queues teardown for an existing build when the live PR is closed or loses its deploy label. Configuration lookup for a Gitea PR is pinned to its head SHA, including a source fork. The worker does not yet create or update builds, deploy, or post status comments. Configuring these variables does not enable Gitea environments.

## Existing path

- `src/pages/api/webhooks/github.ts` verifies a GitHub signature, serialises the request and queues it. `GithubService.dispatchWebhook` verifies again and routes PR, push, label and comment events.
- `GithubService.handlePullRequestHook` finds an onboarded repository by GitHub installation and repository IDs, reads `lifecycle.yaml` at the PR head SHA for the initial decision, creates the PR and build, and queues reconciliation. Push events drive later updates.
- `RepositoryService`, `PullRequestService`, `server/lib/github` and `GlobalConfigService` supply GitHub App authentication, repository/PR lookup and YAML. `DeployableService` reads config again during reconciliation. `DeployService` selects source SHAs.
- `nativeBuild`, `nativeHelm` and Helm/Codefresh paths use GitHub clone URLs or credentials. `ActivityStream` writes GitHub PR comments. `TTLCleanupService` re-reads GitHub labels; `BuildService` already has a retrying deletion queue and guards queued work against a closed PR.

## Review batches

1. Introduce a small forge contract and Gitea adapter for authenticated repository/PR lookup, exact-SHA file content, clone access and idempotent status comments. Add raw-body signature verification and event mapping using Gitea's delivery and event-type headers. Keep the existing GitHub route and adapter behaviour.
2. Add provider identity columns and a native Gitea webhook intake queue. Resolve each delivery against the current PR state, store its exact head SHA and exclude Gitea rows from the GitHub repository UI. Keep deployment disabled while the source and clone paths still assume GitHub.
3. Record the PR head repository identity, read its configuration at the exact head SHA, use current labels for the Gitea cleanup gate and queue teardown for existing builds when the current PR closes or loses its deploy label. Keep build creation disabled until the source and clone paths are complete.
4. Wire the stored Gitea PR to the existing build and deploy queues. Pin the native build and any Helm chart clone to the source repository and exact head SHA. Guard queued work against a closed or superseded PR. Adapt status comments and TTL checks through the forge boundary.
5. Run the database migration and complete a local Gitea/Kubernetes open → deploy → update → close demonstration. Record configuration, commands, observed results, limitations and remaining GitHub-specific paths. Open a PR for each completed batch and wait for acceptance before merging.

The first release should support one onboarded repository and its PR lifecycle. Cross-repository YAML dependencies, Codefresh and agent workspace tooling remain GitHub-specific until a separate experiment establishes their Gitea requirements. The lab's Argo CD topology is outside this fork's change.

## Adapter configuration reserved for the Gitea integration

These variables are read by the Gitea adapter and webhook intake. The route is `/api/webhooks/gitea`; it returns 503 until all required variables are configured. Accepted deliveries refresh PR metadata and may queue teardown of an existing build. Do not use this batch as an operating guide for environments.

| Variable | Purpose |
| --- | --- |
| `GITEA_BASE_URL` | HTTPS URL of the instance, including any installation path. Its presence enables adapter configuration loading. |
| `GITEA_TOKEN` | Bot personal access token for API reads, Git over HTTPS and issue comments. |
| `GITEA_USERNAME` | Bot username for Git over HTTPS. |
| `GITEA_WEBHOOK_SECRET` | Current HMAC secret. |
| `GITEA_WEBHOOK_SECRET_PREVIOUS` | Optional previous secret during rotation. Remove it after deliveries signed with the old secret have drained. |
| `GITEA_CA_FILE` | Optional PEM file for the API client's trusted CA. The future build clone path must trust the same CA separately. |
| `GITEA_ALLOW_HTTP` | Set to `true` only for a loopback demonstration without TLS. |
| `GITEA_REPOSITORY` | The single allowed repository in `owner/name` form for this first release. |
| `GITEA_ENVIRONMENT_ID` | ID of an existing Lifecycle environment to bind to the Gitea repository row. |

The queue uses `X-Gitea-Delivery` as a deterministic job ID. Completed IDs remain for up to seven days or 100,000 jobs; a failed job is removed after five retry attempts so Gitea redelivery can requeue it. The worker fetches the current PR under a per-PR lock, so an old close delivery cannot overwrite a reopened PR's state. It stores no signed body in Redis or the database.

The remaining integration conflict is in native Git clone, deployable source IDs, status comments and TTL checks: they directly use GitHub. The next experiment should build one service from one Gitea repository at a pinned SHA using the existing native builder, then extend only the provider lookups those paths require. Cross-repository dependencies and Codefresh can remain outside the first release.

The intended minimum Gitea token scopes are `read:repository` for PR and exact-commit content reads and `write:issue` for the status comment. The bot also needs read access to the code unit of every private repository it builds, including a PR's source fork. Repository webhook administration can be performed separately by an administrator; the runtime token does not need that permission. These scopes follow [Gitea's API token permissions](https://docs.gitea.com/1.26/development/api-usage/) and [repository units](https://docs.gitea.com/1.24/usage/permissions/).
