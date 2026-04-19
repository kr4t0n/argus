# Argus — GitHub Pages branch

This branch hosts the public artifacts published by the
[`helm-publish`](../tree/main/.github/workflows/helm-publish.yml) workflow.

| Path     | Contents                                                                 |
| -------- | ------------------------------------------------------------------------ |
| `helm/`  | Helm chart repository (`index.yaml` + `argus-*.tgz`).                    |

The chart is browsable as a real Helm repo:

```bash
helm repo add argus https://kr4t0n.github.io/argus/helm
helm repo update
helm install argus argus/argus --namespace argus --create-namespace
```

Don't edit this branch by hand — CI rewrites it on every change to
`helm/**` on `main`.
