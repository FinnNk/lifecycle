# Gitea PR environments: installation and operation

This guide describes the first Gitea release in this fork. It uses Lifecycle's existing build, deployment and deletion queues. It has passed offline tests; the complete workflow has **not** yet been demonstrated against a running Gitea and Kubernetes installation. See [the implementation plan](gitea-implementation-plan.md) for the code trace, upstream baseline and remaining integration work.

## Supported workflow

One configured `owner/repository` can drive a PR environment. The PR needs the configured deploy label (by default `lifecycle-deploy!`) and must not have the disabled label (by default `lifecycle-disabled!`). Opening, synchronising, reopening or relabelling the PR reconciles the current PR state. A close or removal of the deploy label queues teardown. The TTL scanner reads the live Gitea labels, honours the keep label (`lifecycle-keep!` by default), and queues expiry through Lifecycle's deletion path.

Configuration is read from `lifecycle.yaml` in the PR's source repository at the exact head commit. The first release supports a native source service from that repository and Docker image dependencies. Helm chart sources, Codefresh, cross-repository YAML dependencies and agent workspace tooling remain GitHub-specific. Use a small, dedicated test repository whose configuration uses only the supported service types.

## Prepare an isolated installation

Use a dedicated Kubernetes cluster, PostgreSQL database, Redis instance, image registry and Gitea test repository. Give them names, network ports and storage distinct from the active lab. A separate host avoids resource contention; a second cluster on the same Docker host still shares CPU, memory and disk. Do not point Lifecycle at the lab's Argo CD applications, namespaces, database, Redis or registry. Keep the Kubernetes context explicit in every command.

The usual Lifecycle prerequisites still apply: a runnable web process (`LIFECYCLE_MODE=web`) and job process (`LIFECYCLE_MODE=job`), their database and Redis connections, a usable build service account, registry access, ingress and an existing Lifecycle environment. The chart's web and worker Deployments read `app-secrets` through `envFrom`, but the checked-in local values and Tilt setup are GitHub-oriented. Supply the Gitea variables to **both** processes using a separately managed Secret or equivalent deployment configuration. If using a private CA, mount its PEM file at the same `GITEA_CA_FILE` path in both processes; the native build then passes that CA to its clone container. The chart does not currently provide a dedicated Gitea CA volume setting.

Apply migrations `036_add_forge_pr_identity` and `037_add_pr_head_forge_identity` to the **isolated** Lifecycle database before sending a webhook. From a configured Lifecycle checkout, `pnpm db:migrate` runs the pending migrations. Confirm the database target first; this command acts on whichever database the configured `APP_DB_*` variables or `DATABASE_URL` select. Use the normal Lifecycle setup to create an environment, then record its numeric ID for `GITEA_ENVIRONMENT_ID`.

The native build service account needs `create` and `delete` on Kubernetes Secrets in its build namespaces. Lifecycle places the Gitea Git username, token and optional CA in a temporary Secret for each clone, then deletes it when the build ends. A worker crash can leave that Secret until its namespace is removed. Restrict access to those namespaces and use a short-lived, limited bot token.

## Configure Gitea and Lifecycle

Create a bot account with read access to the test repository and every private PR source fork that it may build. Give its personal access token `read:repository` for PR and exact-commit reads and `write:issue` for status comments and TTL label changes. The bot needs Git-over-HTTPS read access to those repositories as well. An administrator can create the repository webhook; the runtime token does not need webhook administration. Gitea's [token scopes](https://docs.gitea.com/development/api-usage/) and [repository permissions](https://docs.gitea.com/1.22/usage/permissions/) describe the server-side controls.

Set these variables in both Lifecycle processes. Store secret values in the installation's secret manager; do not put them in committed values files or command lines that are logged.

| Variable | Value |
| --- | --- |
| `GITEA_BASE_URL` | HTTPS origin and optional installation path, reachable by Lifecycle and build pods. No user information, query or fragment. |
| `GITEA_USERNAME` | Bot username for Git over HTTPS. |
| `GITEA_TOKEN` | Bot personal access token. |
| `GITEA_WEBHOOK_SECRET` | Shared HMAC secret for the webhook. |
| `GITEA_WEBHOOK_SECRET_PREVIOUS` | Optional previous secret during rotation only. |
| `GITEA_CA_FILE` | Optional absolute path to a trusted CA PEM file mounted in both processes. |
| `GITEA_REPOSITORY` | Exactly one `owner/repository` that Lifecycle may reconcile. |
| `GITEA_ENVIRONMENT_ID` | Numeric ID of the existing Lifecycle environment. |
| `GITEA_ALLOW_HTTP` | Leave unset or `false`; `true` permits HTTP only when the base URL's host is loopback. |

Keep certificate verification enabled. For a self-signed or private CA, mount the CA file rather than disabling TLS checks. The base URL must be reachable from both the API client and the Kubernetes clone job; a host's `localhost` is generally not the same address inside a pod.

