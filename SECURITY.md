# Security: API Keys & Secret Scanning

## Worker-side YouTube/InnerTube API key

The old `tubepulse-cron/index.js` (pre-shard, commit `34cd060`) contained a
hardcoded `INNERTUBE_KEY` constant. This was the YouTube web client InnerTube
key — a public identifier used by the YouTube web frontend, not a server-side
secret. It was removed from current code when the cron worker was reverted
(commit `fe0e20b`) and subsequently replaced with the no-op stub (commit
`a13efd2`).

**Current state:** No tracked worker source contains any hardcoded Google API
key. All workers read `env.YOUTUBE_API_KEY` from Cloudflare Workers secret
manager (set via `wrangler secret put`). The stub
`worker/tubepulse-cron/index.js` is 14 lines with no key material.

**Git history:** The key remains in git history at commit `34cd060`. GitHub
secret scanning alert #2 references this historical blob. We are not rewriting
history; the alert should be closed as "used in tests" / "false positive" since
the key was a public web client identifier and is no longer in current code.

## Android `google-services.json`

The file `android/app/google-services.json` contains a Firebase Android app
API key (`current_key` field). This is a **Firebase client configuration key**,
not a server-side secret. Google's own documentation explicitly states this
key is safe to include in client-side code:

> "These keys are safe to include in your client code. Google restricts API key
> usage by application package name and SHA-1 certificate fingerprint, so even
> if someone obtains your key, they can't use it from an unauthorized app."

— [Firebase documentation](https://firebase.google.com/docs/projects/api-keys)

**Required for build:** `app.json` references `./google-services.json` in both
`android.googleServicesFile` and the `@react-native-firebase/app` plugin config.
Removing the file would break fresh clones and CI builds.

**GitHub secret scanning alert #1** flags this key. Since it is a Firebase
client config key (by design public, restricted by package name/certificate),
the alert is a false positive for a server-side secret.

## `.gitignore` coverage

The `.gitignore` covers:
- `/secrets/` and `**/secrets/` — all local credential files
- `secrets/*.env`, `secrets/*.json`, `secrets/*.key`, `secrets/*.pem`
- `.dev.vars` and `worker/*/.dev.vars` — wrangler local secrets
- `worker/*/.wrangler/` — local wrangler state
- `google-services.json` / `GoogleService-Info.plist` — listed but the Android
  file is still tracked (committed before the rule was added; kept for build
  compatibility)

## Recommended Google Cloud restrictions (not yet applied)

Since we are not rotating either key:

### Worker YouTube Data API key

- [ ] Restrict to **YouTube Data API v3** only (API restriction)
- [ ] Application restrictions: not practical for Cloudflare Workers (no stable
      IP/referrer). Rely on API restriction + quota/billing alerts instead
- [ ] Set quota/usage alerts in Google Cloud Console

### Firebase Android key

- [ ] Add **Android application restriction**: package name `com.tubepulse.app`
- [ ] Add **SHA-1 certificate fingerprint** for the signing cert(s)
- [ ] Add **SHA-256 certificate fingerprint** if applicable
- [ ] Restrict to **required Firebase APIs only** (API restriction)

> Do not apply console changes that could break production without confirming
> with the project owner first.