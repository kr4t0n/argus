# Argus Helm chart

Deploy the Argus control plane (`argus-server` + `argus-web`) onto
Kubernetes. PostgreSQL, Redis, and the per-host `argus-sidecar` binary
are intentionally **out of scope** — see the trade-offs section below.


| Field         | Value                 |
| ------------- | --------------------- |
| Chart version | `0.2.2`               |
| App version   | `0.2.2`               |
| Server image  | `kr4t0n/argus-server` |
| Web image     | `kr4t0n/argus-web`    |


---

## What this chart deploys

- `Deployment` + `Service` for `argus-server`
- `Deployment` + `Service` for `argus-web`
- `Secret` containing the server's sensitive env vars (JWT secret, admin
password, sidecar-link token, optionally the database/Redis URLs)
- Optional `Ingress` exposing the web (and, separately, the API)

## What this chart does NOT deploy

- **PostgreSQL** — Argus needs a Postgres 14+ instance. Use a managed
service (RDS / Cloud SQL / Aiven / Supabase / Neon …) or run the
bitnami `postgresql` subchart in the same namespace.
- **Redis** — same story; managed (Upstash / ElastiCache / MemoryStore)
or the bitnami `redis` subchart.
- `**argus-sidecar`** — the sidecar runs on the *agent host machines*
(a developer laptop, a build box, a Mac mini farm), **not** in
Kubernetes. Cluster pods can't usefully spawn `claude` / `codex` /
`cursor-agent` against the operator's local repos. Install the binary
on each host and run `argus-sidecar init`.

## Quick install

The chart is published to a Helm repo at
**https://kr4t0n.github.io/argus/helm**, refreshed by the
[`helm-publish`](../../.github/workflows/helm-publish.yml) workflow on
every change to `helm/**` on `main`. Pull-and-install:

```bash
helm repo add argus https://kr4t0n.github.io/argus/helm
helm repo update

helm install argus argus/argus \
  --namespace argus --create-namespace \
  --set externalDatabase.url='postgresql://argus:argus@my-pg:5432/argus?schema=public' \
  --set externalRedis.url='redis://my-redis:6379' \
  --set auth.jwtSecret="$(openssl rand -hex 32)" \
  --set auth.adminPassword='change-me-now' \
  --set auth.sidecarLinkToken="$(openssl rand -hex 32)"
```

If you've cloned the repo and want to test local changes, swap the
chart reference for the path:

```bash
helm install argus ./helm/argus --namespace argus --create-namespace \
  ...
```

The chart will refuse to install if the required secrets are missing —
the `argus.validate` helper trips a `helm install` failure with a
helpful message rather than rendering a half-broken Deployment.

For a real deployment, write a `values.yaml`:

```yaml
externalDatabase:
  url: "postgresql://user:pw@pg.example.com:5432/argus?schema=public&sslmode=require"

externalRedis:
  url: "rediss://default:pw@redis.example.com:6379"

auth:
  jwtSecret: "..."          # 32+ random bytes
  jwtExpiresIn: "30d"       # or "never" for non-expiring tokens
  adminEmail: "ops@example.com"
  adminPassword: "..."
  sidecarLinkToken: "..."   # required for the interactive terminal feature

server:
  replicaCount: 2
  resources:
    requests: { cpu: 200m, memory: 512Mi }
    limits:   { cpu: 2,    memory: 2Gi  }

web:
  replicaCount: 2

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
    # WebSocket needs a long read timeout — Argus uses Socket.IO.
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
  web:
    host: argus.example.com
    tls: { enabled: true, secretName: argus-web-tls }
  server:
    host: argus-api.example.com
    tls: { enabled: true, secretName: argus-api-tls }
```

```bash
helm upgrade --install argus ./helm/argus \
  --namespace argus --create-namespace \
  -f my-values.yaml
```

## Externally managed Secrets

If you use sealed-secrets / external-secrets / vault-injector, set
`auth.existingSecret` to the name of a Secret you've pre-created with
these keys:


| Key                  | Required | Notes                     |
| -------------------- | -------- | ------------------------- |
| `JWT_SECRET`         | yes      | 32+ random bytes          |
| `ADMIN_PASSWORD`     | yes      | initial admin password    |
| `SIDECAR_LINK_TOKEN` | optional | enables sidecar-link auth |


