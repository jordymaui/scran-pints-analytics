# OAuth publishing and data lifecycle

This is a developer implementation checklist, not a claim that Google has verified the application or that every item below is complete.

## Publishing configuration

Google's external Testing status gives reporting refresh tokens a seven-day lifetime; the exception for basic identity scopes does not cover YouTube reporting. Changing Audience to In production is distinct from brand and scope verification. Obtain and check a new reporting grant after that change; production tokens can still be revoked or expire for other reasons. [Refresh-token guidance](https://developers.google.com/identity/protocols/oauth2/#expiration), [Audience settings](https://support.google.com/cloud/answer/15549945?hl=en).

Complete accurate Branding fields: app name, monitored support address, developer contact address, a public homepage describing the app, linked privacy and usage pages, and the applicable authorized domains. Current Google help includes homepage, privacy and terms links among external-production requirements. A logo is optional; name/logo display and verified branding are separate from publishing status. Verify the relevant domain ownership before claiming that step is complete. [Branding requirements](https://support.google.com/cloud/answer/15549049?hl=en).

Google documents verification exceptions for limited personal use and for an app confined to its own Workspace or Cloud Identity organization. Two stored credentials alone do not establish an exception for a publicly accessible product. Internal audience requires the project and users to belong to the applicable organization. Do not claim an exemption or successful verification from the presence of a publish button. [Verification exceptions](https://support.google.com/cloud/answer/13464323?hl=en), [OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies).

## Data boundaries to preserve

- Collect new public YouTube counters independently through the public Data API path. Keep capture dates and platform definitions; do not substitute authorized Analytics-window values.
- Keep authorized Analytics reports behind team authorization and restrict any additional agent access explicitly. Do not infer that an aggregate metric is unrestricted simply because it identifies no individual viewer.
- Keep the intentionally published, checked-in historical archive distinct from new connected-account collection. A public repository cannot provide retroactive confidentiality or recall others' copies.
- Review the privacy and usage pages against deployed behavior before setting their URLs in Branding. Public pages do not, on their own, implement consent, deletion or verification.

## Revocation and deletion follow-up

The current application retains the last successful report when a refresh fails. It has no automated revocation cleanup or self-service deletion endpoint. A privacy notice must not promise either feature until implemented and tested.

Before completing the data lifecycle:

- Add an authenticated, same-origin disconnect/delete action with a clear description of the affected channel and records. Revoke its reporting grant with the provider and remove the saved credential.
- Delete the related current snapshot and snapshot history. Review run metadata, notebook references and exported/public projections for related data; stop future refreshes from recreating deleted material.
- Ensure deleting a connection cannot cause bundled fallback or cached output to republish the deleted account data. Handle the separately published historical archive explicitly rather than silently treating a cloud deletion as an archive deletion.
- Distinguish temporary network failures from confirmed revoked authorization. Check grants regularly and implement removal of data when authorization is no longer valid, following the provider's applicable deadlines.
- Provide a manual request procedure at `team@scranpints.com`, assign responsibility for handling it, and verify completion. Deleting this application's records must not delete the user's YouTube videos or account.
- Check privacy acknowledgement before connecting and whenever the use of authorized data changes. Any acknowledgement must describe actual behavior.
- Test revocation, storage deletion, repeat requests, failed provider revocation, denied authorization, concurrent refreshes and the public fallback boundary. Inspect provider backup-retention settings before making a deletion promise about backups.

The relevant provider requirements are in YouTube Developer Policies III.A (notices), III.D.2.3 (revocation), III.E.3 (authorized access) and III.E.4 (storage/deletion). Review their current text when implementing this work; they are separate from Google's OAuth verification status. [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies).
