import 'package:flutter/material.dart';
import 'package:workmanager/workmanager.dart';

import 'api.dart';
import 'backup.dart';

const _bgTask = 'maxcloud.backup';

/// Background entry point (Android WorkManager / iOS BGTaskScheduler via workmanager).
@pragma('vm:entry-point')
void callbackDispatcher() {
  Workmanager().executeTask((task, _) async {
    final api = Api();
    if (!await api.restore()) return true;
    await BackupService(api).run();
    return true;
  });
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Workmanager().initialize(callbackDispatcher);
  final api = Api();
  final signedIn = await api.restore();
  runApp(MaxCloudApp(api: api, signedIn: signedIn));
}

class MaxCloudApp extends StatelessWidget {
  const MaxCloudApp({super.key, required this.api, required this.signedIn});
  final Api api;
  final bool signedIn;

  @override
  Widget build(BuildContext context) {
    final scheme = ColorScheme.fromSeed(seedColor: const Color(0xFF1D6FE0));
    return MaterialApp(
      title: 'MaxCloud',
      theme: ThemeData(colorScheme: scheme, useMaterial3: true),
      darkTheme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1D6FE0), brightness: Brightness.dark), useMaterial3: true),
      home: signedIn ? HomeScreen(api: api) : LoginScreen(api: api),
    );
  }
}

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.api});
  final Api api;
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _totp = TextEditingController();
  bool _needTotp = false;
  String? _error;
  bool _busy = false;

  Future<void> _submit() async {
    setState(() => _busy = true);
    try {
      await widget.api.login(_email.text.trim(), _password.text, totp: _needTotp ? _totp.text.trim() : null);
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => HomeScreen(api: widget.api)));
    } on ApiException catch (e) {
      setState(() {
        _needTotp = e.code == 'TOTP_REQUIRED' || _needTotp;
        _error = e.code == 'TOTP_REQUIRED' ? null : e.message;
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: ListView(padding: const EdgeInsets.all(24), children: [
            const SizedBox(height: 48),
            Text('MaxCloud', style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 24),
            TextField(controller: _email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email')),
            TextField(controller: _password, obscureText: true, decoration: const InputDecoration(labelText: 'Parol / Password')),
            if (_needTotp) TextField(controller: _totp, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: '2FA code')),
            if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
            const SizedBox(height: 24),
            FilledButton(onPressed: _busy ? null : _submit, child: const Text('Kirish / Sign in')),
          ]),
        ),
      );
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.api});
  final Api api;
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _tab = 0;
  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(child: _tab == 0 ? FilesScreen(api: widget.api) : BackupScreen(api: widget.api)),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: (i) => setState(() => _tab = i),
          destinations: const [
            NavigationDestination(icon: Icon(Icons.folder_outlined), label: 'Files'),
            NavigationDestination(icon: Icon(Icons.photo_library_outlined), label: 'Backup'),
          ],
        ),
      );
}

class FilesScreen extends StatefulWidget {
  const FilesScreen({super.key, required this.api, this.parentId, this.title = 'My files'});
  final Api api;
  final String? parentId;
  final String title;
  @override
  State<FilesScreen> createState() => _FilesScreenState();
}

class _FilesScreenState extends State<FilesScreen> {
  late Future<List<RemoteNode>> _items = widget.api.list(parentId: widget.parentId);

  @override
  Widget build(BuildContext context) => Column(children: [
        ListTile(title: Text(widget.title, style: Theme.of(context).textTheme.titleLarge)),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () async => setState(() => _items = widget.api.list(parentId: widget.parentId)),
            child: FutureBuilder<List<RemoteNode>>(
              future: _items,
              builder: (context, snap) {
                if (snap.hasError) return Center(child: Text('${snap.error}'));
                if (!snap.hasData) return const Center(child: CircularProgressIndicator());
                final items = snap.data!;
                if (items.isEmpty) return const Center(child: Text('Empty folder'));
                return ListView.builder(
                  itemCount: items.length,
                  itemBuilder: (_, i) {
                    final n = items[i];
                    return ListTile(
                      leading: Icon(n.isFolder ? Icons.folder : Icons.insert_drive_file_outlined),
                      title: Text(n.name),
                      subtitle: n.isFolder ? null : Text('${(n.size / 1048576).toStringAsFixed(1)} MB'),
                      onTap: n.isFolder
                          ? () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => Scaffold(appBar: AppBar(), body: FilesScreen(api: widget.api, parentId: n.id, title: n.name))))
                          : null,
                    );
                  },
                );
              },
            ),
          ),
        ),
      ]);
}

class BackupScreen extends StatefulWidget {
  const BackupScreen({super.key, required this.api});
  final Api api;
  @override
  State<BackupScreen> createState() => _BackupScreenState();
}

class _BackupScreenState extends State<BackupScreen> {
  BackupSettings? _s;
  String _status = '';
  bool _running = false;

  @override
  void initState() {
    super.initState();
    BackupSettings.load().then((s) => setState(() => _s = s));
  }

  Future<void> _set({bool? enabled, bool? wifiOnly}) async {
    await BackupSettings.save(enabled: enabled, wifiOnly: wifiOnly);
    final s = await BackupSettings.load();
    if (s.enabled) {
      await Workmanager().registerPeriodicTask(_bgTask, _bgTask,
          frequency: const Duration(hours: 1),
          constraints: Constraints(networkType: s.wifiOnly ? NetworkType.unmetered : NetworkType.connected, requiresBatteryNotLow: true),
          existingWorkPolicy: ExistingWorkPolicy.replace);
    } else {
      await Workmanager().cancelByUniqueName(_bgTask);
    }
    setState(() => _s = s);
  }

  Future<void> _runNow() async {
    setState(() => _running = true);
    final r = await BackupService(widget.api).run(onProgress: (d, t) => setState(() => _status = 'Checked $d of $t'));
    setState(() {
      _running = false;
      _status = '${r.uploaded} uploaded · ${r.skipped} already safe · ${r.failed} failed${r.stoppedReason != null ? ' · ${r.stoppedReason}' : ''}';
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = _s;
    if (s == null) return const Center(child: CircularProgressIndicator());
    return ListView(padding: const EdgeInsets.all(16), children: [
      Text('Photo backup', style: Theme.of(context).textTheme.titleLarge),
      SwitchListTile(title: const Text('Back up photos & videos'), value: s.enabled, onChanged: (v) => _set(enabled: v)),
      SwitchListTile(title: const Text('Only on Wi-Fi'), subtitle: const Text('Saves your mobile data'), value: s.wifiOnly, onChanged: (v) => _set(wifiOnly: v)),
      const SizedBox(height: 8),
      FilledButton.icon(onPressed: _running || !s.enabled ? null : _runNow, icon: const Icon(Icons.cloud_upload_outlined), label: const Text('Back up now')),
      if (_status.isNotEmpty) Padding(padding: const EdgeInsets.all(8), child: Text(_status)),
      const Divider(height: 32),
      OutlinedButton.icon(
        icon: const Icon(Icons.cleaning_services_outlined),
        label: const Text('Free up space on this phone'),
        onPressed: () async {
          final ok = await showDialog<bool>(
            context: context,
            builder: (c) => AlertDialog(
              title: const Text('Free up space?'),
              content: const Text('Photos and videos already safely stored in MaxCloud will be removed from this phone. They stay in your MaxCloud account.'),
              actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Remove'))],
            ),
          );
          if (ok != true) return;
          final n = await BackupService(widget.api).freeUpSpace();
          if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Removed $n items from this phone')));
        },
      ),
    ]);
  }
}