For database/Redis, point `externalDatabase.existingSecret` /
`externalRedis.existingSecret` at separate Secrets (the convention is
to keep the connection strings out of the same Secret as the auth
material). Override `existingSecretKey` if your Secret uses a different
key name.

## Attachments (object store)

File/image attachments are stored in an **S3-compatible bucket**. As with
Postgres/Redis, the chart does **not** run one — point at managed S3,
Cloudflare R2, or an in-cluster MinIO you deploy separately. Only the
**server** needs to reach the bucket: the browser and the sidecars fetch
attachments *through* the server, never from S3 directly, so the bucket
can stay private to the cluster.

Attachments are **off by default** — leave `objectStore.endpoint` empty
and the rest of Argus runs normally. To enable, set the endpoint + a
bucket that already exists (the chart does not create it) + credentials:

```yaml
objectStore:
  endpoint: http://minio.minio.svc:9000   # or https://<acct>.r2.cloudflarestorage.com
  bucket: argus-attachments
  region: us-east-1
  accessKey: "<key>"     # inline → generated Secret
  secretKey: "<secret>"
```

Or keep the credentials in a Secret you manage:

```yaml
objectStore:
  endpoint: https://s3.us-east-1.amazonaws.com
  existingSecret: my-s3-creds            # keys: S3_ACCESS_KEY, S3_SECRET_KEY
  # existingSecretAccessKeyKey / existingSecretSecretKeyKey to rename them
```

Notes:
- The server uses path-style addressing (`forcePathStyle`), which suits
  MinIO/R2 and AWS regional endpoints; use a bucket name without dots.
- Attachments require a **server image that includes the attachment
  module**. Until a release ships it, set `server.image.tag` (or
  `image.tag`) to such a build; older images ignore the `S3_*` env.
- Upload caps: `objectStore.maxFileBytes` (default 25 MiB) and
  `objectStore.maxFiles` per turn (default 10).

## Push notifications — APNs (native iOS client)

The native iOS/iPadOS client registers its device with the server, and
the server pushes turn-finished alerts plus Live Activity updates
through Apple's APNs. Like attachments, this is **off by default** —
leave the `apns` block empty and web-only deployments are unaffected
(the server logs push as disabled and skips it).

You need an Apple Developer **token-auth key** (a `.p8` file, created
under Certificates → Keys with the APNs capability; pick environment
*Sandbox & Production* and scope *Team* so one key covers both the
alert and Live Activity topics). Then:

```yaml
apns:
  teamId: "AB12CD34EF"                   # Membership → Team ID
  keyId: "XY98ZW76VU"                    # the .p8 key id
  keyBase64: "<base64 of the .p8 file>"  # base64 -i AuthKey_XXXX.p8 | tr -d '\n'
  # topic: app.argus.ios                 # only if you rebuilt the app with another bundle id
  # environment: production              # sandbox (default) = Xcode installs; production = TestFlight/App Store
```

Or keep the key material in a Secret you manage:

```yaml
apns:
  teamId: "AB12CD34EF"
  keyId: "XY98ZW76VU"
  existingSecret: my-apns-key            # key: APNS_KEY_BASE64
  # existingSecretKey to rename it
```

Enablement is all-or-nothing: the server activates push only when team
id, key id, and key are all present (the chart mirrors this — the env
block renders only when `teamId` and `keyId` are both set). Check the
server boot log for `APNs enabled`. Requires a server image with the
push module (`sha-6cb9f9f` / ≥ 0.2.7).

## Wiring the SPA to the API

The web image renders runtime configuration into `/config.js` at
container start, so the same image works for any deployment shape
without a rebuild. Resolution order in `apps/web/src/lib/host.ts`:

1. `window.__ARGUS_CONFIG__.apiUrl` — populated from the container's
  `ARGUS_API_URL` env var (the chart wires this from
   `web.config.apiUrl`).
2. `import.meta.env.VITE_API_URL` — only set if you built the image
  yourself with `--build-arg VITE_API_URL=…`. Default is empty.
3. `<window.location.protocol>//<window.location.hostname>:4000` —
  browser-side fallback. Useful for `localhost` and LAN dev.

Three clean deployment shapes:

1. **Two hostnames (recommended for prod).** Web on `argus.example.com`,
  API on `argus-api.example.com`. Set:
   No custom image rebuild needed.
