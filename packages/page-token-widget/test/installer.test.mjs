import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../scriptable/SetupUsageWidget.js', import.meta.url), 'utf8');
const widgetSource = await readFile(new URL('../scriptable/UsageWidget.js', import.meta.url), 'utf8');
const SETTINGS_KEY = 'ameaq-rmrcxu-b2';
const TOKEN = 'b'.repeat(40);

// The installer runs on a phone, not here. These stubs are the smallest world
// it can live in: an alert that remembers what it was asked, a keychain, a
// file manager that keeps what was written on it, and a request that answers
// the way the test wants it to.
class FakeAlert {
  constructor(log) {
    this.log = log;
    this.title = '';
    this.message = '';
    this.fields = [];
    this.actions = [];
    this.answer = -1;
  }
  addTextField(title, value) { this.fields.push({ title, value }); }
  addSecureTextField(title, value) { this.fields.push({ title, value, secure: true }); }
  addAction(name) { this.actions.push(name); }
  addCancelAction(name) { this.actions.push(name); }
  async presentAlert() {
    this.log.push({ title: this.title, message: this.message, fields: this.fields.length, actions: this.actions });
    return this.answer;
  }
  textFieldValue(index) { return this.fields[index] ? this.fields[index].value : ''; }
}

// A request that answers what the test tells it to. A refusal leaves the
// response behind, the way the service does: the script reads the status out
// of it, because loadJSON() throws before the body arrives. An answer may be
// a function, so a test can tell the calls apart by the token they carry.
const makeRequest = (answers, asked = []) => class {
  constructor(url) {
    this.url = url;
    this.method = 'GET';
    this.headers = {};
    this.body = '';
    this.timeoutInterval = 10;
    this.response = null;
  }
  async loadJSON() {
    const call = { url: this.url, method: this.method, auth: this.headers.Authorization || '', body: this.body };
    asked.push(call);
    const given = answers[this.url];
    const answer = typeof given === 'function' ? given(call) : given;
    if (!answer) throw new Error('no answer for ' + this.url);
    if (answer.status) {
      this.response = { statusCode: answer.status };
      const error = new Error('status ' + answer.status);
      error.response = { statusCode: answer.status };
      throw error;
    }
    // A request that answers leaves its response behind as well: that is
    // where the script reads the status of a call that worked.
    this.response = { statusCode: 200 };
    return answer.json;
  }
  async loadString() {
    const call = { url: this.url, method: this.method, auth: this.headers.Authorization || '', body: this.body };
    asked.push(call);
    const given = answers[this.url];
    const answer = typeof given === 'function' ? given(call) : given;
    if (!answer) throw new Error('no answer for ' + this.url);
    if (answer.status) {
      this.response = { statusCode: answer.status };
      throw new Error('status ' + answer.status);
    }
    this.response = { statusCode: 200 };
    return answer.text;
  }
};

const runInstaller = async ({ paired = null, answers = {}, alertAnswer = -1, saved = null } = {}) => {
  const log = [];
  const keychain = saved ? { [SETTINGS_KEY]: JSON.stringify(saved) } : {};
  const writes = {};
  const opened = [];
  const asked = [];
  const context = {
    console,
    Script: { complete: () => {} },
    Safari: { open: (url) => { opened.push(url); } },
    Keychain: {
      get: (key) => keychain[key],
      set: (key, value) => { keychain[key] = value; },
    },
    Device: { name: () => 'iPhone' },
    Alert: class extends FakeAlert {
      constructor() { super(log); }
      async presentAlert() {
        const answer = await super.presentAlert();
        return answer === -1 ? alertAnswer : answer;
      }
    },
    FileManager: {
      iCloud: () => ({
        joinPath: (...parts) => parts.join('/'),
        documentsDirectory: () => '/documents',
        fileExists: () => false,
        readString: () => '',
        writeString: (target, text) => { writes[target] = text; },
        isFileStoredIniCloud: () => false,
        downloadFileFromiCloud: async () => {},
      }),
      local: () => ({
        joinPath: (...parts) => parts.join('/'),
        documentsDirectory: () => '/local',
        fileExists: () => false,
        readString: () => '',
        writeString: (target, text) => { writes[target] = text; },
        isFileStoredIniCloud: () => false,
        downloadFileFromiCloud: async () => {},
      }),
    },
    Request: makeRequest(answers, asked),
  };
  vm.createContext(context);
  // A script that comes from the pairing page carries the address and a
  // one-time code; the service writes them into this line.
  const script = paired
    ? source.replace('let PAIRED = null;', `let PAIRED = ${JSON.stringify(paired)};`)
    : source;
  await vm.runInContext(`(async () => {\n${script}\n})();`, context);
  return { log, keychain, writes, opened, asked };
};

