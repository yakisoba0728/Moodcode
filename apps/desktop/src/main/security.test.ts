import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { assertTrustedSender, installNavigationGuards, validateExternalURL } from './security.js';
import type { TrustedSenderEvent } from './security.js';

const rendererURL = 'file:///fixture/Moodcode/dist/renderer/index.html';
const frame = (url = rendererURL) => ({ url, detached: false, isDestroyed: () => false });
const contents = () => ({ mainFrame: frame(), isDestroyed: () => false });
const forbidden = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'IPC_FORBIDDEN' && !error.message.includes('fixture-secret');

test('IPC accepts only the expected live main frame at the exact renderer URL', () => {
  const sender = contents();
  assert.doesNotThrow(() => assertTrustedSender({ sender, senderFrame: sender.mainFrame }, sender, rendererURL));
});

test('IPC rejects other WebContents even when they share a frame and URL', () => {
  const expected = contents();
  const other = { ...expected };
  assert.throws(() => assertTrustedSender({ sender: other, senderFrame: expected.mainFrame }, expected, rendererURL), forbidden);
});

test('IPC rejects missing, subframe, destroyed and detached senders', () => {
  for (const kind of ['null', 'subframe', 'contents-destroyed', 'frame-destroyed', 'detached']) {
    const sender = contents();
    let senderFrame: TrustedSenderEvent['senderFrame'] = sender.mainFrame;
    if (kind === 'null') senderFrame = null;
    if (kind === 'subframe') senderFrame = frame();
    if (kind === 'contents-destroyed') sender.isDestroyed = () => true;
    if (kind === 'frame-destroyed') sender.mainFrame.isDestroyed = () => true;
    if (kind === 'detached') sender.mainFrame.detached = true;
    assert.throws(() => assertTrustedSender({ sender, senderFrame }, sender, rendererURL), forbidden, kind);
  }
});

test('IPC rejects URL suffixes, different files, origins and normalized URL variants', () => {
  for (const url of [`${rendererURL}#fragment`, `${rendererURL}?fixture-secret`, rendererURL.replace('index.html', 'other.html'),
    rendererURL.replace('index.html', '%69ndex.html'), rendererURL.replace('file:', 'FILE:'), 'https://fixture.test/index.html', 'about:blank', '']) {
    const sender = contents();
    sender.mainFrame.url = url;
    assert.throws(() => assertTrustedSender({ sender, senderFrame: sender.mainFrame }, sender, rendererURL), forbidden);
  }
});

test('IPC checks URL on each request and sanitizes detached-object exceptions', () => {
  const sender = contents();
  const event = { sender, senderFrame: sender.mainFrame };
  assertTrustedSender(event, sender, rendererURL);
  sender.mainFrame.url = 'https://fixture-secret.test';
  assert.throws(() => assertTrustedSender(event, sender, rendererURL), forbidden);
  sender.mainFrame.isDestroyed = () => { throw new Error('fixture-secret'); };
  assert.throws(() => assertTrustedSender(event, sender, rendererURL), forbidden);
});

class NavigationDouble extends EventEmitter {
  handler?: (details: unknown) => { action: 'deny' };
  setWindowOpenHandler(handler: (details: unknown) => { action: 'deny' }) { this.handler = handler; }
}
function navigationEvent(url?: string, isMainFrame = true) {
  let prevented = 0;
  return { url, isMainFrame, preventDefault() { prevented++; }, get prevented() { return prevented; } };
}

test('navigation guards allow exact reload and block external navigation and redirects', () => {
  const webContents = new NavigationDouble();
  installNavigationGuards(webContents, rendererURL);
  for (const eventName of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    const reload = navigationEvent(rendererURL);
    webContents.emit(eventName, reload);
    assert.equal(reload.prevented, 0);
    for (const url of ['https://fixture.test', 'javascript:alert(1)', 'data:text/html,fixture', 'file:///other.html', `${rendererURL}?x`, `${rendererURL}#x`]) {
      const event = navigationEvent(url);
      webContents.emit(eventName, event);
      assert.equal(event.prevented, 1, `${eventName} ${url}`);
    }
  }
});

test('navigation guards support legacy URL arguments while denying all subframes and webviews', () => {
  const webContents = new NavigationDouble();
  installNavigationGuards(webContents, rendererURL);
  const reload = navigationEvent();
  webContents.emit('will-navigate', reload, rendererURL);
  assert.equal(reload.prevented, 0);
  const external = navigationEvent();
  webContents.emit('will-redirect', external, 'https://fixture.test');
  assert.equal(external.prevented, 1);
  for (const eventName of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
    const subframe = navigationEvent(rendererURL, false);
    webContents.emit(eventName, subframe);
    assert.equal(subframe.prevented, 1);
  }
});

test('new windows are denied and navigation guard cleanup is exact and idempotent', () => {
  const webContents = new NavigationDouble();
  const unrelated = () => {};
  webContents.on('will-navigate', unrelated);
  const dispose = installNavigationGuards(webContents, rendererURL);
  assert.deepEqual(webContents.handler?.({ url: rendererURL }), { action: 'deny' });
  assert.deepEqual(webContents.handler?.({ url: 'https://fixture.test' }), { action: 'deny' });
  dispose();
  dispose();
  assert.deepEqual(webContents.listeners('will-navigate'), [unrelated]);
  for (const channel of ['will-frame-navigate', 'will-redirect', 'will-attach-webview']) assert.equal(webContents.listenerCount(channel), 0);
});

test('external links accept HTTP and HTTPS browser URLs only', () => {
  assert.equal(validateExternalURL('https://example.test/docs?language=ko#intro'), 'https://example.test/docs?language=ko#intro');
  assert.equal(validateExternalURL('http://127.0.0.1:3210/fixture'), 'http://127.0.0.1:3210/fixture');
  assert.equal(validateExternalURL('HTTPS://EXAMPLE.TEST'), 'https://example.test/');
});

test('external link validation rejects credentials, malformed, oversized and shell protocols without echoing them', () => {
  for (const input of [null, {}, 42, '', ' https://example.test', 'https://example.test ', 'https://example.test\n',
    'https://example.test/a b', 'https://example.test/\\fixture-secret', 'https://fixture-secret@example.test',
    'https://user:fixture-secret@example.test', 'https://', 'http:example.test', 'file:///fixture-secret',
    'javascript:fixture-secret', 'data:text/html,fixture-secret', 'mailto:fixture-secret@example.test',
    `https://example.test/${'a'.repeat(4096)}`, `https://example.test/${'한'.repeat(1500)}`]) {
    assert.throws(() => validateExternalURL(input), (error: Error & { code?: string }) => error.code === 'INVALID_INPUT' && !error.message.includes('fixture-secret'));
  }
});
