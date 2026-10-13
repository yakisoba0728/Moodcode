import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { DEFAULT_PRODUCT_SETTINGS, validatePlugin, validateProductSave, validateProductSettings, type DesktopPlugin, type ProductSettingsView } from '../shared/product-settings.js';
import { readPrivateBytes, readPrivateJson, writePrivateBytes, writePrivateJson } from './private-json.js';
import { HostError } from './host.js';

export class DesktopProductSettings {
  #settings = structuredClone(DEFAULT_PRODUCT_SETTINGS);
  #installed: { name: string; version: string }[] = [];
  #install?: AbortController;
  #diskDigest?: string;
  #error?: string;
  constructor(readonly directory: string, private readonly environment: Readonly<NodeJS.ProcessEnv> = process.env) {}
  #revision() { return this.#diskDigest ?? createHash('sha256').update(JSON.stringify(DEFAULT_PRODUCT_SETTINGS)).digest('hex'); }
  get(): ProductSettingsView {
    return { settings: structuredClone(this.#settings), revision: this.#revision(), installed: structuredClone(this.#installed), ...(this.#error ? { error: this.#error } : {}), searchKeyConfigured: !!(this.#settings.searchKeyEnv && this.environment[this.#settings.searchKeyEnv]) };
  }
  async load() {
    this.#settings = structuredClone(DEFAULT_PRODUCT_SETTINGS); this.#error = undefined;
    const bytes = await readPrivateBytes(this.directory, 'product-settings.json', 524_288);
    this.#diskDigest = bytes === undefined ? undefined : createHash('sha256').update(bytes).digest('hex');
    if (bytes !== undefined) {
      try { this.#settings = validateProductSettings(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); this.#error = undefined; }
      catch { this.#settings = structuredClone(DEFAULT_PRODUCT_SETTINGS); this.#error = '확장 설정 파일이 올바르지 않아 기본값으로 시작했어요. 수정 후 저장하면 기존 파일을 별도로 보관해요.'; }
    }
    await this.#inspect();
  }
  async save(value: unknown): Promise<ProductSettingsView> {
    const input = validateProductSave(value);
    if (input.revision !== this.#revision()) throw new HostError('PRODUCT_SETTINGS_STALE', '확장 설정이 바뀌었어요. 설정을 다시 열어 주세요.');
    const disk = await readPrivateBytes(this.directory, 'product-settings.json', 524_288);
    const actualRevision = createHash('sha256').update(disk ?? JSON.stringify(DEFAULT_PRODUCT_SETTINGS)).digest('hex');
    if (actualRevision !== input.revision) throw new HostError('PRODUCT_SETTINGS_STALE', '다른 프로세스가 확장 설정을 변경했어요.');
    if (input.settings.plugins.some(plugin => plugin.enabled && !this.#installed.some(item => item.name === plugin.name && item.version === plugin.version))) throw new HostError('PLUGIN_NOT_INSTALLED', '먼저 플러그인을 비활성 상태로 저장하고 고정 버전을 설치해 주세요.');
    if (this.#error && disk) await writePrivateBytes(this.directory, `product-settings.invalid-${randomUUID()}.json`, disk, 524_288);
    await writePrivateJson(this.directory, 'product-settings.json', input.settings, 524_288, async () => {
      const current = await readPrivateBytes(this.directory, 'product-settings.json', 524_288);
      if (createHash('sha256').update(current ?? JSON.stringify(DEFAULT_PRODUCT_SETTINGS)).digest('hex') !== input.revision) throw new HostError('PRODUCT_SETTINGS_STALE', '저장하는 동안 다른 프로세스가 설정을 변경했어요.');
    });
    this.#diskDigest = createHash('sha256').update(JSON.stringify(input.settings)).digest('hex'); this.#error = undefined;
    this.#settings = input.settings;
    await this.#inspect();
    return this.get();
  }
  runtime(codexModels?: readonly string[]) {
    if (codexModels && this.#settings.profiles.some(profile => profile.modelId && !codexModels.includes(profile.modelId))) throw new HostError('ACCOUNT_MODEL_REQUIRED', 'Codex 계정에서 제공하는 모델로 에이전트 프로파일을 설정해 주세요.');
    const key = this.#settings.web && this.#settings.searchKeyEnv ? this.environment[this.#settings.searchKeyEnv] || undefined : undefined;
    if (key !== undefined && !/^[\x21-\x7e]{1,4096}$/u.test(key)) throw new HostError('WEB_CREDENTIAL_INVALID', '검색 키 환경 변수의 값이 올바르지 않아요.');
    const plugins = this.#settings.plugins.filter(item => item.enabled).map(item => {
      if (!this.#installed.some(installed => installed.name === item.name && installed.version === item.version)) throw new HostError('PLUGIN_NOT_INSTALLED', '활성화한 플러그인의 고정 버전이 설치되어 있지 않아요.');
      return { ...item, entry: this.#entry(item) };
    });
    return { productSettings: structuredClone(this.#settings), ...(key ? { searchKey: key } : {}), plugins };
  }
  #entry(item: DesktopPlugin): string {
    const root = join(this.directory, 'plugins', 'node_modules', item.name);
    const entry = createRequire(join(this.directory, 'plugins', 'package.json')).resolve(item.name);
    if (realpathSync(entry) !== entry || !entry.startsWith(`${root}/`) && !entry.startsWith(`${root}\\`)) throw new HostError('PLUGIN_ENTRY_UNSAFE', '플러그인 진입점이 설치된 패키지를 벗어났어요.');
    return entry;
  }
  async #inspect() {
    this.#installed = [];
    const root = join(this.directory, 'plugins');
    for (const plugin of this.#settings.plugins) {
      try {
        const directory = join(root, 'node_modules', plugin.name);
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) continue;
        const metadata = await readPrivateJson(directory, 'package.json', 262_144) as { name?: string; version?: string } | undefined;
        if (metadata?.name === plugin.name && metadata.version === plugin.version) { this.#entry(plugin); this.#installed.push({ name: plugin.name, version: plugin.version }); }
      } catch { /* A missing or damaged package remains disabled until it can be installed. */ }
    }
  }
  cancelInstall(): void { this.#install?.abort(); }
  async install(value: unknown): Promise<ProductSettingsView> {
    const plugin = validatePlugin(value);
    if (this.#install) throw new HostError('PLUGIN_INSTALL_BUSY', '플러그인 설치가 진행 중이에요.');
    const root = join(this.directory, 'plugins');
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (await realpath(root) !== root) throw new HostError('PLUGIN_DIRECTORY_UNSAFE', '플러그인 설치 경로가 올바르지 않아요.');
    const controller = new AbortController(); this.#install = controller;
    try {
      if (!await readPrivateJson(root, 'package.json', 262_144)) await writePrivateJson(root, 'package.json', { name: 'moodcode-user-plugins', private: true }, 262_144);
      // Package lifecycle scripts stay disabled; execution happens only after explicit enablement.
      const args = ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--registry=https://registry.npmjs.org', `${plugin.name}@${plugin.version}`];
      const env = Object.fromEntries(['PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR'].flatMap(name => this.environment[name] ? [[name, this.environment[name]!]] : []));
      let command = 'npm', commandArgs = args;
      if (process.platform === 'win32') {
        let cli: string | undefined;
        for (const directory of (env.Path ?? env.PATH ?? '').split(delimiter)) {
          const candidate = join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
          try { if ((await lstat(candidate)).isFile()) { cli = candidate; break; } } catch { /* Try the next explicit host PATH entry. */ }
        }
        if (!cli) throw new HostError('PLUGIN_INSTALL_FAILED', '설치된 Node.js의 npm CLI를 찾지 못했어요.');
        command = 'node'; commandArgs = [cli, ...args];
      }
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, commandArgs, { cwd: root, env: { ...env, NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_USERCONFIG: join(root, 'empty.npmrc') }, stdio: 'ignore', windowsHide: true, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]) });
        let failed = false; child.once('error', () => { failed = true; });
        child.once('close', code => !failed && code === 0 ? resolve() : reject(new HostError('PLUGIN_INSTALL_FAILED', controller.signal.aborted ? '플러그인 설치를 취소했어요.' : '플러그인 설치가 완료되지 않았어요. npm과 패키지의 고정 버전을 확인해 주세요.')));
      });
      await this.#inspect();
      return this.get();
    } finally { this.#install = undefined; }
  }
}
