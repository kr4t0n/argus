{{/*
Expand the name of the chart.
*/}}
{{- define "argus.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
A "fullname" prefix used by every resource. Honors fullnameOverride and
falls back to "<release>-<chart>" so the user can run two releases of
this chart in the same namespace without collisions.
*/}}
{{- define "argus.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "argus.server.fullname" -}}
{{- printf "%s-server" (include "argus.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "argus.web.fullname" -}}
{{- printf "%s-web" (include "argus.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "argus.secret.name" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-server" (include "argus.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
Common labels shared by every object. The `app.kubernetes.io/name` and
`app.kubernetes.io/instance` pair is the canonical k8s recommendation
and is what `kubectl logs -l app.kubernetes.io/instance=<release>` keys
off of.
*/}}
{{- define "argus.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "argus.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Per-component selector labels. We deliberately exclude version /
chart so the selector survives upgrades (k8s rejects mutating a
Deployment selector).
*/}}
{{- define "argus.server.selectorLabels" -}}
app.kubernetes.io/name: {{ include "argus.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: server
{{- end -}}

{{- define "argus.web.selectorLabels" -}}
app.kubernetes.io/name: {{ include "argus.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: web
{{- end -}}

{{/*
Image reference helpers. Per-component tag wins, then top-level
`image.tag`, then Chart.AppVersion as the final fallback so an
unconfigured chart always pulls the matching app release.
*/}}
{{- define "argus.server.image" -}}
{{- $reg := .Values.image.registry | default "docker.io" -}}
{{- $repo := .Values.server.image.repository -}}
{{- $tag := default (default .Chart.AppVersion .Values.image.tag) .Values.server.image.tag -}}
{{- printf "%s/%s:%s" $reg $repo $tag -}}
{{- end -}}

{{- define "argus.web.image" -}}
{{- $reg := .Values.image.registry | default "docker.io" -}}
{{- $repo := .Values.web.image.repository -}}
{{- $tag := default (default .Chart.AppVersion .Values.image.tag) .Values.web.image.tag -}}
{{- printf "%s/%s:%s" $reg $repo $tag -}}
{{- end -}}

{{- define "argus.serviceAccountName" -}}
{{- if .Values.server.serviceAccount.create -}}
{{- default (include "argus.server.fullname" .) .Values.server.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.server.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Validate that the user supplied either inline secrets or an existing
Secret reference. Trips a `helm install` failure with a helpful
message instead of silently rendering a half-broken Deployment.
*/}}
{{- define "argus.validate" -}}
{{- if .Values.server.enabled -}}
{{- if not .Values.auth.existingSecret -}}
{{- if not .Values.auth.jwtSecret -}}
{{- fail "auth.jwtSecret is required (or set auth.existingSecret to a pre-created Secret with key JWT_SECRET)" -}}
{{- end -}}
{{- if not .Values.auth.adminPassword -}}
{{- fail "auth.adminPassword is required (or set auth.existingSecret to a pre-created Secret with key ADMIN_PASSWORD)" -}}
{{- end -}}
{{- end -}}
{{- if not .Values.externalDatabase.existingSecret -}}
{{- if not .Values.externalDatabase.url -}}
{{- fail "externalDatabase.url is required (or set externalDatabase.existingSecret pointing at a Secret with the DATABASE_URL key)" -}}
{{- end -}}
{{- end -}}
{{- if not .Values.externalRedis.existingSecret -}}
{{- if not .Values.externalRedis.url -}}
{{- fail "externalRedis.url is required (or set externalRedis.existingSecret pointing at a Secret with the REDIS_URL key)" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