2. **Same hostname, port 4000 exposed.** Web on `argus.example.com:443`,
  API on `argus.example.com:4000` via a TCP listener on the ingress
   controller (or a separate `LoadBalancer` Service). Leave
   `web.config.apiUrl` empty — the SPA's hostname-derivation fallback
   handles it.
3. **Path-routed (`/api` → server, `/` → web).** Set
  `web.config.apiUrl: https://argus.example.com/api` and ship a custom
   Ingress that rewrites the prefix off before forwarding to the
   server. Disable the chart's Ingress (`ingress.enabled: false`) and
   apply your own.

## Swapping the web image

The default `web.image.repository` is `kr4t0n/argus-web`, our own
multi-stage build FROM `nginx:alpine` that bundles the React SPA and a
`/docker-entrypoint.d/` hook to render `ARGUS_API_URL` →
`/config.js` at container start. That image needs `runAsUser: 0` (its
nginx master chowns cache dirs and binds :80 before dropping to UID
101 for workers) — fine on default-PSA clusters, blocked on
`restricted` ones.

To run the chart on a `restricted` Pod Security Admission cluster
without `runAsUser: 0`, build a fork of [`deploy/web.Dockerfile`](https://github.com/kr4t0n/argus/blob/main/deploy/web.Dockerfile)
that swaps `FROM nginx:alpine` for `FROM nginxinc/nginx-unprivileged:alpine`
(everything else — the SPA copy and the entrypoint hook — keeps
working unchanged). Push it somewhere your cluster can pull, then:

```yaml
web:
  image:
    repository: my-org/argus-web-unprivileged
    tag: "0.1.2"
  containerPort: 8080            # nginx-unprivileged binds :8080
  service:
    port: 80                     # external still 80, targetPort follows containerPort
  securityContext:
    allowPrivilegeEscalation: false
    capabilities:
      drop: ["ALL"]
    runAsNonRoot: true
    runAsUser: 101
```

Pointing `web.image.repository` at a stock `nginx` / `nginx-unprivileged`
image without baking in the SPA + entrypoint hook will leave you with
a generic nginx serving "Welcome to nginx!" — the runtime-config
injection lives in the image, not the chart. (We may ship a
chart-managed ConfigMap variant in a future release; track that
separately.)

## Ingress shape

The chart renders **one Ingress object per service** when both
`ingress.web.host` and `ingress.server.host` are set — `<release>-web`
and `<release>-server`. This split exists primarily because the
[Tailscale Kubernetes operator](https://tailscale.com/kb/1236/kubernetes-operator)
maps one Ingress to one tailnet device (named from `tls.hosts[0]`); a
single two-rule Ingress would collapse both endpoints onto one
device. nginx-ingress / traefik / haproxy users get the same effective
behaviour as a two-rule Ingress, just spread across two manifests, so
per-service annotations and TLS Secrets stay independent.

### Example: Tailscale

A ready-to-`-f` example that serves web at `argus` and API at
`argus-api`, both auto-HTTPS via Tailscale, and reuses one external
Secret for all credentials lives in
[`examples/values.tailscale.yaml`](./examples/values.tailscale.yaml).
Create the Secret first, then:

```bash
kubectl -n argus create secret generic argus-secret \
  --from-literal=DATABASE_URL='postgresql://...' \
  --from-literal=REDIS_URL='rediss://...' \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=ADMIN_PASSWORD='change-me-now' \
  --from-literal=SIDECAR_LINK_TOKEN="$(openssl rand -hex 32)"

helm install argus argus/argus \
  --namespace argus --create-namespace \
  -f helm/argus/examples/values.tailscale.yaml
```

Edit the `your-tailnet` placeholder in `web.config.apiUrl` first — find
it with `tailscale status --json | jq -r .MagicDNSSuffix`.

## Sidecars

Sidecars are not a Kubernetes workload; they live on the operator's
host machines. After installing the chart, on each host:

```bash
# install the binary (see the project's INSTALLATION.md for the full
# matrix of platforms / install methods)
argus-sidecar init \
  --bus    "<the same REDIS_URL the server uses, reachable from the host>" \
  --server "https://argus-api.example.com" \
  --token  "<value of auth.sidecarLinkToken>"

argus-sidecar &      # or systemd / launchd (see INSTALLATION.md)
```

The host registers as a Machine and shows up in the dashboard sidebar
within ~1 second.

> ⚠️ The Redis URL has to be reachable **from the agent hosts**, not
> just from inside the cluster. If you ran the bitnami `redis`
> subchart, expose it via a LoadBalancer Service or a dedicated
> Ingress (TCP), or front it with stunnel / a managed redis with TLS.

## Values reference

See `[values.yaml](./values.yaml)` for the full annotated default set.
The most important knobs:


| Key                       | Default                     | Purpose                                         |
| ------------------------- | --------------------------- | ----------------------------------------------- |
| `externalDatabase.url`    | `""` (required)             | Postgres connection string                      |
| `externalRedis.url`       | `""` (required)             | Redis connection string                         |
| `auth.jwtSecret`          | `""` (required)             | NestJS JWT signing key                          |
| `auth.jwtExpiresIn`       | `"7d"`                      | `never` for non-expiring tokens                 |
| `auth.adminEmail`         | `admin@argus.local`         | bootstrap admin user email                      |
| `auth.adminPassword`      | `""` (required)             | bootstrap admin password                        |
| `auth.sidecarLinkToken`   | `""`                        | shared secret for sidecar terminal link         |
| `objectStore.endpoint`    | `""` (off)                  | S3-compatible endpoint; set to enable attachments |
| `objectStore.bucket`      | `argus-attachments`         | bucket attachments are stored in (must exist)   |
| `objectStore.accessKey`   | `""`                        | S3 access key (or use `objectStore.existingSecret`) |
| `objectStore.secretKey`   | `""`                        | S3 secret key                                   |
| `apns.teamId`             | `""` (off)                  | Apple team id; with `keyId` + key enables iOS push |
| `apns.keyId`              | `""`                        | APNs token-auth `.p8` key id                    |
| `apns.keyBase64`          | `""`                        | base64 `.p8` content (or use `apns.existingSecret`) |
| `apns.environment`        | `""` (→ `sandbox`)          | `production` for TestFlight/App Store builds    |
| `server.replicaCount`     | `1`                         | NestJS replicas (Socket.IO is sticky-friendly)  |
| `server.image.repository` | `kr4t0n/argus-server`       |                                                 |
| `web.replicaCount`        | `1`                         | nginx replicas serving the SPA bundle           |
| `web.image.repository`    | `kr4t0n/argus-web`          |                                                 |
| `web.config.apiUrl`       | `""`                        | runtime API URL (no rebuild needed)             |
| `web.config.wsUrl`        | `""`                        | runtime WebSocket URL; defaults to `apiUrl`     |
| `image.tag`               | `""` (→ `Chart.AppVersion`) | shared override; per-component tag wins         |
| `ingress.enabled`         | `false`                     | render the Ingress object                       |
| `ingress.web.host`        | `argus.example.com`         | web hostname                                    |
| `ingress.server.host`     | `""`                        | API hostname (empty skips the API ingress rule) |


## Upgrades

The Deployment template's `checksum/secret` annotation rolls the server
pods on Secret changes (so a `helm upgrade` that only flips a JWT key
restarts the pods rather than silently leaving the old value in
memory). The strategy is `RollingUpdate` with `maxUnavailable: 0` /
`maxSurge: 1` because the server runs `prisma migrate deploy` at boot
and we don't want two boots racing the schema lock.

## Releasing a new chart version

The published Helm repo lives on the `gh-pages` branch under `helm/`.
The `helm-publish` workflow runs on every push to `main` that touches
`helm/**`, packages the chart, and merges the new tarball into
`index.yaml`.

Two important contracts:

1. **`helm package` refuses to overwrite an existing `name-version`
   tarball.** That's the safety net — the only way to actually publish
   a new release is to bump `helm/argus/Chart.yaml`'s `version:`. A
   merge to main that edits a template but forgets to bump the version
   is a no-op for end users.
2. **Old versions are preserved.** `helm repo index --merge` carries
   forward every previously-published version, so a user pinned to
   `0.1.1` keeps working after we ship `0.2.0`.

The convention is to bump `version` and `appVersion` together when the
images change, and to bump only `version` for chart-only fixes (a
template edit that doesn't change the deployed app).

## Uninstall

```bash
helm uninstall argus --namespace argus
```

This removes the Deployments, Services, Ingress, and the chart-managed
Secret. **It does not touch your external Postgres / Redis** — drop
those manually if you want a clean slate.