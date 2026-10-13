import { useEffect, useState } from 'react';
import type { DesktopStore } from '../store.js';
import { DEFAULT_PRODUCT_SETTINGS, validateProductSettings, type ProductSettingsView } from '../../shared/product-settings.js';

export function ProductSettings({ store }: { store: DesktopStore }) {
  const [view, setView] = useState<ProductSettingsView | null>(null);
  const [settings, setSettings] = useState(() => structuredClone(DEFAULT_PRODUCT_SETTINGS));
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [message, setMessage] = useState('');
  const [packageName, setPackageName] = useState('');
  const [packageVersion, setPackageVersion] = useState('');
  useEffect(() => {
    let live = true;
    void store.getProductSettings().then(value => { if (live && value) { setView(value); setSettings(value.settings); if (value.error) setMessage(value.error); } }).catch(() => { if (live) setMessage('확장 설정을 읽지 못했어요.'); });
    return () => { live = false; };
  }, [store]);
  if (!view) return message ? <p role="alert">{message}</p> : null;
  const updateProfile = (index: number, change: Partial<typeof settings.profiles[number]>) => setSettings(current => ({ ...current, profiles: current.profiles.map((profile, i) => i === index ? { ...profile, ...change } : profile) }));
  async function save() {
    setBusy(true); setMessage('');
    try {
      const next = await store.saveProductSettings({ revision: view!.revision, settings: validateProductSettings(settings) });
      setView(next); setSettings(next.settings); setMessage('확장 설정을 저장했어요. 다음 실행부터 적용돼요.');
    } catch (error) { setMessage(error instanceof Error ? error.message : '확장 설정을 저장하지 못했어요.'); }
    finally { setBusy(false); }
  }
  return <details className="product-settings">
    <summary>웹 조사 · Skills · Plugins · 에이전트</summary>
    <fieldset disabled={busy}>
      <legend>확장 설정</legend>
      <h3>웹 조사</h3>
      <label className="checkbox-label"><input type="checkbox" checked={settings.web} onChange={event => setSettings({ ...settings, web: event.target.checked })} />공개 웹 문서 읽기 활성화</label>
      <label className="field-label">Exa 검색 키 환경 변수 · 선택<input value={settings.searchKeyEnv ?? ''} placeholder="EXA_API_KEY" onChange={event => setSettings({ ...settings, searchKeyEnv: event.target.value || undefined })} autoComplete="off" /></label>
      <p className="field-help">키 값은 입력하지 마세요. 앱을 실행한 환경의 변수 이름을 지정하면 검색을 사용할 수 있어요. 저장된 변수: {view.searchKeyConfigured ? '키 설정됨' : '키 없음'}. 웹 요청은 Build 모드에서 개별 승인이 필요해요.</p>
      <h3>Skills 검색 경로</h3>
      <p className="field-help">프로젝트의 .moodcode/skills를 우선 사용해요.</p>
      <label className="checkbox-label"><input type="checkbox" checked={settings.globalSkills} onChange={event => setSettings({ ...settings, globalSkills: event.target.checked })} />사용자 ~/.config/moodcode/skills 포함</label>
      <label className="checkbox-label"><input type="checkbox" checked={settings.compatibilitySkills} onChange={event => setSettings({ ...settings, compatibilitySkills: event.target.checked })} />.agents/skills · .claude/skills 포함 · 전역 검색 선택 시 사용자 경로도 포함</label>
      <h3>에이전트 프로파일</h3>
      <p className="field-help">최대 8개. 지침과 도구 허용 목록은 권한을 좁혀요. Plan/Build와 승인 정책은 계속 적용돼요. 하위 작업은 기존 delegate_task 도구를 사용해요.</p>
      {settings.profiles.map((profile, index) => <details key={index}>
        <summary>{profile.description || profile.id || '새 에이전트'}</summary>
        <label className="field-label">에이전트 ID<input value={profile.id} onChange={event => updateProfile(index, { id: event.target.value })} /></label>
        <label className="field-label">설명<input value={profile.description} onChange={event => updateProfile(index, { description: event.target.value })} /></label>
        <label className="field-label">지침<textarea value={profile.instructions} rows={5} onChange={event => updateProfile(index, { instructions: event.target.value })} /></label>
        <label className="field-label">모델 ID · 현재 공급자<input value={profile.modelId ?? ''} placeholder="현재 모델 사용" onChange={event => updateProfile(index, { modelId: event.target.value || undefined })} /></label>
        <label className="field-label">최대 턴 수 · 선택<input type="number" min={1} max={10000} value={profile.turnAllowance ?? ''} onChange={event => updateProfile(index, { turnAllowance: event.target.value ? Number(event.target.value) : undefined })} /></label>
        <label className="checkbox-label"><input type="checkbox" checked={profile.tools !== undefined} onChange={event => updateProfile(index, { tools: event.target.checked ? [] : undefined })} />도구 허용 목록 사용 · 비어 있으면 도구 없음</label>
        {profile.tools !== undefined ? <label className="field-label">허용 도구 · 쉼표로 구분<input defaultValue={profile.tools.join(', ')} placeholder="read_file, list_files, search_files" onBlur={event => updateProfile(index, { tools: event.target.value.split(',').map(name => name.trim()).filter(Boolean) })} /></label> : null}
        <button type="button" className="text-button" onClick={() => setSettings({ ...settings, profiles: settings.profiles.filter((_, i) => i !== index) })}>에이전트 삭제</button>
      </details>)}
      <button type="button" className="text-button" disabled={settings.profiles.length >= 8} onClick={() => setSettings({ ...settings, profiles: [...settings.profiles, { id: `agent-${settings.profiles.length + 1}`, description: '', instructions: '' }] })}>에이전트 추가</button>
      <h3>Plugins</h3>
      <p className="field-help">Moodcode EnginePlugin을 default로 내보내는 npm 패키지를 지원해요. 설치 시 패키지 스크립트는 실행하지 않아요. 활성화한 플러그인은 컴퓨터에서 코드를 실행하므로 신뢰하는 패키지만 선택하세요.</p>
      <label className="field-label">npm 패키지<input value={packageName} onChange={event => setPackageName(event.target.value)} placeholder="@scope/moodcode-plugin" /></label>
      <label className="field-label">고정 버전<input value={packageVersion} onChange={event => setPackageVersion(event.target.value)} placeholder="1.0.0" /></label>
      <button type="button" className="text-button" disabled={settings.plugins.length >= 8} onClick={() => {
        try { const next = validateProductSettings({ ...settings, plugins: [...settings.plugins, { name: packageName, version: packageVersion, enabled: false }] }); setSettings(next); setPackageName(''); setPackageVersion(''); setMessage('저장 후 설치 버튼을 사용할 수 있어요.'); }
        catch { setMessage('패키지 이름과 고정 버전을 확인해 주세요.'); }
      }}>플러그인 추가</button>
      {settings.plugins.map((plugin, index) => {
        const installed = view.installed.some(item => item.name === plugin.name && item.version === plugin.version);
        const saved = view.settings.plugins.some(item => item.name === plugin.name && item.version === plugin.version);
        return <div key={`${plugin.name}@${plugin.version}`}>
          <label className="checkbox-label"><input type="checkbox" checked={plugin.enabled} disabled={!installed && !plugin.enabled} onChange={event => setSettings({ ...settings, plugins: settings.plugins.map((item, i) => i === index ? { ...item, enabled: event.target.checked } : item) })} />{plugin.name}@{plugin.version} · {installed ? '설치됨' : '미설치'}</label>
          <button type="button" className="text-button" disabled={!saved || installed} onClick={async () => {
            setBusy(true); setInstalling(true); setMessage('플러그인을 설치하고 있어요…');
            try { const next = await store.installPlugin(plugin); setView(next); setMessage('설치했어요. 신뢰하는 플러그인이라면 활성화를 선택하고 저장하세요.'); }
            catch (error) { setMessage(error instanceof Error ? error.message : '설치하지 못했어요.'); }
            finally { setBusy(false); setInstalling(false); }
          }}>설치</button>
          <button type="button" className="text-button" onClick={() => setSettings({ ...settings, plugins: settings.plugins.filter((_, i) => i !== index) })}>목록에서 제거</button>
        </div>;
      })}
      <button type="button" className="text-button" onClick={() => void save()}>확장 설정 저장</button>
    </fieldset>
    {installing ? <button type="button" className="text-button" onClick={() => void store.cancelPluginInstall()}>설치 취소</button> : null}
    {message ? <p className="field-help" role="status">{message}</p> : null}
  </details>;
}
