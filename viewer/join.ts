import './style.css';

/**
 * The invitation page of a shared folder (join.html#<file id>). Marksync may
 * only open files the user opened with it (scope drive.file), so the invited
 * person confirms the shared file once in Google's file picker; after that
 * the Marksync extension can sync it. The page then shows the code to paste
 * into Marksync's Settings. Nothing else is read or written.
 */

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim();
const API_KEY = (import.meta.env.VITE_GOOGLE_API_KEY ?? '').trim();
/** The Google Cloud project number: the picker grants access to this project's apps. */
const APP_ID = (import.meta.env.VITE_GOOGLE_APP_ID ?? '').trim();
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const tr = navigator.language.toLowerCase().startsWith('tr');
const T = tr
  ? {
      title: 'Paylaşılan bir klasöre katılın',
      text: 'Biri sizinle Marksync üzerinden bir yer imi klasörü paylaştı. Google ile giriş yapın ve açılan pencerede paylaşılan dosyayı seçin; böylece Marksync onu okuyabilir.',
      accept: 'Google ile giriş yap ve dosyayı seç',
      noCode: 'Bu bağlantıda paylaşım kodu yok. Davet e-postasındaki bağlantının tamamını açın.',
      noSetup: 'Bu görüntüleyici kopyasında Google ayarları eksik (istemci kimliği, API anahtarı, proje numarası).',
      failed: 'Olmadı: {1}',
      doneTitle: 'Neredeyse tamam',
      doneText: 'Marksync artık paylaşılan klasörü okuyabilir.',
      steps: 'Marksync uzantısında Ayarlar → Paylaşılan klasörler → Katıl bölümüne bu kodu yapıştırın. Klasör “Marksync Shared” altında görünür.',
      copy: 'Kopyala',
      copied: 'Kopyalandı',
    }
  : {
      title: 'Join a shared folder',
      text: 'Someone shared a bookmark folder with you through Marksync. Sign in with Google and pick the shared file in the window that opens, so Marksync may read it.',
      accept: 'Sign in with Google and pick the file',
      noCode: 'This link has no share code. Open the full link from the invitation e-mail.',
      noSetup: 'This copy of the viewer is missing its Google settings (client ID, API key, project number).',
      failed: 'That did not work: {1}',
      doneTitle: 'Almost done',
      doneText: 'Marksync may now read the shared folder.',
      steps: 'In the Marksync extension, open Settings → Shared folders → Join and paste this code. The folder appears under “Marksync Shared”.',
      copy: 'Copy',
      copied: 'Copied',
    };

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const fileId = decodeURIComponent(location.hash.slice(1)).trim();

$('#title').textContent = T.title;
$('#text').textContent = T.text;
$('#accept').textContent = T.accept;
$('#done-title').textContent = T.doneTitle;
$('#done-text').textContent = T.doneText;
$('#done-steps').textContent = T.steps;
$('#copy').textContent = T.copy;

function message(text: string) {
  $('#message').textContent = text;
  $('#message').hidden = !text;
}

function script(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${new URL(src).host}`));
    document.head.append(s);
  });
}

interface Picked {
  action: string;
  docs?: { id: string }[];
}
/** The parts of Google's picker this page uses (loaded at run time). */
interface Builder {
  addView(view: unknown): Builder;
  setOAuthToken(token: string): Builder;
  setDeveloperKey(key: string): Builder;
  setAppId(id: string): Builder;
  setCallback(cb: (data: Picked) => void): Builder;
  build(): { setVisible(visible: boolean): void };
}
interface PickerApi {
  PickerBuilder: new () => Builder;
  DocsView: new (viewId?: unknown) => { setFileIds(ids: string): unknown; setMode(mode: unknown): unknown };
  ViewId: { DOCS: unknown };
  DocsViewMode: { LIST: unknown };
  Action: { PICKED: string; CANCEL: string };
}

async function token(): Promise<string> {
  await script('https://accounts.google.com/gsi/client');
  const google = (window as unknown as { google: { accounts: { oauth2: { initTokenClient(c: object): { requestAccessToken(): void } } } } }).google;
  return new Promise((resolve, reject) => {
    google.accounts.oauth2
      .initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: (r: { access_token?: string; error?: string }) => (r.access_token ? resolve(r.access_token) : reject(new Error(r.error ?? 'sign-in'))),
        error_callback: (e: { message?: string; type?: string }) => reject(new Error(e.message ?? e.type ?? 'sign-in')),
      })
      .requestAccessToken();
  });
}

async function picker(accessToken: string): Promise<void> {
  await script('https://apis.google.com/js/api.js');
  const gapi = (window as unknown as { gapi: { load(name: string, cb: () => void): void } }).gapi;
  await new Promise<void>((resolve) => gapi.load('picker', resolve));
  const p = (window as unknown as { google: { picker: PickerApi } }).google.picker;
  await new Promise<void>((resolve, reject) => {
    const view = new p.DocsView(p.ViewId.DOCS);
    view.setFileIds(fileId);
    view.setMode(p.DocsViewMode.LIST);
    new p.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(API_KEY)
      .setAppId(APP_ID)
      .setCallback((data) => {
        if (data.action === p.Action.PICKED) {
          if (data.docs?.some((doc) => doc.id === fileId)) resolve();
          else reject(new Error('another file was picked'));
        } else if (data.action === p.Action.CANCEL) reject(new Error('cancelled'));
      })
      .build()
      .setVisible(true);
  });
}

if (!/^[A-Za-z0-9_-]{5,200}$/.test(fileId)) {
  message(T.noCode);
  $<HTMLButtonElement>('#accept').disabled = true;
} else if (!CLIENT_ID || !API_KEY || !APP_ID) {
  message(T.noSetup);
  $<HTMLButtonElement>('#accept').disabled = true;
}

$('#accept').addEventListener('click', () => {
  message('');
  const button = $<HTMLButtonElement>('#accept');
  button.disabled = true;
  void token()
    .then(picker)
    .then(() => {
      $('#code').textContent = fileId;
      $('#done').hidden = false;
      $('#done').scrollIntoView({ behavior: 'smooth' });
    })
    .catch((err: unknown) => message(T.failed.replace('{1}', err instanceof Error ? err.message : String(err))))
    .finally(() => (button.disabled = false));
});
$('#copy').addEventListener('click', () => {
  void navigator.clipboard.writeText(fileId).then(() => ($('#copy').textContent = T.copied));
});
