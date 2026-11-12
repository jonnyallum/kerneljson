# Identifier placeholders

This repository is public. Real infrastructure identifiers were removed from the docs, `STATE.yaml` and `.env.example` on 12 Nov 2026 and replaced with the placeholders below. The real values are held by the operator (jVault project `kerneljson` and the operator's own notes), not in this repository. Earlier commits still contain the old values.

| Placeholder | Meaning |
|---|---|
| `<supabase-ref-kernel>` | Supabase project ref of the KernelJSON database |
| `<supabase-ref-brain>` | Supabase project ref of the Shared Brain database (archive) |
| `<kj-host-ip>` | Public IP of the KernelJSON production host (`kerneljson-prod-01`) |
| `<estate-vm-ip>` | Public IP of the estate VM |
| `<old-vm-ip>` | Public IP of the retired estate VM |
| `<n8n-vm-ip>` | Public IP of the retired n8n VM |
| `<vercel-ip>` | Vercel edge addresses a wildcard DNS name resolves to |
| `<gcp-project-kj>` | GCP project ID that holds `kerneljson-prod-01` |
| `<gcp-project-estate>` | GCP project ID that holds the estate VM |
| `<gcp-project-old>` | GCP project ID of the retired, billing-suspended project |
| `<kj-operator-email>` | Google account that operates the KernelJSON GCP project |
| `<estate-gcloud-account>` | gcloud account used for the estate project |
| `<owner-email>` | Owner contact email addresses |
| `<estate-vm-name>` | Instance name of the estate VM |

Not changed on purpose: the integration tests keep literal production refs and IPs in their guard lists, because those lists make the tests refuse to run against production. `kerneljson.config.json` keeps its `supabase.project_ref`, because external tooling may read it.
