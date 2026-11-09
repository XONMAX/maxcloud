# MaxCloud mobile (Flutter, iOS + Android)

Status: **not compiled in this environment** (no Flutter SDK in the build container). Code targets
Flutter 3.24+/Dart 3.5 and the package APIs in `pubspec.yaml`. First step on a dev machine:

```bash
cd apps/mobile
flutter create --org uz.maxcloud --project-name maxcloud --platforms ios,android .   # generates android/ and ios/ shells, keeps lib/
flutter pub get && flutter analyze && flutter run --dart-define=API_URL=http://10.0.2.2:4000
```

What's here
- `lib/api.dart` — API client (keychain-stored rotating tokens, resumable multipart upload straight to storage).
- `lib/backup.dart` — camera-roll auto-backup: Wi-Fi-only toggle, SHA-256 dedupe (`dedupe: true` → the server
  skips content it already has), stops cleanly on quota/read-only, "free up space" deletes only assets the
  server confirmed (OS shows its own confirmation).
- `lib/main.dart` — sign-in (incl. 2FA), file browser, backup settings; hourly background runs via `workmanager`
  (Android WorkManager with unmetered-network constraint; iOS BGTaskScheduler).

Platform setup after `flutter create`
- Android `AndroidManifest.xml`: `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `ACCESS_MEDIA_LOCATION`, `INTERNET`;
  for Android 14+ consider partial photo access (`READ_MEDIA_VISUAL_USER_SELECTED`).
- iOS `Info.plist`: `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription`,
  `BGTaskSchedulerPermittedIdentifiers = [maxcloud.backup]`, `UIBackgroundModes = [fetch, processing]`.
- iOS background time is best-effort (minutes, at the OS's discretion); large videos finish when the app is opened.
  TODO: use a background `URLSession` upload task via a small platform channel for long uploads on iOS.

App Store notes: see docs/LAUNCH_CHECKLIST.md (Sign in with Apple is required because Google sign-in is offered;
in-app purchase rules for selling storage inside iOS apps).
