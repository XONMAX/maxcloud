// MaxCloud API client for mobile (native mode: X-Client: mobile -> tokens in body, stored in the keychain).
import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

class ApiException implements Exception {
  ApiException(this.status, this.code, this.message);
  final int status;
  final String code;
  final String message;
  @override
  String toString() => message;
}

class RemoteNode {
  RemoteNode.fromJson(Map<String, dynamic> j)
      : id = j['id'] as String,
        name = j['name'] as String,
        isFolder = j['type'] == 'FOLDER',
        size = (j['size'] as num).toInt(),
        hasThumbnail = j['hasThumbnail'] as bool? ?? false;
  final String id;
  final String name;
  final bool isFolder;
  final int size;
  final bool hasThumbnail;
}

class Api {
  Api({this.baseUrl = const String.fromEnvironment('API_URL', defaultValue: 'https://api.maxcloud.uz')});
  final String baseUrl;
  final _store = const FlutterSecureStorage();
  final _http = http.Client();
  String? _access;
  String? _refresh;

  Future<bool> restore() async {
    _access = await _store.read(key: 'access');
    _refresh = await _store.read(key: 'refresh');
    return _refresh != null;
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'X-Client': 'mobile',
        'X-Device-Name': '${Platform.operatingSystem} phone',
        if (_access != null) 'Authorization': 'Bearer $_access',
      };

  Future<void> _saveTokens(Map<String, dynamic> j) async {
    _access = j['accessToken'] as String?;
    _refresh = j['refreshToken'] as String?;
    await _store.write(key: 'access', value: _access);
    await _store.write(key: 'refresh', value: _refresh);
  }

  Future<Map<String, dynamic>> _send(String method, String path, [Object? body, bool retry = true]) async {
    final req = http.Request(method, Uri.parse('$baseUrl$path'))..headers.addAll(_headers);
    if (body != null) req.body = jsonEncode(body);
    final res = await http.Response.fromStream(await _http.send(req));
    if (res.statusCode == 401 && retry && _refresh != null && !path.startsWith('/auth/')) {
      await refresh();
      return _send(method, path, body, false);
    }
    final j = res.body.isEmpty ? <String, dynamic>{} : jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode >= 400) throw ApiException(res.statusCode, j['code'] as String? ?? 'HTTP', j['message'] as String? ?? 'Error');
    return j;
  }

  Future<void> login(String email, String password, {String? totp}) async {
    await _saveTokens(await _send('POST', '/auth/login', {'email': email, 'password': password, if (totp != null) 'totp': totp}));
  }

  Future<void> refresh() async {
    await _saveTokens(await _send('POST', '/auth/refresh', {'refreshToken': _refresh}, false));
  }

  Future<void> logout() async {
    try {
      await _send('POST', '/auth/logout');
    } finally {
      await _store.deleteAll();
      _access = _refresh = null;
    }
  }

  Future<Map<String, dynamic>> me() async => (await _send('GET', '/auth/me'))['user'] as Map<String, dynamic>;

  Future<List<RemoteNode>> list({String? parentId}) async {
    final j = await _send('GET', '/files?limit=500${parentId != null ? '&parentId=$parentId' : ''}');
    return (j['items'] as List).map((e) => RemoteNode.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<String> ensureFolder(String name, {String? parentId}) async {
    final items = await list(parentId: parentId);
    for (final n in items) {
      if (n.isFolder && n.name.toLowerCase() == name.toLowerCase()) return n.id;
    }
    return (await _send('POST', '/folders', {'name': name, 'parentId': parentId}))['id'] as String;
  }

  Future<String> downloadUrl(String id) async => (await _send('GET', '/files/$id/download'))['url'] as String;

  /// Resumable multipart upload straight to storage. With [dedupe] the server skips files it already has.
  /// Returns the node id (existing node when deduplicated).
  Future<String> upload(File file, String name, {String? parentId, required String sha256, bool dedupe = true, String mime = 'application/octet-stream'}) async {
    final size = await file.length();
    final init = await _send('POST', '/uploads', {'name': name, 'parentId': parentId, 'size': size, 'mimeType': mime, 'sha256': sha256, 'dedupe': dedupe});
    final dup = init['deduplicatedNode'];
    if (dup != null) return (dup as Map<String, dynamic>)['id'] as String;
    final uploadId = init['uploadId'] as String;
    final partSize = (init['partSize'] as num).toInt();
    final partCount = (init['partCount'] as num).toInt();
    final done = {for (final p in init['completedParts'] as List) (p as Map)['partNumber'] as int};
    final raf = await file.open();
    try {
      for (var n = 1; n <= partCount && size > 0; n++) {
        if (done.contains(n)) continue;
        final signed = await _send('POST', '/uploads/$uploadId/parts', {'partNumbers': [n]});
        final url = ((signed['parts'] as List).first as Map)['url'] as String;
        await raf.setPosition((n - 1) * partSize);
        final bytes = await raf.read(partSize);
        for (var attempt = 0;; attempt++) {
          try {
            final r = await _http.put(Uri.parse(url), body: bytes);
            if (r.statusCode >= 200 && r.statusCode < 300) break;
            throw HttpException('storage ${r.statusCode}');
          } on IOException {
            if (attempt >= 6) rethrow;
            await Future<void>.delayed(Duration(seconds: 1 << attempt));
          }
        }
      }
    } finally {
      await raf.close();
    }
    return (await _send('POST', '/uploads/$uploadId/complete', {'parts': <Object>[]}))['id'] as String;
  }
}