In the selected Gitea repository, create a **Gitea** webhook with:

- Target URL: `https://<isolated-lifecycle-host>/api/webhooks/gitea`.
- Method `POST`, content type `application/json`, and the same secret as `GITEA_WEBHOOK_SECRET`.
- The Pull Request events for `pull_request`, `pull_request_sync` and `pull_request_label`. Other events may be subscribed to but are ignored by this handler.
- No branch filter intended to select PRs: Gitea applies branch filters to ref-bearing events, while PR events carry their own identity.

Lifecycle checks the raw body against `X-Gitea-Signature`, uses `X-Gitea-Delivery` for deduplication, and reads `X-Gitea-Event-Type` (or `X-Gitea-Event`) for the event. It does not use Gitea's GitHub-compatibility headers. The relevant actions are `opened`, `reopened`, `closed`, `synchronized`, `label_updated` and `label_cleared`. These headers, payload fields and webhook settings are described in [Gitea's webhook documentation](https://docs.gitea.com/usage/repository/webhooks/).

## Operate and troubleshoot

An accepted webhook returns HTTP `202` when queued; this is not proof of deployment. HTTP `401` means the signature did not match, `400` means malformed headers or payload after signature verification, `413` means the 1 MiB body limit was exceeded, and `503` means the route is not configured, is not running in web/all mode, or could not reach its queue. An unrelated event or repository also returns `202` without work. Check the Gitea delivery record and Lifecycle's **sanitised** worker logs for the delivery ID, then inspect the PR comment and build/deploy state. Do not copy signed payloads, token values or clone Secrets into tickets or logs.

Each accepted delivery re-reads the current PR. Completed delivery IDs remain deduplicated for up to seven days or 100,000 queue jobs; processing retries up to five times with exponential backoff. A failed job is removed so a Gitea redelivery can requeue it. If Gitea is temporarily unavailable, allow the worker to retry or redeliver the same event after the failure is visible. If the PR was force-pushed or closed while a build was queued, the source guard checks the live state before cloning. Inspect the latest PR commit, its `lifecycle.yaml`, build state and deletion queue before manually redelivering.

The status is a marked PR **comment** with service URLs, updated when the deployment status changes. It is not a Gitea commit status. If the comment is missing, check the bot's `write:issue` scope and repository access, then the worker's sanitised API error status. HTTP `404` during PR lookup closes an existing stored PR; other API failures retry. If a private fork cannot be cloned, check the bot's access to that fork and the CA mount. If the environment outlives a closed PR, check the deletion queue, worker health and whether its namespace still contains a temporary clone Secret.

To rotate the webhook secret, configure the new value as `GITEA_WEBHOOK_SECRET` and the old value as `GITEA_WEBHOOK_SECRET_PREVIOUS` on both processes, restart them, then change the Gitea webhook to the new value. After old deliveries have drained, remove the previous value and restart again. Rotate a bot token separately: create the replacement with the same limited access, update the runtime Secret and restart both processes, then revoke the old token after in-flight clones finish. For a CA rollover, trust both old and new CA certificates during the transition and remove the old certificate afterwards.

## Offline verification already performed

On the merged code at `182e4c6`, with `NODE_ENV=test`, a test `DATABASE_URL` and `LIFECYCLE_MODE=worker`, Jest passed 11 focused forge, Gitea, TTL, comment, build and deploy suites (514 tests). The GitHub webhook behaviour suite separately passed 48 tests. These tests use mocks and do not demonstrate Kubernetes deployment, network reachability, migration success or PR URL availability.

## Isolated demonstration record

Do not run this sequence against the active lab. When a disposable installation is available, record its cluster context, Lifecycle commit, Gitea version, repository, environment ID, image tags, migration result and redacted configuration. Record the exact commands and observations for each step:

| Step | Action | Evidence to capture |
| --- | --- | --- |
| Open | Push a PR with the deploy label and native-source `lifecycle.yaml`. | Delivery ID, PR head SHA, queued build, eventual PR comment and reachable URL. |
| Update | Push a second commit, then force-push a third. | Each accepted head SHA, build source SHA, replaced deployment and unchanged comment marker. |
| Close while queued | Queue a build, then close the PR before cloning. | No new deployment for the closed head; deletion job and final namespace state. |
| Retry | Temporarily make the isolated Gitea API unavailable, then restore it. | Job retry or redelivery, without duplicate environment or comment. |
| Lease | Let a short **isolated** lease expire, with and without the keep label. | Live-label decision, deletion job and PR comment. |
| GitHub regression | Run the existing GitHub-focused tests without changing a GitHub installation. | Test command, count and result. |

The observation column is a **template**, not a claim that the demonstration has run. Keep a timestamped record of failures and limitations. Do not delete a test cluster until its Gitea delivery, build, deployment and teardown evidence has been collected.
