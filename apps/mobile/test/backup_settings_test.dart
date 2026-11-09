import 'package:flutter_test/flutter_test.dart';
import 'package:maxcloud/backup.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('backup is opt-in and Wi-Fi only by default', () async {
    SharedPreferences.setMockInitialValues({});
    final s = await BackupSettings.load();
    expect(s.enabled, isFalse);
    expect(s.wifiOnly, isTrue);
    await BackupSettings.save(enabled: true, wifiOnly: false);
    final s2 = await BackupSettings.load();
    expect(s2.enabled, isTrue);
    expect(s2.wifiOnly, isFalse);
  });
}
