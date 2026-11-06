# Document storage and preview: Work 89

This work covers module-16 §9.1 (document preview in the verification review) and §13
("purpose-bound and logged" access to sensitive documents). It also covers the long-standing gap
module-01 left: `VerificationRequest.documents[].storageRef` was described as a reference into
encrypted object storage, but no storage existed.

## Shape

**Bytes never pass through the API.**
- **Upload.** An applicant asks for a signed upload link, PUTs the file straight to storage, then
  submits the returned reference.
- **Preview.** A reviewer asks for a signed read link and opens it in the browser.

The API's role is narrow:
- issue links;
- check what landed;
- record who received a link.

```
applicant ── POST /verification/documents/uploads {contentType, bytes} ──▶ API
          ◀── {storageRef: doc:verification/<userId>/<uuid>, upload: {url, method: PUT, headers}} ──
          ── PUT <url> (the file) ─────────────────────────────────────────▶ storage
          ── POST /verification/documents {documents: [{kind, storageRef}]} ▶ API  (checks it landed)
reviewer  ── POST /admin/verifications/{id}/documents/{i}/preview ─────────▶ API  (audited)
          ◀── {url, contentType, expiresAt} ── open <url> ─────────────────▶ storage
```

## Rules

- **Accepted files.** Only PDF, JPEG or PNG, from 1 byte to 10 MiB.
  - **Upload link.** It is bound to the content type and exact length (both signed), and is
    valid for 10 minutes.
  - **Submission check.** A `doc:` reference must name the caller's own upload, under namespace
    `verification` and the caller's user id. The file must exist and its stored type and size
    must be acceptable. Anything else is `VALIDATION_ERROR`.
- **References** have the form `doc:<namespace>/<ownerId>/<uuid>`. They are opaque and are not
  URLs.
- **Older, text-only references.** Any other reference, such as the `enc://…` and `staging-seed/…`
  forms used before uploads existed:
  - is still accepted;
  - shows as `previewable: false`;
  - answers a preview with `DOCUMENT_NOT_STORED` (409).
- **Preview link.** It is valid for **5 minutes**, served `inline` and never cached.
  - **Permission.** It needs `verification:queue:read`, the same as reading the review.
  - **Audit.** Every link issued is recorded as `VERIFICATION_DOCUMENT_PREVIEWED`, with the
    reviewer, the request, the document index, its kind and its type. The link itself is never
    recorded.
- **Audit of uploads.** Every upload link is recorded as
  `identity.verification.document_upload_issued`.

## Storage

`DOCUMENT_STORAGE_PORT` lives in `backend/src/shared/storage` and is chosen by
`DOCUMENT_STORAGE`:

| Value | Used by | Notes |
|---|---|---|
| `memory` (default outside production) | Tests, local development | Lives in the process; signed links point at this API's `/storage/local/{token}`, HMAC-signed with a key that also lives only in the process |
| `s3` | The staging stack (MinIO) | Any S3-compatible store: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` (what the browser can reach), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_FORCE_PATH_STYLE`, `S3_CREATE_BUCKET` |
| unset in production | Production | **Unavailable**: uploads and previews fail with `DEPENDENCY_UNAVAILABLE` (503). `memory` is refused in production at boot |

Production stays fail-closed until an object-storage provider is approved. That approval is a
decision about credentials, encryption at rest, retention and data residency, the same position
payouts are in (Work 83). The S3 adapter is ready for it.

### Staging (MinIO)

`compose.staging.yml` runs MinIO **inside the `pharmalink-staging` project only**. It never
touches a MinIO running elsewhere on the machine.
- **Host port.** It is published on `127.0.0.1:9100`, not 9000; `MINIO_HOST_PORT` overrides it.
- **Password.** The root password is `S3_SECRET_ACCESS_KEY` in `backend/.env.staging`. Add it with
  `node ops/staging/ensure-env-secrets.mjs`, which generates it and never prints it.
- **Bucket.** The backend creates `pharmalink-documents` at start-up (`S3_CREATE_BUCKET=true`).
- **Seed.** The seed stores a one-page sample PDF for each seeded verification document. Each PDF
  is labelled "staging sample — not a real document", so the review has something to preview.

## Not built

- **Content sniffing.** Uploads are checked by declared and stored type and size, not by sniffing
  the bytes. The store serves them with the stored type, and the local adapter adds `nosniff`.
- **Malware scanning, encryption with our own keys, retention and deletion of orphaned uploads.**
  These belong with the production provider decision.
- **Other document owners.** Proof-of-delivery photos keep their own port (Module 08). Prescriptions
  are outside this work.
