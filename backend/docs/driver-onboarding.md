# Registering and managing drivers (Work 156)

Before Work 156 there was no way to become a driver: the staging seed wrote driver accounts straight into the database. Now a platform administrator registers drivers.

## Registering

The person first signs up in the PharmaLink app as an ordinary customer (an active account with a verified contact). There is no invitation e-mail yet, as for pharmacy staff and owners. An administrator with `provider:verify:any` then registers them:

1. **Documents.** `POST /admin/drivers/uploads` with `{ userId, contentType, bytes }` issues a signed upload for one PDF, JPEG or PNG: driving licence, vehicle registration, national ID, insurance or other. It is stored under the person, so it can only be used for them.
2. **Registration.** `POST /admin/drivers` takes `{ userId, vehicleType, plateNumber?, documentsExpireOn: 'YYYY-MM-DD', documents: [{ kind, storageRef }], serviceArea?: { lat, lng, radiusMeters } }` and runs, in order:
   - `MakeDriverCommand` (Module 01). Only an active customer can become a driver; never an administrator, a pharmacy owner or pharmacy staff (anyone holding an organisation role). Their primary role becomes DRIVER, they gain the DRIVER role, and the change takes effect on their next request. Audited `identity.user.made_driver`.
   - `SubmitVerificationDocumentsCommand` (DRIVER_DOCS), then `ApproveVerificationCommand`, with the administrator as reviewer. The approval expires at the end of `documentsExpireOn` (UTC); after that the driver cannot go online until new documents are approved.
   - `CreateDriverProfileCommand` (Module 08): vehicle, plate, working area.
   - Audit `DRIVER_REGISTERED_BY_ADMIN`.

Each step's own rules and audit apply. The admin module reaches them through `IDENTITY_DRIVER_ONBOARDING_PORT` and `DRIVER_ONBOARDING_PORT`.

## The record

- **Drivers** are `GET /admin/accounts?primaryRole=DRIVER` (exact e-mail or phone, account status).
- **Profile.** `GET /admin/drivers/:userId/profile` (`driver:read:any`) returns the vehicle, plate, working area, availability, shift and last time online. It never includes the driver's location.
- **Documents.** `GET /admin/verifications?userId=…&type=DRIVER_DOCS`, each one previewable.

## Disabling

Disabling a driver is suspending their account (`POST /admin/accounts/:id/suspend`, a reason required). They are signed out, and delivery re-checks the account before every offer, acceptance and going online. `POST /admin/accounts/:id/reinstate` enables them again.

## Portal

Admin and Super Admin → **Drivers**:

- the list;
- **Register driver**:
  1. Find the person.
  2. Enter the vehicle, plate and working area (km around central Addis Ababa).
  3. Upload the documents.
  4. Enter their expiry.
- a driver's record: account, vehicle and work, documents, with **Disable** / **Enable**.
