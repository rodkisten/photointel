# Media Imagor Terraform rollout (opt-in)

This change introduces an **independent** Cloud Run service `photointel-media-imagor` without changing the existing `photointel-media-image` or `photointel-media-video` Jobs.

## Safe default

`enable_media_imagor=false` creates **no new service**, no new IAM binding and no new baseline Cloud Run cost. The service is private (`INGRESS_TRAFFIC_INTERNAL_ONLY`), scales from 0 to 1 instance, uses 1 vCPU/1Gi memory and two concurrent requests, with a 30-second timeout. Deletion protection is enabled.

## Preconditions before any apply

1. Review a real upstream Imagor release and verify its runtime flags and signing behavior using the manual container smoke workflow.
2. Publish a reviewed, immutable `media-imagor@sha256:<digest>` image to the existing Artifact Registry.
3. Create the Secret Manager secret `photointel-media-imagor-secret` **outside Terraform state**, containing the same Imagor signing secret as the independent Media API. Do not put secret values in Terraform variables or state.
4. Validate that the existing `media` service account is appropriate for the independent application. It currently shares identity with the existing media jobs; separate it before production cutover if strict isolation is required.
5. Verify private invocation works for the Media API; internal-only ingress alone does not grant invoker permission. Configure IAM explicitly after confirming the intended caller identity.
6. Verify Imagor's HTTP loader allows only the trusted media gateway origin and that egress restrictions, limits, signed URL expiry and actual R2 transformations work. These controls are **not** enforced by this Terraform service resource.
7. Run `terraform plan` against production remote state and inspect all changes, especially replacements. Do not apply without explicit approval.

Example opt-in flags for a reviewed plan only:

```sh
terraform plan \
  -var='enable_media_imagor=true' \
  -var='media_imagor_image=us-central1-docker.pkg.dev/photointel/photointel/media-imagor@sha256:<verified-digest>'
```

This is a staged Terraform definition, not a production-ready service or authorization grant. No deployment is performed by adding these files.
