// Camera-roll auto-backup: Wi-Fi only (toggle), dedupe by SHA-256, "free up space" after confirmed upload.
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:crypto/crypto.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';

class BackupSettings {
  BackupSettings(this.enabled, this.wifiOnly);
  final bool enabled;
  final bool wifiOnly;

  static Future<BackupSettings> load() async {
    final p = await SharedPreferences.getInstance();
    return BackupSettings(p.getBool('backup.enabled') ?? false, p.getBool('backup.wifiOnly') ?? true);
  }

  static Future<void> save({bool? enabled, bool? wifiOnly}) async {
    final p = await SharedPreferences.getInstance();
    if (enabled != null) await p.setBool('backup.enabled', enabled);
    if (wifiOnly != null) await p.setBool('backup.wifiOnly', wifiOnly);
  }
}

class BackupResult {
  int uploaded = 0;
  int skipped = 0;
  int failed = 0;
  String? stoppedReason;
}

class BackupService {
  BackupService(this.api);
  final Api api;

  /// asset id -> server node id, for assets confirmed stored on the server.
  static const _doneKey = 'backup.done';

  Future<Map<String, String>> _done() async {
    final p = await SharedPreferences.getInstance();
    final list = p.getStringList(_doneKey) ?? [];
    return {for (final e in list) e.split('|').first: e.split('|').last};
  }

  Future<void> _markDone(String assetId, String nodeId) async {
    final p = await SharedPreferences.getInstance();
    final list = p.getStringList(_doneKey) ?? [];
    list.add('$assetId|$nodeId');
    await p.setStringList(_doneKey, list);
  }

  static Future<bool> _onWifi() async {
    final c = await Connectivity().checkConnectivity();
    return c.contains(ConnectivityResult.wifi) || c.contains(ConnectivityResult.ethernet);
  }

  static Future<String> _sha256(File f) async => (await sha256.bind(f.openRead()).first).toString();

  /// Upload every photo/video not yet backed up. Safe to call repeatedly (foreground or background).
  Future<BackupResult> run({void Function(int done, int total)? onProgress}) async {
    final r = BackupResult();
    final s = await BackupSettings.load();
    if (!s.enabled) return r..stoppedReason = 'Backup is off';
    if (s.wifiOnly && !await _onWifi()) return r..stoppedReason = 'Waiting for Wi-Fi';
    final perm = await PhotoManager.requestPermissionExtend();
    if (!perm.hasAccess) return r..stoppedReason = 'No photo access';

    final done = await _done();
    final paths = await PhotoManager.getAssetPathList(type: RequestType.common, onlyAll: true);
    if (paths.isEmpty) return r;
    final all = paths.first;
    final total = await all.assetCountAsync;
    final folderId = await api.ensureFolder('Camera Roll');
    var processed = 0;
    for (var page = 0; page * 200 < total; page++) {
      for (final asset in await all.getAssetListPaged(page: page, size: 200)) {
        processed++;
        onProgress?.call(processed, total);
        if (done.containsKey(asset.id)) {
          r.skipped++;
          continue;
        }
        if (s.wifiOnly && !await _onWifi()) return r..stoppedReason = 'Wi-Fi lost, will continue later';
        final file = await asset.originFile;
        if (file == null) {
          r.failed++; // iCloud-only asset not downloaded yet
          continue;
        }
        try {
          final hash = await _sha256(file);
          final name = asset.title?.isNotEmpty == true ? asset.title! : '${asset.id}.jpg';
          final mime = asset.mimeType ?? (asset.type == AssetType.video ? 'video/mp4' : 'image/jpeg');
          final nodeId = await api.upload(file, name, parentId: folderId, sha256: hash, mime: mime);
          await _markDone(asset.id, nodeId);
          r.uploaded++;
        } on ApiException catch (e) {
          if (e.code == 'QUOTA_EXCEEDED' || e.code == 'ACCOUNT_READ_ONLY') return r..stoppedReason = e.message;
          r.failed++;
        } catch (_) {
          r.failed++;
        }
      }
    }
    return r;
  }

  /// Delete local copies of assets that are confirmed on the server. The OS shows its own confirmation dialog.
  Future<int> freeUpSpace() async {
    final done = await _done();
    if (done.isEmpty) return 0;
    final deleted = await PhotoManager.editor.deleteWithIds(done.keys.toList());
    final p = await SharedPreferences.getInstance();
    final remaining = done.entries.where((e) => !deleted.contains(e.key)).map((e) => '${e.key}|${e.value}').toList();
    await p.setStringList(_doneKey, remaining);
    return deleted.length;
  }
}
