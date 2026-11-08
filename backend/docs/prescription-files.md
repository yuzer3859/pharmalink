# Prescription files in document storage (Work 101)

This Work closes Phase 1 audit gap G7. `POST /prescriptions` took any client string as `fileRef`,
so no file was stored and a pharmacist had nothing to open. Prescription files now use Work 89's
document storage (`backend/docs/document-storage.md`).

| Route | Who | Does |
|---|---|---|
| `POST /prescriptions/uploads` `{contentType, bytes}` | The customer (`prescription:upload:own`) | Issues a signed upload link, valid 10 minutes, for `doc:prescription/<userId>/<uuid>`. Accepts PDF, JPEG or PNG, at most 10 MiB. Audited as `PRESCRIPTION_UPLOAD_ISSUED`. |
| `POST /prescriptions`, `POST /prescriptions/{id}/reupload` | The customer | First checks a `doc:` reference: it must be the caller's own, already stored, and of the declared type and size. Otherwise the request is refused with `VALIDATION_ERROR`, or `DOCUMENT_NOT_STORED` (409) when nothing was uploaded yet. |
| `POST /prescriptions/{id}/file` | The owner | Issues a 5-minute read link. |
| `POST /pharmacy/verification/{id}/file` | The reviewing pharmacist (`prescription:verify`) | Issues a 5-minute read link. |

Both read links go through the prescription's own access policy: the owner, the reviewing
pharmacist, or an admin. Each opening is recorded in `prescription_access_logs` as `DOWNLOAD` and
audited as `PRESCRIPTION_FILE_PREVIEWED`. A pharmacist at another pharmacy is refused.

**Decision (recommended option).** A reference from before Work 101 (not `doc:`) is still accepted,
as Work 89 did for verification documents, so existing data and clients keep working. It simply
cannot be opened (`DOCUMENT_NOT_STORED`). The customer app sends only `doc:` references.

The customer app's **Prescriptions** page uploads the file straight to storage through the signed
link, then records the prescription, and lists each prescription with its status. The home page's
"coming soon" banner and checkout's prescription notice now point there.