test('the installer of the phone pairs itself and asks for nothing', async () => {
  const baseURL = 'http://127.0.0.1:3498';
  const asked = [];
  const { log, keychain, writes } = await runInstaller({
    paired: { baseURL, code: 'the-one-time-code' },
    answers: {
      [baseURL + '/api/v1/session']: { json: { token: TOKEN, device: { id: 'd1', name: 'iPhone' }, baseURL } },
      [baseURL + '/api/v1/overview']: { json: { schemaVersion: 1 } },
      [baseURL + '/scriptable/UsageWidget.js']: { text: widgetSource },
    },
    alertAnswer: -1,
  });
  // The manual prompt is not shown: the code is exchanged by itself.
  assert.equal(log.filter(entry => entry.title === '连接你的用量').length, 0);
  // The token lands in the keychain, and the widget is written where Scriptable
  // picks it up.
  assert.deepEqual(JSON.parse(keychain[SETTINGS_KEY]), { baseURL, token: TOKEN });
  assert.equal(writes['/documents/UsageWidget.js'], widgetSource);
});

test('a code that is dead says what to do and falls back to the hand', async () => {
  const baseURL = 'http://127.0.0.1:3498';
  const { log, keychain, writes } = await runInstaller({
    paired: { baseURL, code: 'the-one-time-code' },
    answers: {
      [baseURL + '/api/v1/session']: { status: 403 },
    },
    alertAnswer: -1,
  });
  // The refusal is told in words: the way back is on the computer.
  const dead = log.find(entry => entry.title === '这个配对码用不了了');
  assert.ok(dead, 'the dead code is named');
  assert.match(dead.message, /重新生成一个配对码/);
  // Then the phone asks by hand.
  assert.equal(log.filter(entry => entry.title === '连接你的用量').length, 1);
  // Nothing was written: the hand was not filled in.
  assert.equal(keychain[SETTINGS_KEY], undefined);
  assert.deepEqual(writes, {});
});

test('an installer without a code asks by hand', async () => {
  const { log, keychain, writes } = await runInstaller({
    answers: {},
    alertAnswer: -1,
  });
  assert.equal(log.filter(entry => entry.title === '连接你的用量').length, 1);
  assert.equal(keychain[SETTINGS_KEY], undefined);
  assert.deepEqual(writes, {});
});

test('a token that is still good is used again instead of asking', async () => {
  // The phone runs the installer a second time (the port of the service may
  // have changed). A token that still works is worth more than a new one,
  // and the phone is asked with it before anything else.
  const baseURL = 'http://127.0.0.1:3498';
  const old = 'c'.repeat(40);
  const { log, keychain, writes, asked } = await runInstaller({
    paired: { baseURL, code: 'the-one-time-code' },
    saved: { baseURL, token: old },
    answers: {
      [baseURL + '/api/v1/overview']: { json: { schemaVersion: 1 } },
      [baseURL + '/scriptable/UsageWidget.js']: { text: widgetSource },
    },
    alertAnswer: -1,
  });
  // Nothing is asked: neither by hand nor with a code.
  assert.equal(log.filter(entry => entry.title === '连接你的用量').length, 0);
  assert.equal(asked.filter(call => call.url.endsWith('/api/v1/session')).length, 0);
  // The token stays the one that works, and the widget is written.
  assert.deepEqual(JSON.parse(keychain[SETTINGS_KEY]), { baseURL, token: old });
  assert.equal(writes['/documents/UsageWidget.js'], widgetSource);
  // The old token is not given up, so nothing is forgotten.
  assert.equal(asked.filter(call => call.url.endsWith('/api/v1/device/forget')).length, 0);
});

test('a new token says the old one goodbye', async () => {
  // The token of the phone is gone (it was revoked, or the service was
  // reinstalled). The code brings a new one: the row of the old one has to
  // go off the list of the service, or the list grows with every re-pair.
  const baseURL = 'http://127.0.0.1:3498';
  const old = 'c'.repeat(40);
  const { keychain, asked } = await runInstaller({
    paired: { baseURL, code: 'the-one-time-code' },
    saved: { baseURL, token: old },
    answers: {
      [baseURL + '/api/v1/session']: { json: { token: TOKEN, device: { id: 'd1', name: 'iPhone' }, baseURL } },
      // The old token is refused, the new one is let in.
      [baseURL + '/api/v1/overview']: (call) => (call.auth === 'Bearer ' + old ? { status: 401 } : { json: { schemaVersion: 1 } }),
      [baseURL + '/scriptable/UsageWidget.js']: { text: widgetSource },
      [baseURL + '/api/v1/device/forget']: { json: { forgotten: true } },
    },
    alertAnswer: -1,
  });
  // The new token is the one that is kept.
  assert.deepEqual(JSON.parse(keychain[SETTINGS_KEY]), { baseURL, token: TOKEN });
  // The old row goes off the list, and the old token is the one that asks.
  const goodbye = asked.find(call => call.url.endsWith('/api/v1/device/forget'));
  assert.ok(goodbye, 'the old token is put away');
  assert.equal(goodbye.method, 'POST');
  assert.equal(goodbye.auth, 'Bearer ' + old);
});
