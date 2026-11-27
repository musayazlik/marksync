import { browser } from 'wxt/browser';
import { errorText, localizePage, t, tn } from '../../shared/i18n';
import { send } from '../../shared/messages';
import {
  encryptionStatusItem,
  type EncryptionStatus,
  aiBulkItem,
  aiTidyItem,
  aiNamingItem,
  type TidyJob,
  semanticJobItem,
  DEFAULT_EMBEDDING_MODEL,
  aiSpendItem,
  aiUsageItem,
  endpointKeyItem,
  DEFAULT_AI_MODEL,
  getSettings,
  MODEL_ID,
  SUGGESTED_AI_MODELS,
  openRouterKeyItem,
  settingsItem,
  statusItem,
  type BulkJob,
  type BulkProposal,
  type Settings,
  type Status,
} from '../../shared/state';
import { OPENROUTER_ORIGIN } from '../../platform/openrouter';
import { prepareBuiltin, type BuiltinState } from '../../platform/builtin-ai';
import { builtinLanguage, ENDPOINT_MODEL, isLocalEndpoint, parseEndpoint, type AiProvider } from '../../core/ai-provider';
import { maskEmail } from '../../core/mask';
import { MIN_PASSPHRASE, passphraseStrength } from '../../core/crypto';
import { budgetState, currentSpend, nextMonthStart } from '../../core/budget';
import { formatTokens, formatUsd, searchModels, type ModelFilter, type ModelInfo } from '../../core/openrouter-data';
import { $, emblemState, revealOnClick, RELEASES_URL, setEmblem, showToast, statusTone, timeAgo, withBusy } from '../../shared/ui';
import { detectBrowser } from '../../platform/browser-info';
import type { BackupInfo } from '../../services/backup-service';
import type { TidyEstimate } from '../../services/tidy-service';
import type { NamingEstimate } from '../../services/naming-service';
import type { ImportMode, ImportResult } from '../../sync/importer';

localizePage();

// The version comes from package.json (set by release-please) and links to
// that release's notes on GitHub.
const version = browser.runtime.getManifest().version;
const versionLink = $<HTMLAnchorElement>('#version');
versionLink.textContent = t('version', version);
versionLink.href = `${RELEASES_URL}/tag/v${version}`;
const actionError = $('#action-error');
/** The page opened right after installing (see background.ts). */
const welcome = location.hash === '#welcome';

let syncEnabled = true;
let lastStatus: Status = { connected: false, syncing: false };
/** The account address is masked until clicked. */
let emailShown = false;

function renderStatus(s: Status) {
  lastStatus = s;
  setEmblem($('#emblem'), emblemState(s, syncEnabled));
  $('#welcome').hidden = !welcome || s.connected;
  const account = $('#account-text');
  account.textContent = s.connected
    ? s.email
      ? t('connectedAs', emailShown ? s.email : maskEmail(s.email))
      : t('connected')
    : t('notConnected');
  account.title = s.connected && s.email ? t(emailShown ? 'emailHide' : 'emailShow') : '';
  account.classList.toggle('revealable', !!(s.connected && s.email));
  account.setAttribute('aria-pressed', String(emailShown));
  $('#connect').hidden = s.connected && s.error?.code !== 'auth';
  $('#connect').textContent = t(s.connected ? 'reconnect' : 'connectDrive');
  $('#disconnect').hidden = !s.connected;
  $('#sync-text').textContent = !s.connected
    ? t('popupIntro')
    : !syncEnabled
      ? t('syncOff')
      : s.syncing
        ? t('syncing')
        : t('lastSync', timeAgo(s.lastSyncAt));
  const error = $('#sync-error');
  error.hidden = !s.connected || !s.error;
  error.className = `notice small hero-error ${statusTone(s) === 'warn' ? 'warn' : 'error'}`;
  if (s.error) error.textContent = errorText(s.error);
}

revealOnClick($('#account-text'), () => {
  if (!lastStatus.email) return;
  emailShown = !emailShown;
  renderStatus(lastStatus);
});

// ---------- section rail ----------

/** Marks the section in view on the rail; the ribbon slides to it. */
function initRail() {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.rail a')];
  const ribbon = $('.rail-ribbon');
  const sections = links.map((a) => document.querySelector<HTMLElement>(a.hash)!);
  const mark = (index: number) => {
    links.forEach((a, i) => a.setAttribute('aria-current', String(i === index)));
    const link = links[index]!;
    ribbon.style.setProperty('--ribbon-y', `${link.offsetTop + (link.offsetHeight - 22) / 2}px`);
  };
  const update = () => {
    // The last section whose top has passed a third of the window.
    const line = window.innerHeight / 3;
    let index = 0;
    sections.forEach((sec, i) => {
      if (sec.getBoundingClientRect().top <= line) index = i;
    });
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) index = sections.length - 1;
    mark(index);
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
}

// ---------- settings ----------

const fields = {
  syncEnabled: 'checkbox',
  autoBackup: 'checkbox',
  syncIntervalMin: 'number',
  backupIntervalHours: 'number',
  backupRetention: 'number',
  deviceName: 'text',
  aiAllowNewFolders: 'checkbox',
  aiResearch: 'checkbox',
  aiMonthlyBudget: 'number',
  digestFrequency: 'text',
  semanticEnabled: 'checkbox',
} as const satisfies Partial<Record<keyof Settings, string>>;

async function loadSettings() {
  const s = await getSettings();
  $<HTMLInputElement>('#deviceName').placeholder = detectBrowser();
  for (const [key, kind] of Object.entries(fields) as [keyof typeof fields, string][]) {
    const el = $<HTMLInputElement>(`#${key}`);
    if (kind === 'checkbox') el.checked = s[key] as boolean;
    else el.value = String(s[key]);
    el.addEventListener('change', async () => {
      const value = kind === 'checkbox' ? el.checked : kind === 'number' ? Number(el.value) : el.value.trim();
      await settingsItem.setValue({ ...(await getSettings()), [key]: value });
      await send({ type: 'settingsChanged' });
    });
  }
}

// ---------- backups ----------

const reasonKey: Record<BackupInfo['reason'], string | undefined> = {
  manual: undefined,
  scheduled: 'backupReasonScheduled',
  'before-restore': 'backupReasonBeforeRestore',
  'before-remote-delete': 'backupReasonBeforeRemoteDelete',
  'before-cleanup': 'backupReasonBeforeCleanup',
};

function backupDate(b: BackupInfo): string {
  const date = new Date(b.createdTime).toLocaleString();
  const key = reasonKey[b.reason];
  return key ? `${date} (${t(key)})` : date;
}

async function loadBackups() {
  const status = await statusItem.getValue();
  const tbody = $('#backups tbody');
  tbody.replaceChildren();
  $('#backups').hidden = !status.connected;
  if (!status.connected) return;
  const backups = await send({ type: 'listBackups' });
  $('#backups-empty').hidden = backups.length > 0;
  for (const b of backups) {
    const tr = document.createElement('tr');
    const cells = [
      backupDate(b),
      b.source,
      b.count.toLocaleString(),
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    const actions = document.createElement('td');
    const restore = document.createElement('button');
    restore.textContent = t('restore');
    restore.addEventListener('click', () => {
      if (!confirm(t('confirmRestore', cells[0]!))) return;
      void withBusy(restore, () => send({ type: 'restoreBackup', id: b.id }).then(loadBackups), actionError);
    });
    const del = document.createElement('button');
    del.textContent = t('delete');
    del.className = 'danger';
    del.addEventListener('click', () => {
      if (!confirm(t('confirmDeleteBackup'))) return;
      void withBusy(del, () => send({ type: 'deleteBackup', id: b.id }).then(loadBackups), actionError);
    });
    // Compare with now and bring back single items (history.html).
    const historyLink = document.createElement('a');
    historyLink.className = 'button';
    historyLink.href = `./history.html?id=${encodeURIComponent(b.id)}`;
    historyLink.textContent = t('historyOpen');
    historyLink.title = t('historyOpenHint');
    actions.append(historyLink, ' ', restore, ' ', del);
    tr.append(actions);
    tbody.append(tr);
  }
}

// ---------- AI sorting ----------

const aiEnabled = $<HTMLInputElement>('#aiSortEnabled');
const aiInbox = $<HTMLSelectElement>('#aiInboxFolderId');
const aiKeyInput = $<HTMLInputElement>('#ai-key');
/** OpenRouter keys look like "sk-or-v1-…"; anything else is rejected before saving. */
const KEY_FORMAT = /^[\w-]{20,200}$/;
let aiFolders: { id: string; path: string }[] = [];

async function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  await settingsItem.setValue({ ...(await getSettings()), [key]: value });
  await send({ type: 'settingsChanged' });
}

/**
 * The settings as last read, so click handlers can ask for a permission
 * without awaiting first (a prompt needs the user action, see below).
 */
let aiSettings: Settings | undefined;
/** Whether the browser's own model can run, as the background last reported it. */
let builtinState: BuiltinState | undefined;

/** The host AI sorting talks to with these settings; undefined for the on-device model. */
function aiOrigin(s: Pick<Settings, 'aiProvider' | 'aiEndpoint'>): string | undefined {
  if (s.aiProvider === 'openrouter') return OPENROUTER_ORIGIN;
  if (s.aiProvider === 'custom') return parseEndpoint(s.aiEndpoint)?.origin;
  return undefined;
}

/**
 * Asks for the AI host, and in Firefox 140+ for consent to send bookmark
 * data. Must be called directly in the click handler: browsers only show a
 * permission prompt in response to a user action. Nothing to ask for the
 * on-device model (`origin` undefined).
 */
function requestAiPermission(origin: string | undefined): Promise<boolean> {
  if (!origin) return Promise.resolve(true);
  const origins = [origin];
  if (import.meta.env.FIREFOX) {
    const withConsent = { origins, data_collection: ['bookmarksInfo'] } as Parameters<typeof browser.permissions.request>[0];
    // Firefox before 140 does not know data_collection.
    return browser.permissions.request(withConsent).catch(() => browser.permissions.request({ origins }));
  }
  return browser.permissions.request({ origins });
}

const keyHint = (key: string) => `${key.slice(0, 6)}…${key.slice(-4)}`;

/** What is still missing for the chosen provider, or '' when it is set up. */
async function providerProblem(s: Settings): Promise<string> {
  if (s.aiProvider === 'builtin') {
    if (builtinState === 'available') return '';
    return builtinState === 'downloadable' || builtinState === 'downloading' ? t('aiBuiltinNotReady') : t('aiBuiltinUnavailable');
  }
  if (s.aiProvider === 'custom') {
    const endpoint = parseEndpoint(s.aiEndpoint);
    if (!endpoint) return t('aiNoEndpoint');
    if (!(await browser.permissions.contains({ origins: [endpoint.origin] }))) return t('aiPermissionMissingHost', endpoint.label);
    if (!s.aiEndpointModel) return t('aiNoEndpointModel');
    return '';
  }
  if (!(await browser.permissions.contains({ origins: [OPENROUTER_ORIGIN] }))) return t('aiPermissionMissing');
  if (!(await openRouterKeyItem.getValue())) return t('aiNoKey');
  return '';
}

/** Shows the settings of the chosen provider only, and its privacy note. */
function renderProvider(s: Settings) {
  for (const node of document.querySelectorAll<HTMLElement>('[data-provider]')) {
    node.hidden = node.dataset.provider !== s.aiProvider;
  }
  $<HTMLSelectElement>('#aiProvider').value = s.aiProvider;
  const endpoint = parseEndpoint(s.aiEndpoint);
  $('#ai-privacy').textContent =
    s.aiProvider === 'builtin'
      ? t('aiPrivacyBuiltin')
      : s.aiProvider === 'custom'
        ? t('aiPrivacyCustom', endpoint?.label ?? t('aiEndpointNone'))
        : t('aiPrivacy');
  $('#ai-provider-help').textContent = t(
    s.aiProvider === 'builtin' ? 'aiProviderHelpBuiltin' : s.aiProvider === 'custom' ? 'aiProviderHelpCustom' : 'aiProviderHelpOpenRouter',
  );
}

async function renderAiStatus() {
  const s = await getSettings();
  aiSettings = s;
  renderProvider(s);
  const key = await openRouterKeyItem.getValue();
  const status = $('#ai-status');
  const inbox = aiFolders.find((f) => f.id === s.aiInboxFolderId);
  const problem = await providerProblem(s);
  let text = '';
  if (s.aiSortEnabled) {
    if (problem && problem !== t('aiNoKey') && problem !== t('aiNoEndpointModel')) text = problem;
    else if (!s.aiInboxFolderId) text = t('aiChooseInbox');
    else if (!inbox) text = t('aiInboxMissing');
    else if (problem) text = problem;
    else text = t('aiReady', inbox.path);
  }
  status.textContent = text;
  status.hidden = !text;
  status.classList.toggle('warn', !!text && !(inbox && !problem));
  $<HTMLButtonElement>('#ai-sort-now').disabled = !(s.aiSortEnabled && inbox && !problem);

  $('#ai-key-state').textContent = key ? t('aiKeySaved', keyHint(key)) : t('aiKeyNone');
  $('#ai-key-remove').hidden = !key;
  $<HTMLButtonElement>('#ai-key-test').disabled = !key;

  const endpoint = parseEndpoint(s.aiEndpoint);
  const endpointState = $('#ai-endpoint-state');
  endpointState.textContent = endpoint
    ? isLocalEndpoint(endpoint) || endpoint.base.startsWith('https:')
      ? t('aiEndpointSaved', endpoint.base)
      : t('aiEndpointInsecure', endpoint.base)
    : t('aiEndpointNone');
  endpointState.classList.toggle('warn-text', !!endpoint && !isLocalEndpoint(endpoint) && !endpoint.base.startsWith('https:'));
  if (document.activeElement !== $('#ai-endpoint')) $<HTMLInputElement>('#ai-endpoint').value = s.aiEndpoint;
  if (document.activeElement !== $('#ai-endpoint-model')) $<HTMLInputElement>('#ai-endpoint-model').value = s.aiEndpointModel;
  $<HTMLButtonElement>('#ai-endpoint-test').disabled = !endpoint;
  const endpointKey = await endpointKeyItem.getValue();
  $('#ai-endpoint-key-state').textContent = endpointKey ? t('aiKeySaved', keyHint(endpointKey)) : t('aiEndpointKeyNone');
  $('#ai-endpoint-key-remove').hidden = !endpointKey;
}

// ---------- AI provider: OpenAI-compatible endpoint and built-in model ----------

const aiProvider = $<HTMLSelectElement>('#aiProvider');
const endpointInput = $<HTMLInputElement>('#ai-endpoint');
const endpointModelInput = $<HTMLInputElement>('#ai-endpoint-model');
const endpointKeyInput = $<HTMLInputElement>('#ai-endpoint-key');

aiProvider.addEventListener('change', () => {
  actionError.hidden = true;
  const provider = aiProvider.value as AiProvider;
  const origin = aiSettings ? aiOrigin({ ...aiSettings, aiProvider: provider }) : undefined;
  // Ask for the new host now, while the choice counts as a user action.
  const asked = aiSettings?.aiSortEnabled ? requestAiPermission(origin) : Promise.resolve(true);
  void asked
    .then(async (granted) => {
      await saveSetting('aiProvider', provider);
      if (!granted) throw new Error(t('aiPermissionDenied'));
    })
    .catch(showError)
    .finally(() => {
      void renderAiStatus();
      if (provider === 'builtin') void renderBuiltin();
      if (provider === 'openrouter') void loadModels();
    });
});

$('#ai-endpoint-save').addEventListener('click', () => {
  actionError.hidden = true;
  const endpoint = parseEndpoint(endpointInput.value);
  if (!endpoint) {
    showError(new Error(t('aiEndpointInvalid')));
    return;
  }
  // No await before this call: the permission prompt needs the click.
  void withBusy(
    $<HTMLButtonElement>('#ai-endpoint-save'),
    async () => {
      const granted = await requestAiPermission(endpoint.origin);
      await saveSetting('aiEndpoint', endpoint.base);
      endpointInput.value = endpoint.base;
      await renderAiStatus();
      if (!granted) throw new Error(t('aiPermissionDeniedHost', endpoint.label));
      showToast($('#action-ok'), t('aiEndpointSavedToast', endpoint.label));
    },
    actionError,
  );
});
endpointInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $<HTMLButtonElement>('#ai-endpoint-save').click();
});

$('#ai-endpoint-test').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#ai-endpoint-test'),
    async () => {
      const ids = await send({ type: 'aiEndpointModels' });
      $('#ai-endpoint-models').replaceChildren(
        ...ids.map((id) => Object.assign(document.createElement('option'), { value: id })),
      );
      const result = $('#ai-result');
      result.textContent = ids.length ? tn('aiEndpointTestOk', ids.length) : t('aiEndpointTestNoModels');
      result.hidden = false;
      // A single model on the server: nothing to choose.
      if (ids.length === 1 && !(await getSettings()).aiEndpointModel) {
        endpointModelInput.value = ids[0]!;
        await saveSetting('aiEndpointModel', ids[0]!);
      }
    },
    actionError,
  ),
);

$('#ai-endpoint-model-save').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#ai-endpoint-model-save'),
    async () => {
      const model = endpointModelInput.value.trim();
      if (!ENDPOINT_MODEL.test(model)) throw new Error(t('aiEndpointModelInvalid'));
      await saveSetting('aiEndpointModel', model);
      await renderAiStatus();
      showToast($('#action-ok'), t('aiEndpointModelSaved', model));
    },
    actionError,
  ),
);
endpointModelInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $<HTMLButtonElement>('#ai-endpoint-model-save').click();
});

$('#ai-endpoint-key-save').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#ai-endpoint-key-save'),
    async () => {
      const key = endpointKeyInput.value.trim();
      if (!/^[\x21-\x7e]{1,500}$/.test(key)) throw new Error(t('aiKeyInvalid'));
      await endpointKeyItem.setValue(key);
      endpointKeyInput.value = '';
      await renderAiStatus();
    },
    actionError,
  ),
);
endpointKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $<HTMLButtonElement>('#ai-endpoint-key-save').click();
});
$('#ai-endpoint-key-remove').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#ai-endpoint-key-remove'),
    async () => {
      if (!confirm(t('aiConfirmRemoveKey'))) return;
      await endpointKeyItem.removeValue();
      await renderAiStatus();
    },
    actionError,
  ),
);

const builtinText: Record<BuiltinState, string> = {
  unsupported: 'aiBuiltinUnsupported',
  unavailable: 'aiBuiltinUnavailable',
  downloadable: 'aiBuiltinDownloadable',
  downloading: 'aiBuiltinDownloading',
  available: 'aiBuiltinReady',
};

/** Asks the background (where the model runs) whether it can run, and shows it. */
async function renderBuiltin() {
  builtinState = await send({ type: 'aiBuiltinStatus' }).catch(() => 'unsupported' as const);
  const state = $('#ai-builtin-state');
  state.textContent = t(builtinText[builtinState]);
  state.className = `small ${builtinState === 'available' ? '' : builtinState === 'downloadable' || builtinState === 'downloading' ? 'muted' : 'warn-text'}`;
  // The page can start the download only where the page itself has the API.
  $('#ai-builtin-prepare').hidden = !(builtinState === 'downloadable' || builtinState === 'downloading') || !('LanguageModel' in self);
  await renderAiStatus();
}

$('#ai-builtin-prepare').addEventListener('click', () => {
  const button = $<HTMLButtonElement>('#ai-builtin-prepare');
  const progress = $<HTMLProgressElement>('#ai-builtin-progress');
  progress.hidden = false;
  progress.removeAttribute('value');
  // Started straight from the click: the download needs the user action.
  const download = prepareBuiltin(builtinLanguage(browser.i18n.getUILanguage()), (loaded) => {
    // After the download the model is unpacked: show an open-ended bar.
    if (loaded >= 1) progress.removeAttribute('value');
    else progress.value = loaded;
  });
  void withBusy(button, () => download, actionError).finally(() => {
    progress.hidden = true;
    void renderBuiltin();
  });
});

async function loadAiFolders() {
  const s = await getSettings();
  aiFolders = await send({ type: 'aiListFolders' });
  const none = document.createElement('option');
  none.value = '';
  none.textContent = t('aiInboxNone');
  const options = [none];
  for (const f of aiFolders) {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = f.path;
    options.push(o);
  }
  if (s.aiInboxFolderId && !aiFolders.some((f) => f.id === s.aiInboxFolderId)) {
    const missing = document.createElement('option');
    missing.value = s.aiInboxFolderId;
    missing.textContent = t('aiInboxMissingOption');
    options.push(missing);
  }
  aiInbox.replaceChildren(...options);
  aiInbox.value = s.aiInboxFolderId;
  // Bulk sorting can start from any folder; the inbox is offered too.
  const bulkFolder = $<HTMLSelectElement>('#bulk-folder');
  const keep = bulkFolder.value;
  const choose = document.createElement('option');
  choose.value = '';
  choose.textContent = t('aiBulkFolderLabel');
  bulkFolder.replaceChildren(
    choose,
    ...aiFolders.map((f) => Object.assign(document.createElement('option'), { value: f.id, textContent: f.path })),
  );
  bulkFolder.value = aiFolders.some((f) => f.id === keep) ? keep : '';
  fillTidyScopes();
  fillNamingFolders();
  await renderAiStatus();
}

async function initAi() {
  const s = await getSettings();
  aiEnabled.checked = s.aiSortEnabled;
  $('#ai-model-help').textContent = t('aiModelHelp', DEFAULT_AI_MODEL);
  currentModel = s.aiModel;
  researchOn = s.aiResearch;
  renderModels();
  $<HTMLInputElement>('#bulk-research').checked = false;
  aiSettings = s;
  // Firefox has no on-device model to offer.
  if (import.meta.env.FIREFOX && s.aiProvider !== 'builtin') aiProvider.querySelector('option[value="builtin"]')?.remove();
  renderProvider(s);
  await Promise.all([
    loadAiFolders(),
    loadModels(),
    renderBudget(),
    aiBulkItem.getValue().then((j) => renderBulk(j ?? undefined)),
    aiTidyItem.getValue().then((j) => renderTidy(j ?? undefined)),
    aiNamingItem.getValue().then((j) => renderNaming(j ?? undefined)),
    // Checked even when another provider is chosen, so switching shows the state at once.
    renderBuiltin(),
  ]);
  void renderTidyEstimate();
  void renderSemantic();
}

aiEnabled.addEventListener('change', () => {
  actionError.hidden = true;
  if (!aiEnabled.checked) {
    void saveSetting('aiSortEnabled', false).then(renderAiStatus);
    return;
  }
  // No await before this call: the permission prompt needs the user action.
  void requestAiPermission(aiSettings ? aiOrigin(aiSettings) : OPENROUTER_ORIGIN)
    .then(async (granted) => {
      if (!granted) {
        aiEnabled.checked = false;
        throw new Error(t('aiPermissionDenied'));
      }
      await saveSetting('aiSortEnabled', true);
      void loadModels();
    })
    .catch(showError)
    .finally(renderAiStatus);
});
aiInbox.addEventListener('change', () => void saveSetting('aiInboxFolderId', aiInbox.value).then(renderAiStatus));

$('#ai-key-save').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#ai-key-save'),
    async () => {
      const key = aiKeyInput.value.trim();
      if (!KEY_FORMAT.test(key)) throw new Error(t('aiKeyInvalid'));
      await openRouterKeyItem.setValue(key);
      await aiUsageItem.removeValue();
      aiKeyInput.value = '';
      await renderAiStatus();
    },
    actionError,
  ),
);
aiKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $<HTMLButtonElement>('#ai-key-save').click();
});
$('#ai-key-remove').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#ai-key-remove'),
    async () => {
      if (!confirm(t('aiConfirmRemoveKey'))) return;
      await openRouterKeyItem.removeValue();
      await aiUsageItem.removeValue();
      await renderAiStatus();
    },
    actionError,
  ),
);
$('#ai-key-test').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#ai-key-test'),
    async () => {
      const label = await send({ type: 'aiTestKey' });
      const result = $('#ai-result');
      result.textContent = label ? t('aiTestOkLabel', label) : t('aiTestOk');
      result.hidden = false;
    },
    actionError,
  ),
);
$('#ai-sort-now').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#ai-sort-now'),
    async () => {
      const r = await send({ type: 'aiSortNow' });
      const result = $('#ai-result');
      result.textContent = t('aiSortNowResult', r.sorted, r.kept, r.failed) + (r.budgetStopped ? ` ${t('aiBudgetStopped')}` : '');
      result.hidden = false;
    },
    actionError,
  ),
);
// Folders may have changed in another tab or the bookmark manager.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void loadAiFolders().catch(showError);
});
/** Under the budget field: what AI sorting spent this month, against the cap. */
async function renderBudget() {
  const [s, stored] = await Promise.all([getSettings(), aiSpendItem.getValue()]);
  const b = budgetState(currentSpend(stored).usd, s.aiMonthlyBudget);
  const help = $('#ai-budget-help');
  help.classList.toggle('warn-text', b.state === 'near');
  help.classList.toggle('error-text', b.state === 'over');
  help.textContent =
    b.state === 'off'
      ? t('aiBudgetHelpOff', formatUsd(b.spent))
      : b.state === 'over'
        ? t('aiBudgetHelpOver', formatUsd(b.spent), formatUsd(b.budget), nextMonthStart().toLocaleDateString())
        : t('aiBudgetHelpOn', formatUsd(b.spent), formatUsd(b.budget));
}
aiSpendItem.watch(() => void renderBudget());

let estimateTimer: ReturnType<typeof setTimeout> | undefined;
settingsItem.watch((s) => {
  void renderAiStatus();
  void renderBudget();
  // Provider or model changed: the estimate changes with it.
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(() => {
    void renderTidyEstimate();
    void renderSemantic();
    void renderNamingEstimate();
  }, 400);
  if (s && (s.aiModel !== currentModel || s.aiResearch !== researchOn)) {
    currentModel = s.aiModel;
    researchOn = s.aiResearch;
    renderModels();
  }
});

// ---------- AI model picker ----------

const modelSearch = $<HTMLInputElement>('#ai-model-search');
const modelList = $<HTMLUListElement>('#ai-model-list');
/** At most this many rows are drawn; the search narrows the rest. */
const RENDER_MAX = 120;
let models: ModelInfo[] = [];
let modelsState: 'loading' | 'ok' | 'offline' | 'failed' = 'loading';
let modelsError = '';
let modelFilter: ModelFilter = 'all';
let currentModel = DEFAULT_AI_MODEL;
let researchOn = true;
/** Options drawn in the list, in order; the keyboard highlight moves over them. */
let options: HTMLLIElement[] = [];
let active = -1;

/** Shown until the full list is loaded (or when openrouter.ai is not allowed yet). */
const suggested = (): ModelInfo[] =>
  SUGGESTED_AI_MODELS.map((id) => ({ id, name: id, context: 0, free: false, tools: true, created: 0 }));

/** "Anthropic: Claude Opus 5.5" → ["Claude Opus 5.5", "Anthropic"]. */
function splitName(m: ModelInfo): [string, string] {
  const i = m.name.indexOf(': ');
  return i > 0 ? [m.name.slice(i + 2), m.name.slice(0, i)] : [m.name, m.id.split('/')[0] ?? ''];
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Marks models that can read pages and search the web. */
function globe(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  // Static markup, no user data.
  svg.innerHTML =
    '<circle cx="8" cy="8" r="6.3"/><path d="M1.7 8h12.6M8 1.7c1.9 1.8 2.7 3.9 2.7 6.3S9.9 12.5 8 14.3M8 1.7C6.1 3.5 5.3 5.6 5.3 8s.8 4.5 2.7 6.3"/>';
  return svg;
}

function priceLabel(m: ModelInfo): string {
  if (m.free) return t('aiModelFree');
  if (m.prompt === undefined) return '';
  return t('aiModelPrice', formatUsd(m.prompt), formatUsd(m.completion ?? 0));
}

function modelPills(m: ModelInfo, full: boolean): HTMLElement[] {
  if (!m.created && !m.context) return [];
  const pills: HTMLElement[] = [];
  // Rows in the list are compact; the full wording is in the tooltip and on the chosen model.
  const price = priceLabel(m);
  if (price) {
    const compact = m.free || full ? price : `${formatUsd(m.prompt!)} / ${formatUsd(m.completion ?? 0)}`;
    const pill = el('span', m.free ? 'pill free' : 'pill price', compact);
    pill.title = price;
    pills.push(pill);
  }
  if (m.context) {
    const context = t('aiModelContext', formatTokens(m.context));
    const pill = el('span', 'pill', full ? context : formatTokens(m.context));
    pill.title = context;
    pills.push(pill);
  }
  if (m.tools) {
    const tools = el('span', 'pill tools');
    tools.append(globe());
    if (full) tools.append(t('aiModelFilterTools'));
    tools.title = t('aiModelToolsHint');
    if (!full) tools.setAttribute('aria-label', t('aiModelToolsHint'));
    pills.push(tools);
  }
  return pills;
}

function renderCurrent() {
  const box = $('#ai-model-current');
  const known = (modelsState === 'ok' ? models : suggested()).find((m) => m.id === currentModel);
  const [name, vendor] = known ? splitName(known) : [currentModel, ''];
  const head = el('div', 'model-current-head');
  head.append(el('span', 'model-ribbon'), el('div', 'model-current-text'));
  const text = head.lastElementChild!;
  text.append(el('strong', 'model-current-name', name), el('code', 'model-current-id', currentModel));
  if (vendor && known?.name !== known?.id) text.prepend(el('span', 'model-current-vendor muted small', vendor));
  const pills = el('div', 'model-pills');
  if (known) pills.append(...modelPills(known, true));
  else if (modelsState === 'ok') pills.append(el('span', 'pill warn', t('aiModelUnknown')));
  box.replaceChildren(head);
  if (pills.childElementCount) box.append(pills);
  if (researchOn && known && known.created && !known.tools) {
    box.append(el('p', 'notice warn small', t('aiModelNoTools')));
  }
}

function setActive(index: number, scroll = true) {
  options[active]?.classList.remove('active');
  active = options.length ? Math.max(0, Math.min(index, options.length - 1)) : -1;
  const option = options[active];
  if (!option) {
    modelSearch.removeAttribute('aria-activedescendant');
    return;
  }
  option.classList.add('active');
  modelSearch.setAttribute('aria-activedescendant', option.id);
  if (scroll) option.scrollIntoView({ block: 'nearest' });
}

function optionFor(m: ModelInfo, index: number, custom = false): HTMLLIElement {
  const li = el('li', custom ? 'model-option custom' : 'model-option');
  li.id = `model-opt-${index}`;
  li.role = 'option';
  li.dataset.id = m.id;
  li.setAttribute('aria-selected', String(m.id === currentModel));
  const main = el('span', 'model-main');
  if (custom) {
    main.append(el('span', 'model-name', t('aiModelUseCustom', m.id)));
  } else {
    const [name, vendor] = splitName(m);
    main.append(el('span', 'model-name', name), el('span', 'model-id', m.id));
    if (vendor) main.title = `${vendor}: ${name}`;
  }
  const meta = el('span', 'model-meta');
  meta.append(...modelPills(m, false));
  li.append(el('span', 'model-mark'), main, meta);
  return li;
}

function renderModels() {
  renderCurrent();
  const query = modelSearch.value.trim();
  const pool = modelsState === 'ok' ? models : suggested();
  const found = searchModels(pool, query, modelFilter);
  const rows: HTMLLIElement[] = [];
  // Any ID from openrouter.ai/models can still be typed in.
  if (MODEL_ID.test(query) && !pool.some((m) => m.id === query)) {
    rows.push(optionFor({ id: query, name: query, context: 0, free: false, tools: true, created: 0 }, 0, true));
  }
  for (const m of found.slice(0, RENDER_MAX)) rows.push(optionFor(m, rows.length));
  options = rows;
  if (rows.length) modelList.replaceChildren(...rows);
  else modelList.replaceChildren(el('li', 'model-empty muted small', query ? t('aiModelsNone', query) : t('aiModelsNoneFilter')));

  const count = $('#ai-model-count');
  count.classList.toggle('warn-text', modelsState === 'failed');
  count.textContent =
    modelsState === 'loading'
      ? t('aiModelsLoading')
      : modelsState === 'offline'
        ? t('aiModelsOffline')
        : modelsState === 'failed'
          ? t('aiModelsFailed', modelsError)
          : found.length > RENDER_MAX
            ? t('aiModelsShown', RENDER_MAX, found.length)
            : tn('aiModelsCount', found.length);
  modelList.setAttribute('aria-busy', String(modelsState === 'loading'));

  // Without a search the chosen model is highlighted and scrolled into view.
  const selected = rows.findIndex((r) => r.dataset.id === currentModel);
  active = -1;
  if (query) setActive(0, false);
  else if (selected >= 0) {
    setActive(selected, false);
    const row = rows[selected]!;
    modelList.scrollTop = row.offsetTop - (modelList.clientHeight - row.offsetHeight) / 2;
  } else modelList.scrollTop = 0;
}

async function loadModels(refresh = false) {
  if (!(await browser.permissions.contains({ origins: [OPENROUTER_ORIGIN] }))) {
    modelsState = 'offline';
    renderModels();
    return;
  }
  if (!models.length) {
    modelsState = 'loading';
    renderModels();
  }
  try {
    models = await send({ type: 'aiListModels', refresh });
    modelsState = 'ok';
  } catch (err) {
    modelsError = err instanceof Error ? err.message : String(err);
    if (!models.length) modelsState = 'failed';
  }
  renderModels();
}

function chooseModel(id: string) {
  if (!MODEL_ID.test(id)) return;
  const changed = id !== currentModel;
  currentModel = id;
  for (const o of options) o.setAttribute('aria-selected', String(o.dataset.id === id));
  if (modelSearch.value.trim() === id) modelSearch.value = '';
  renderModels();
  if (!changed) return;
  const box = $('#ai-model-current');
  box.classList.remove('chosen');
  void box.offsetWidth;
  box.classList.add('chosen');
  void saveSetting('aiModel', id).catch(showError);
}

modelSearch.addEventListener('input', () => renderModels());
modelSearch.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    setActive(active < 0 ? 0 : active + (e.key === 'ArrowDown' ? 1 : -1));
  } else if (e.key === 'Home' && e.ctrlKey) {
    setActive(0);
  } else if (e.key === 'End' && e.ctrlKey) {
    setActive(options.length - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const id = options[active]?.dataset.id;
    if (id) chooseModel(id);
  } else if (e.key === 'Escape' && modelSearch.value) {
    e.preventDefault();
    modelSearch.value = '';
    renderModels();
  }
});
modelList.addEventListener('click', (e) => {
  const option = (e.target as HTMLElement).closest<HTMLLIElement>('.model-option');
  if (option?.dataset.id) chooseModel(option.dataset.id);
});
for (const chip of document.querySelectorAll<HTMLButtonElement>('.model-filters .chip')) {
  chip.addEventListener('click', () => {
    modelFilter = chip.dataset.filter as ModelFilter;
    for (const c of document.querySelectorAll('.model-filters .chip')) c.setAttribute('aria-pressed', String(c === chip));
    renderModels();
    modelSearch.focus();
  });
}
$('#ai-model-refresh').addEventListener('click', () =>
  withBusy($<HTMLButtonElement>('#ai-model-refresh'), () => loadModels(true), actionError),
);

// ---------- import ----------

const importMode = (): ImportMode =>
  ($<HTMLInputElement>('input[name="import-mode"]:checked').value as ImportMode) ?? 'merge';

function showImportResult(r: ImportResult) {
  const parts = [tn('importAdded', r.added)];
  if (r.duplicates) parts.push(tn('importDuplicates', r.duplicates));
  if (r.failed) parts.push(tn('importFailed', r.failed));
  const el = $('#import-result');
  el.textContent = parts.join(' ');
  el.hidden = false;
}

async function loadBrowsers() {
  const status = await statusItem.getValue();
  const tbody = $('#browsers tbody');
  tbody.replaceChildren();
  $('#browsers-offline').hidden = status.connected;
  $('#browsers').hidden = !status.connected;
  $('#browsers-empty').hidden = true;
  if (!status.connected) return;

  const browsers = await send({ type: 'listBrowsers' });
  $('#browsers-empty').hidden = browsers.some((b) => !b.self);
  for (const b of browsers) {
    const tr = document.createElement('tr');
    const cells = [
      b.self ? t('thisBrowser', b.label) : b.label,
      b.count.toLocaleString(),
      timeAgo(Date.parse(b.updatedAt)),
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    const actions = document.createElement('td');
    if (!b.self) {
      const imp = document.createElement('button');
      imp.textContent = t('import');
      imp.addEventListener('click', () =>
        withBusy(
          imp,
          async () => showImportResult(await send({ type: 'importFromBrowser', fileId: b.fileId, mode: importMode() })),
          actionError,
        ),
      );
      const remove = document.createElement('button');
      remove.textContent = t('remove');
      remove.className = 'danger';
      remove.title = t('removeBrowserHint');
      remove.addEventListener('click', () => {
        if (!confirm(t('confirmRemoveBrowser', b.label))) return;
        void withBusy(remove, () => send({ type: 'removeBrowser', fileId: b.fileId }).then(loadBrowsers), actionError);
      });
      actions.append(imp, ' ', remove);
    }
    tr.append(actions);
    tbody.append(tr);
  }
}

const fileInput = $<HTMLInputElement>('#import-file');
const fileButton = $<HTMLButtonElement>('#import-file-btn');
fileInput.addEventListener('change', () => (fileButton.disabled = !fileInput.files?.length));
fileButton.addEventListener('click', () =>
  withBusy(
    fileButton,
    async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const html = await file.text();
      showImportResult(await send({ type: 'importHtml', html, mode: importMode(), label: file.name }));
      fileInput.value = '';
    },
    actionError,
  ).then(() => (fileButton.disabled = !fileInput.files?.length)),
);

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- wiring ----------

const bind = (sel: string, action: () => Promise<unknown>) => {
  const btn = $<HTMLButtonElement>(sel);
  btn.addEventListener('click', () => withBusy(btn, action, actionError));
};

// The status watcher below reloads the account's lists after connect/disconnect.
bind('#connect', () => send({ type: 'connect' }));
bind('#disconnect', async () => {
  if (!confirm(t('confirmDisconnect'))) return;
  await send({ type: 'disconnect' });
});
bind('#backup-now', async () => {
  await send({ type: 'backupNow' });
  await loadBackups();
});
bind('#export', async () => {
  const html = await send({ type: 'exportHtml' });
  download(`bookmarks-${new Date().toISOString().slice(0, 10)}.html`, html, 'text/html');
});

let wasConnected: boolean | undefined;
void statusItem.getValue().then((s) => {
  wasConnected = s.connected;
  renderStatus(s);
});
statusItem.watch((s) => {
  if (!s) return;
  renderStatus(s);
  // Connected or disconnected elsewhere (e.g. from the popup): the backup
  // and browser lists belong to the account, so load them again.
  if (wasConnected !== undefined && s.connected !== wasConnected) {
    void Promise.all([loadBackups(), loadBrowsers(), loadEncryption()]).catch(showError);
  }
  wasConnected = s.connected;
});
void loadSettings();
void initAi().catch((err: unknown) => showError(err));
void loadEncryption().catch((err: unknown) => showError(err));
// Development builds only: the OAuth redirect URI to register in Google Cloud.
// The block is removed from store builds (`wxt build`, `wxt zip`).
if (import.meta.env.MODE !== 'production') {
  void send({ type: 'getRedirectUrl' }).then((url) => {
    const box = document.createElement('section');
    box.className = 'notice stack small';
    const title = document.createElement('strong');
    title.textContent = 'Developer: OAuth redirect URI for this browser';
    const code = document.createElement('code');
    code.textContent = url;
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'Add it under Authorized redirect URIs of the Web application client (docs/GOOGLE_SETUP.md). Not shown in store builds.';
    box.append(title, code, hint);
    $('main').append(box);
  });
}
const showError = (err: unknown) => showToast(actionError, err instanceof Error ? err.message : String(err));
void loadBackups().catch(showError);
void loadBrowsers().catch(showError);
initRail();
if (location.hash === '#import') $('#import').scrollIntoView();
if (location.hash === '#ai') $('#ai').scrollIntoView();
// The emblem and status line also show whether sync is off in this browser.
const refreshSyncEnabled = async () => {
  syncEnabled = (await getSettings()).syncEnabled;
  renderStatus(lastStatus);
};
void refreshSyncEnabled();
settingsItem.watch(() => void refreshSyncEnabled());

// ---------- bulk sorting ----------

/** Proposals at or above this confidence start out ticked. */
const BULK_AUTO_SELECT = 0.6;
let bulkJobId = '';
const bulkChosen = new Set<string>();
/** Proposals already shown once, so a later untick is not undone by the next update. */
const bulkSeen = new Set<string>();

const movable = (p: BulkProposal) => (p.status === 'moved' || p.status === 'created') && !p.appliedAt;

/** "Bookmarks bar / Work / Docs" → "… / Work / Docs". */
function shortPath(path: string): string {
  const parts = path.split(' / ');
  return parts.length > 2 ? `… / ${parts.slice(-2).join(' / ')}` : path;
}

function bulkRow(p: BulkProposal, job: BulkJob): HTMLLIElement {
  const li = el('li', 'bulk-row');
  const kind = p.appliedAt
    ? 'applied'
    : p.applyError
      ? 'failed'
      : p.status === 'created'
        ? 'create'
        : p.status === 'moved'
          ? 'move'
          : p.status === 'kept'
            ? 'keep'
            : 'error';
  li.dataset.kind = kind;

  const tick = document.createElement('input');
  tick.type = 'checkbox';
  tick.className = 'tick';
  tick.dataset.id = p.bookmarkId;
  tick.checked = bulkChosen.has(p.bookmarkId);
  tick.disabled = !movable(p) || job.state !== 'ready';
  // Rows without a move keep the column, so everything lines up.
  if (!movable(p)) tick.style.visibility = 'hidden';
  tick.setAttribute('aria-label', p.title);

  const main = el('div', 'bulk-main');
  main.append(el('span', 'bulk-title', p.title || p.url || ''));
  let host = '';
  try {
    host = new URL(p.url ?? '').hostname.replace(/^www\./, '');
  } catch {
    // Not an address: show the title only.
  }
  const sub = el('span', 'bulk-sub', [host, p.applyError ?? (p.status === 'error' ? p.error : p.reason)].filter(Boolean).join(' · '));
  if (p.reason) sub.title = p.reason;
  main.append(sub);

  const target = el('div', 'bulk-target');
  if (kind === 'keep') target.append(el('span', 'muted small', t('aiBulkKeep')));
  else if (kind === 'error' || kind === 'failed') target.append(el('span', 'pill warn', t('aiStatusError')));
  else {
    target.append(el('span', 'bulk-arrow', '→'));
    const path = el('span', 'bulk-path', shortPath(p.toPath ?? ''));
    path.title = p.toPath ?? '';
    target.append(path);
    if (p.newFolder) target.append(el('span', 'pill free', t('aiBulkNewFolder')));
    if (kind === 'applied') target.append(el('span', 'pill done', '✓'));
    else if (p.confidence !== undefined) target.append(el('span', 'pill', t('aiConfidence', Math.round(p.confidence * 100))));
  }
  li.append(tick, main, target);
  return li;
}

function renderBulk(job: BulkJob | undefined) {
  const run = $('#bulk-run');
  const start = $<HTMLButtonElement>('#bulk-start');
  run.hidden = !job;
  start.disabled = !!job && job.state !== 'done';
  start.title = start.disabled ? t('aiBulkBusy') : '';
  if (!job) {
    bulkJobId = '';
    return;
  }
  if (job.id !== bulkJobId) {
    bulkJobId = job.id;
    bulkChosen.clear();
    bulkSeen.clear();
  }
  for (const p of job.proposals) {
    if (bulkSeen.has(p.bookmarkId)) continue;
    bulkSeen.add(p.bookmarkId);
    if (movable(p) && (p.confidence ?? 0) >= BULK_AUTO_SELECT) bulkChosen.add(p.bookmarkId);
  }
  for (const id of [...bulkChosen]) {
    const p = job.proposals.find((x) => x.bookmarkId === id);
    if (!p || !movable(p)) bulkChosen.delete(id);
  }

  const done = job.total - job.queue.length;
  const moves = job.proposals.filter((p) => p.status === 'moved' || p.status === 'created').length;
  const keeps = job.proposals.filter((p) => p.status === 'kept').length;
  const errors = job.proposals.filter((p) => p.status === 'error').length;
  const planning = job.state === 'planning';

  $('#bulk-title').textContent = t(
    planning ? 'aiBulkPlanningTitle' : job.state === 'done' ? 'aiBulkDoneTitle' : 'aiBulkReadyTitle',
    job.folderPath,
  );
  $('#bulk-meta').textContent = planning
    ? t('aiBulkProgress', done, job.total)
    : t('aiBulkSummary', moves, keeps, errors);
  $('#bulk-cost').textContent = formatUsd(job.cost);
  $('#bulk-cost').title = t('aiBulkCostHint');
  const gauge = $('#bulk-gauge');
  gauge.hidden = !planning;
  const pct = job.total ? Math.round((done / job.total) * 100) : 0;
  gauge.setAttribute('aria-valuenow', String(pct));
  gauge.querySelector<HTMLElement>('span')!.style.width = `${pct}%`;

  const note = $('#bulk-note');
  const noteText =
    job.state === 'done' && job.applied
      ? t('aiBulkDone', job.applied.moved, job.applied.failed)
      : job.stopped === 'budget'
        ? t('aiErrBudget')
        : job.stopped === 'error'
          ? t('aiBulkStoppedError', job.stopMessage ?? '')
          : job.stopped === 'cancelled'
            ? t('aiBulkStoppedCancel', done, job.total)
            : '';
  note.hidden = !noteText;
  note.textContent = noteText;
  note.className = `notice small ${job.state === 'done' ? 'ok' : job.stopped === 'cancelled' ? '' : 'warn'}`;

  const list = $('#bulk-list');
  const rows = job.proposals.map((p) => bulkRow(p, job));
  if (planning) {
    const waiting = el('li', 'bulk-row waiting');
    waiting.append(el('span', 'bulk-spinner'), el('span', 'muted small', t('aiBulkWaiting', job.queue.length)));
    rows.push(waiting);
  }
  list.replaceChildren(...rows);

  const candidates = job.proposals.filter(movable);
  $('#bulk-toolbar').hidden = !candidates.length || job.state === 'done';
  const all = $<HTMLInputElement>('#bulk-all');
  all.checked = candidates.length > 0 && candidates.every((p) => bulkChosen.has(p.bookmarkId));
  all.indeterminate = !all.checked && candidates.some((p) => bulkChosen.has(p.bookmarkId));
  all.disabled = job.state !== 'ready';
  $('#bulk-selected').textContent = t('aiBulkSelected', bulkChosen.size, candidates.length);

  const apply = $<HTMLButtonElement>('#bulk-apply');
  apply.hidden = job.state === 'done';
  apply.textContent = tn('aiBulkApply', bulkChosen.size);
  apply.disabled = job.state !== 'ready' || bulkChosen.size === 0;
  $('#bulk-stop').hidden = !planning;
  const discard = $<HTMLButtonElement>('#bulk-discard');
  discard.hidden = planning || job.state === 'applying';
  discard.textContent = t(job.state === 'done' ? 'aiBulkClose' : 'aiBulkDiscard');
  $('#bulk-log').hidden = job.state !== 'done';
}

aiBulkItem.watch((job) => renderBulk(job ?? undefined));

$('#bulk-list').addEventListener('change', (e) => {
  const tick = e.target as HTMLInputElement;
  if (!tick.classList.contains('tick') || !tick.dataset.id) return;
  if (tick.checked) bulkChosen.add(tick.dataset.id);
  else bulkChosen.delete(tick.dataset.id);
  void aiBulkItem.getValue().then((j) => renderBulk(j ?? undefined));
});
$('#bulk-all').addEventListener('change', async () => {
  const job = await aiBulkItem.getValue();
  if (!job) return;
  const on = $<HTMLInputElement>('#bulk-all').checked;
  for (const p of job.proposals.filter(movable)) {
    if (on) bulkChosen.add(p.bookmarkId);
    else bulkChosen.delete(p.bookmarkId);
  }
  renderBulk(job);
});
$('#bulk-start').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#bulk-start'),
    async () => {
      const folderId = $<HTMLSelectElement>('#bulk-folder').value;
      if (!folderId) throw new Error(t('aiBulkChooseFolder'));
      await send({ type: 'aiBulkStart', folderId, research: $<HTMLInputElement>('#bulk-research').checked });
      $('#bulk-run').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    actionError,
  ),
);
$('#bulk-stop').addEventListener('click', () =>
  withBusy($<HTMLButtonElement>('#bulk-stop'), () => send({ type: 'aiBulkCancel' }), actionError),
);
$('#bulk-apply').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#bulk-apply'),
    async () => {
      if (!bulkChosen.size) return;
      await send({ type: 'aiBulkApply', bookmarkIds: [...bulkChosen] });
    },
    actionError,
  ),
);
$('#bulk-discard').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#bulk-discard'),
    async () => {
      const job = await aiBulkItem.getValue();
      const pending = job?.proposals.filter(movable).length ?? 0;
      if (job?.state !== 'done' && pending && !confirm(t('aiBulkConfirmDiscard'))) return;
      await send({ type: 'aiBulkDiscard' });
    },
    actionError,
  ),
);

// ---------- tidy up the library ----------

const tidyScope = $<HTMLSelectElement>('#tidy-scope');
let tidyJobId = '';
const tidyChosen = new Set<string>();
const tidySeen = new Set<string>();
type TidyItem = TidyJob['proposals'][number];
const tidyOpen = (p: TidyItem) => !p.appliedAt;
const TIDY_GROUPS: TidyItem['kind'][] = ['merge', 'rename', 'remove', 'retitle'];
const tidyGroupKey: Record<TidyItem['kind'], string> = {
  merge: 'tidyGroupMerge',
  rename: 'tidyGroupRename',
  remove: 'tidyGroupRemove',
  retitle: 'tidyGroupRetitle',
};

/** The scope picker: the whole library or one folder. */
function fillTidyScopes() {
  const keep = tidyScope.value;
  tidyScope.replaceChildren(
    Object.assign(document.createElement('option'), { value: '', textContent: t('tidyScopeAll') }),
    ...aiFolders.map((f) => Object.assign(document.createElement('option'), { value: f.id, textContent: f.path })),
  );
  tidyScope.value = aiFolders.some((f) => f.id === keep) ? keep : '';
}

function estimateText(e: TidyEstimate): string {
  const size = t('tidyEstimateSize', e.folders, e.bookmarks);
  if (e.provider !== 'openrouter') return `${size} ${tn('tidyEstimateFree', e.requests)}`;
  if (e.usd === undefined) return `${size} ${tn('tidyEstimateUnknown', e.requests)}`;
  return `${size} ${tn('tidyEstimateCost', e.requests, formatUsd(e.usd))}`;
}

let estimateRun = 0;
async function renderTidyEstimate(): Promise<TidyEstimate | undefined> {
  const run = ++estimateRun;
  const box = $('#tidy-estimate');
  try {
    const e = await send({ type: 'aiTidyEstimate', scopeId: tidyScope.value });
    if (run === estimateRun) {
      box.textContent = estimateText(e);
      box.classList.remove('warn-text');
    }
    return e;
  } catch (err) {
    if (run === estimateRun) {
      box.textContent = err instanceof Error ? err.message : String(err);
      box.classList.add('warn-text');
    }
    return undefined;
  }
}

function tidyRow(p: TidyItem, job: TidyJob): HTMLLIElement {
  const li = el('li', 'bulk-row');
  li.dataset.kind = p.appliedAt ? 'applied' : p.applyError ? 'failed' : 'move';
  const tick = document.createElement('input');
  tick.type = 'checkbox';
  tick.className = 'tick';
  tick.dataset.id = p.id;
  tick.checked = tidyChosen.has(p.id);
  tick.disabled = !tidyOpen(p) || job.state !== 'ready';
  if (!tidyOpen(p)) tick.style.visibility = 'hidden';

  const main = el('div', 'bulk-main');
  const target = el('div', 'bulk-target');
  const arrow = (text: string, full = text) => {
    const path = el('span', 'bulk-path', text);
    path.title = full;
    target.append(el('span', 'bulk-arrow', '→'), path);
  };
  if (p.kind === 'retitle') {
    main.append(el('span', 'bulk-title was', p.title || p.url || ''), el('span', 'bulk-sub', shortPath(p.folderPath)));
    arrow(p.newTitle);
    tick.setAttribute('aria-label', t('tidyAriaRetitle', p.title, p.newTitle));
  } else {
    main.append(el('span', 'bulk-title', shortPath(p.folderPath)));
    main.lastElementChild!.setAttribute('title', p.folderPath);
    const sub = [p.applyError, 'reason' in p ? p.reason : undefined].filter(Boolean).join(' · ');
    if (sub) main.append(el('span', 'bulk-sub', sub));
    if (p.kind === 'merge') {
      arrow(shortPath(p.intoPath), p.intoPath);
      target.append(el('span', 'pill', tn('tidyItems', p.count)));
      tick.setAttribute('aria-label', t('tidyAriaMerge', p.folderPath, p.intoPath));
    } else if (p.kind === 'rename') {
      arrow(p.name);
      tick.setAttribute('aria-label', t('tidyAriaRename', p.folderPath, p.name));
    } else {
      target.append(el('span', 'pill', t('tidyEmpty')));
      tick.setAttribute('aria-label', t('tidyAriaRemove', p.folderPath));
    }
  }
  if (p.appliedAt) target.append(el('span', 'pill done', '✓'));
  else if (p.applyError) target.append(el('span', 'pill warn', t('aiStatusError')));
  li.append(tick, main, target);
  return li;
}

function renderTidy(job: TidyJob | undefined) {
  const run = $('#tidy-run');
  const start = $<HTMLButtonElement>('#tidy-start');
  run.hidden = !job;
  start.disabled = !!job && job.state !== 'done';
  start.title = start.disabled ? t('aiBulkBusy') : '';
  if (!job) {
    tidyJobId = '';
    return;
  }
  if (job.id !== tidyJobId) {
    tidyJobId = job.id;
    tidyChosen.clear();
    tidySeen.clear();
  }
  // Everything starts ticked: the list is the review.
  for (const p of job.proposals) {
    if (tidySeen.has(p.id)) continue;
    tidySeen.add(p.id);
    if (tidyOpen(p)) tidyChosen.add(p.id);
  }
  for (const id of [...tidyChosen]) {
    const p = job.proposals.find((x) => x.id === id);
    if (!p || !tidyOpen(p)) tidyChosen.delete(id);
  }
  const planning = job.state === 'planning';
  const scope = job.scopePath || t('tidyScopeAll');
  $('#tidy-title').textContent = t(planning ? 'tidyPlanningTitle' : job.state === 'done' ? 'tidyDoneTitle' : 'tidyReadyTitle', scope);
  $('#tidy-meta').textContent = planning ? t('tidyProgress', job.step, job.steps) : tn('tidyFound', job.proposals.length);
  $('#tidy-cost').textContent = job.provider === 'openrouter' ? formatUsd(job.cost) : t('tidyFree');
  const gauge = $('#tidy-gauge');
  gauge.hidden = !planning;
  const pct = job.steps ? Math.round((job.step / job.steps) * 100) : 0;
  gauge.setAttribute('aria-valuenow', String(pct));
  gauge.querySelector<HTMLElement>('span')!.style.width = `${pct}%`;

  const note = $('#tidy-note');
  const noteText =
    job.state === 'done' && job.applied
      ? [t('tidyApplied', job.applied.done, job.applied.failed), job.applied.backedUp ? t('dupDoneBackup') : ''].filter(Boolean).join(' ')
      : job.stopped === 'budget'
        ? t('aiErrBudget')
        : job.stopped === 'error'
          ? t('aiBulkStoppedError', job.stopMessage ?? '')
          : job.stopped === 'interrupted'
            ? t('tidyInterrupted')
            : job.stopped === 'cancelled'
              ? t('tidyCancelled')
              : job.state === 'ready' && !job.proposals.length
                ? t('tidyNothing')
                : job.failures
                  ? tn('tidyFailures', job.failures)
                  : '';
  note.hidden = !noteText;
  note.textContent = noteText;
  note.className = `notice small ${job.state === 'done' ? 'ok' : job.stopped === 'cancelled' || !job.stopped ? '' : 'warn'}`;

  const rows: HTMLLIElement[] = [];
  for (const kind of TIDY_GROUPS) {
    const list = job.proposals.filter((p) => p.kind === kind);
    if (!list.length) continue;
    const head = el('li', 'tidy-group');
    head.append(el('span', '', `${t(tidyGroupKey[kind])} · ${list.length.toLocaleString()}`));
    const open = list.filter(tidyOpen);
    if (open.length > 1 && job.state === 'ready') {
      const all = open.every((p) => tidyChosen.has(p.id));
      const toggle = el('button', 'quiet small-button', t(all ? 'tidyGroupNone' : 'tidyGroupAll'));
      toggle.type = 'button';
      toggle.dataset.group = kind;
      head.append(toggle);
    }
    rows.push(head, ...list.map((p) => tidyRow(p, job)));
  }
  if (planning) {
    const waiting = el('li', 'bulk-row waiting');
    waiting.append(el('span', 'bulk-spinner'), el('span', 'muted small', t('tidyWaiting')));
    rows.push(waiting);
  }
  $('#tidy-list').replaceChildren(...rows);

  const apply = $<HTMLButtonElement>('#tidy-apply');
  apply.hidden = job.state === 'done';
  apply.textContent = tn('tidyApply', tidyChosen.size);
  apply.disabled = job.state !== 'ready' || tidyChosen.size === 0;
  $('#tidy-stop').hidden = !planning;
  const discard = $<HTMLButtonElement>('#tidy-discard');
  discard.hidden = planning || job.state === 'applying';
  discard.textContent = t(job.state === 'done' ? 'aiBulkClose' : 'aiBulkDiscard');
  $('#tidy-log').hidden = job.state !== 'done';
}

aiTidyItem.watch((job) => renderTidy(job ?? undefined));
tidyScope.addEventListener('change', () => void renderTidyEstimate());
$('#tidy-list').addEventListener('change', (e) => {
  const tick = e.target as HTMLInputElement;
  if (!tick.classList.contains('tick') || !tick.dataset.id) return;
  if (tick.checked) tidyChosen.add(tick.dataset.id);
  else tidyChosen.delete(tick.dataset.id);
  void aiTidyItem.getValue().then((j) => renderTidy(j ?? undefined));
});
$('#tidy-list').addEventListener('click', async (e) => {
  const kind = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-group]')?.dataset.group;
  if (!kind) return;
  const job = await aiTidyItem.getValue();
  if (!job) return;
  const open = job.proposals.filter((p) => p.kind === kind && tidyOpen(p));
  const all = open.every((p) => tidyChosen.has(p.id));
  for (const p of open) {
    if (all) tidyChosen.delete(p.id);
    else tidyChosen.add(p.id);
  }
  renderTidy(job);
});
$('#tidy-start').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#tidy-start'),
    async () => {
      const estimate = await renderTidyEstimate();
      if (!estimate) throw new Error($('#tidy-estimate').textContent ?? t('aiNotReady'));
      if (!confirm(t('tidyConfirmStart', estimateText(estimate)))) return;
      await send({ type: 'aiTidyStart', scopeId: tidyScope.value });
      $('#tidy-run').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    actionError,
  ),
);
$('#tidy-stop').addEventListener('click', () => withBusy($<HTMLButtonElement>('#tidy-stop'), () => send({ type: 'aiTidyCancel' }), actionError));
$('#tidy-apply').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#tidy-apply'),
    async () => {
      if (!tidyChosen.size) return;
      const connected = (await statusItem.getValue()).connected;
      if (!confirm(t(connected ? 'tidyConfirmApply' : 'tidyConfirmApplyNoBackup', tidyChosen.size))) return;
      await send({ type: 'aiTidyApply', ids: [...tidyChosen] });
    },
    actionError,
  ),
);
$('#tidy-discard').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#tidy-discard'),
    async () => {
      const job = await aiTidyItem.getValue();
      if (job?.state !== 'done' && job?.proposals.some(tidyOpen) && !confirm(t('aiBulkConfirmDiscard'))) return;
      await send({ type: 'aiTidyDiscard' });
    },
    actionError,
  ),
);

// ---------- name bookmarks with AI ----------

const namingChosenFolders = new Set<string>();
const namingChosen = new Set<string>();
const namingSeen = new Set<string>();
let namingJobId = '';

function namingOptions() {
  return {
    folderIds: [...namingChosenFolders],
    subfolders: $<HTMLInputElement>('#naming-sub').checked,
    research: $<HTMLInputElement>('#naming-research').checked,
    uiLanguage: $<HTMLInputElement>('#naming-ui-lang').checked,
  };
}

/** The folder picker: every folder with a tick box, filtered by the search above it. */
function fillNamingFolders() {
  const q = $<HTMLInputElement>('#naming-filter').value.trim().toLocaleLowerCase();
  for (const id of [...namingChosenFolders]) if (!aiFolders.some((f) => f.id === id)) namingChosenFolders.delete(id);
  const shown = aiFolders.filter((f) => !q || f.path.toLocaleLowerCase().includes(q)).slice(0, 400);
  $('#naming-folders').replaceChildren(
    ...shown.map((f) => {
      const li = document.createElement('li');
      const label = el('label', 'tick-label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'tick';
      box.dataset.id = f.id;
      box.checked = namingChosenFolders.has(f.id);
      label.append(box, el('span', 'small', f.path));
      li.append(label);
      return li;
    }),
  );
}

let namingEstimateRun = 0;
let namingEstimateTimer: ReturnType<typeof setTimeout> | undefined;
async function renderNamingEstimate(): Promise<NamingEstimate | undefined> {
  const run = ++namingEstimateRun;
  const box = $('#naming-estimate');
  if (!namingChosenFolders.size) {
    box.textContent = t('namingChooseFolder');
    box.classList.remove('warn-text');
    return undefined;
  }
  try {
    const e = await send({ type: 'aiNamingEstimate', options: namingOptions() });
    if (run === namingEstimateRun) {
      box.textContent = namingEstimateText(e);
      box.classList.remove('warn-text');
    }
    return e;
  } catch (err) {
    if (run === namingEstimateRun) {
      box.textContent = err instanceof Error ? err.message : String(err);
      box.classList.add('warn-text');
    }
    return undefined;
  }
}
const scheduleNamingEstimate = () => {
  clearTimeout(namingEstimateTimer);
  namingEstimateTimer = setTimeout(() => void renderNamingEstimate(), 300);
};

function namingEstimateText(e: NamingEstimate): string {
  const size = tn('namingEstimateSize', e.bookmarks) + (e.research ? ` ${t('namingEstimateResearch')}` : '');
  if (e.provider !== 'openrouter') return `${size} ${tn('tidyEstimateFree', e.requests)}`;
  if (e.usd === undefined) return `${size} ${tn('tidyEstimateUnknown', e.requests)}`;
  return `${size} ${tn('tidyEstimateCost', e.requests, formatUsd(e.usd))}`;
}

const namingOpen = (p: TidyItem) => p.kind === 'retitle' && !p.appliedAt;

function namingRow(p: TidyItem, job: TidyJob): HTMLLIElement {
  const li = el('li', 'bulk-row');
  li.dataset.kind = p.appliedAt ? 'applied' : p.applyError ? 'failed' : 'move';
  if (p.kind !== 'retitle') return li;
  const tick = document.createElement('input');
  tick.type = 'checkbox';
  tick.className = 'tick';
  tick.dataset.id = p.id;
  tick.checked = namingChosen.has(p.id);
  tick.disabled = !namingOpen(p) || job.state !== 'ready';
  tick.setAttribute('aria-label', t('tidyAriaRetitle', p.title, p.newTitle));
  if (!namingOpen(p)) tick.style.visibility = 'hidden';
  const main = el('div', 'bulk-main');
  main.append(el('span', 'bulk-title was', p.title || p.url || ''));
  let host = '';
  try {
    host = new URL(p.url ?? '').hostname.replace(/^www\./, '');
  } catch {
    // Not an address: the folder is enough.
  }
  main.append(el('span', 'bulk-sub', [host, shortPath(p.folderPath), p.applyError].filter(Boolean).join(' · ')));
  const target = el('div', 'bulk-target');
  if (namingOpen(p) && job.state === 'ready') {
    const input = document.createElement('input');
    input.className = 'naming-input';
    input.value = p.newTitle;
    input.maxLength = 120;
    input.dataset.id = p.id;
    input.setAttribute('aria-label', t('namingEditLabel', p.title));
    target.append(input);
  } else {
    target.append(el('span', 'bulk-arrow', '→'), el('span', 'bulk-path', p.newTitle));
    if (p.appliedAt) target.append(el('span', 'pill done', '✓'));
    else if (p.applyError) target.append(el('span', 'pill warn', t('aiStatusError')));
  }
  li.append(tick, main, target);
  return li;
}

function renderNaming(job: TidyJob | undefined) {
  const run = $('#naming-run');
  const start = $<HTMLButtonElement>('#naming-start');
  run.hidden = !job;
  start.disabled = !!job && job.state !== 'done';
  start.title = start.disabled ? t('aiBulkBusy') : '';
  if (!job) {
    namingJobId = '';
    return;
  }
  if (job.id !== namingJobId) {
    namingJobId = job.id;
    namingChosen.clear();
    namingSeen.clear();
  }
  for (const p of job.proposals) {
    if (namingSeen.has(p.id)) continue;
    namingSeen.add(p.id);
    if (namingOpen(p)) namingChosen.add(p.id);
  }
  for (const id of [...namingChosen]) {
    const p = job.proposals.find((x) => x.id === id);
    if (!p || !namingOpen(p)) namingChosen.delete(id);
  }
  const planning = job.state === 'planning';
  $('#naming-title').textContent = t(planning ? 'namingPlanningTitle' : job.state === 'done' ? 'namingDoneTitle' : 'namingReadyTitle', job.scopePath);
  $('#naming-meta').textContent = planning ? t('tidyProgress', job.step, job.steps) : tn('namingFound', job.proposals.length);
  $('#naming-cost').textContent = job.provider === 'openrouter' ? formatUsd(job.cost) : t('tidyFree');
  const gauge = $('#naming-gauge');
  gauge.hidden = !planning;
  const pct = job.steps ? Math.round((job.step / job.steps) * 100) : 0;
  gauge.setAttribute('aria-valuenow', String(pct));
  gauge.querySelector<HTMLElement>('span')!.style.width = `${pct}%`;
  const note = $('#naming-note');
  const noteText =
    job.state === 'done' && job.applied
      ? [t('tidyApplied', job.applied.done, job.applied.failed), job.applied.backedUp ? t('dupDoneBackup') : ''].filter(Boolean).join(' ')
      : job.stopped === 'budget'
        ? t('aiErrBudget')
        : job.stopped === 'error'
          ? t('aiBulkStoppedError', job.stopMessage ?? '')
          : job.stopped === 'interrupted'
            ? t('tidyInterrupted')
            : job.stopped === 'cancelled'
              ? t('tidyCancelled')
              : job.state === 'ready' && !job.proposals.length
                ? t('namingNothing')
                : job.failures
                  ? tn('tidyFailures', job.failures)
                  : '';
  note.hidden = !noteText;
  note.textContent = noteText;
  note.className = `notice small ${job.state === 'done' ? 'ok' : job.stopped === 'cancelled' || !job.stopped ? '' : 'warn'}`;
  // Keep what the user is typing: redraw only rows that are not being edited.
  const editing = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('naming-input') ? document.activeElement : null;
  const rows = job.proposals.map((p) => (editing && editing.dataset.id === p.id ? editing.closest<HTMLLIElement>('li')! : namingRow(p, job)));
  if (planning) {
    const waiting = el('li', 'bulk-row waiting');
    waiting.append(el('span', 'bulk-spinner'), el('span', 'muted small', t(job.research ? 'namingWaitingResearch' : 'namingWaiting')));
    rows.push(waiting);
  }
  $('#naming-list').replaceChildren(...rows);
  if (editing) editing.focus();
  const open = job.proposals.filter(namingOpen);
  $('#naming-toolbar').hidden = !open.length || job.state !== 'ready';
  const all = $<HTMLInputElement>('#naming-all');
  all.checked = open.length > 0 && open.every((p) => namingChosen.has(p.id));
  all.indeterminate = !all.checked && open.some((p) => namingChosen.has(p.id));
  const apply = $<HTMLButtonElement>('#naming-apply');
  apply.hidden = job.state === 'done';
  apply.textContent = tn('namingApply', namingChosen.size);
  apply.disabled = job.state !== 'ready' || namingChosen.size === 0;
  $('#naming-stop').hidden = !planning;
  const discard = $<HTMLButtonElement>('#naming-discard');
  discard.hidden = planning || job.state === 'applying';
  discard.textContent = t(job.state === 'done' ? 'aiBulkClose' : 'aiBulkDiscard');
  $('#naming-log').hidden = job.state !== 'done';
}

aiNamingItem.watch((job) => renderNaming(job ?? undefined));
$('#naming-filter').addEventListener('input', fillNamingFolders);
$('#naming-folders').addEventListener('change', (e) => {
  const box = e.target as HTMLInputElement;
  if (!box.dataset.id) return;
  if (box.checked) namingChosenFolders.add(box.dataset.id);
  else namingChosenFolders.delete(box.dataset.id);
  scheduleNamingEstimate();
});
for (const id of ['#naming-sub', '#naming-research', '#naming-ui-lang']) $(id).addEventListener('change', scheduleNamingEstimate);
$('#naming-list').addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement;
  if (!target.dataset.id) return;
  if (target.classList.contains('tick')) {
    if (target.checked) namingChosen.add(target.dataset.id);
    else namingChosen.delete(target.dataset.id);
    void aiNamingItem.getValue().then((j) => renderNaming(j ?? undefined));
    return;
  }
  if (target.classList.contains('naming-input')) {
    // Saved with the run, so closing Settings keeps the edit.
    void send({ type: 'aiNamingEdit', id: target.dataset.id, title: target.value })
      .then((saved) => (target.value = saved))
      .catch(showError);
  }
});
$('#naming-list').addEventListener('keydown', (e) => {
  const target = e.target as HTMLInputElement;
  if (e.key === 'Enter' && target.classList.contains('naming-input')) target.blur();
});
$('#naming-all').addEventListener('change', async () => {
  const job = await aiNamingItem.getValue();
  if (!job) return;
  const on = $<HTMLInputElement>('#naming-all').checked;
  for (const p of job.proposals.filter(namingOpen)) {
    if (on) namingChosen.add(p.id);
    else namingChosen.delete(p.id);
  }
  renderNaming(job);
});
$('#naming-start').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#naming-start'),
    async () => {
      if (!namingChosenFolders.size) throw new Error(t('namingChooseFolder'));
      const estimate = await renderNamingEstimate();
      if (!estimate) throw new Error($('#naming-estimate').textContent ?? t('aiNotReady'));
      if (!confirm(t('namingConfirmStart', namingEstimateText(estimate)))) return;
      await send({ type: 'aiNamingStart', options: namingOptions() });
      $('#naming-run').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    actionError,
  ),
);
$('#naming-stop').addEventListener('click', () => withBusy($<HTMLButtonElement>('#naming-stop'), () => send({ type: 'aiNamingCancel' }), actionError));
$('#naming-apply').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#naming-apply'),
    async () => {
      if (!namingChosen.size) return;
      // An edit still in the box is saved first.
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && active.classList.contains('naming-input') && active.dataset.id) {
        await send({ type: 'aiNamingEdit', id: active.dataset.id, title: active.value });
      }
      const connected = (await statusItem.getValue()).connected;
      if (!confirm(t(connected ? 'namingConfirmApply' : 'namingConfirmApplyNoBackup', namingChosen.size))) return;
      await send({ type: 'aiNamingApply', ids: [...namingChosen] });
    },
    actionError,
  ),
);
$('#naming-discard').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#naming-discard'),
    async () => {
      const job = await aiNamingItem.getValue();
      if (job?.state !== 'done' && job?.proposals.some(namingOpen) && !confirm(t('aiBulkConfirmDiscard'))) return;
      await send({ type: 'aiNamingDiscard' });
    },
    actionError,
  ),
);

// ---------- search by meaning ----------

const semModel = $<HTMLInputElement>('#sem-model');
let semRun = 0;

async function renderSemantic() {
  const run = ++semRun;
  const [s, status] = await Promise.all([getSettings(), send({ type: 'semStatus' }).catch((err: unknown) => err as Error)]);
  if (run !== semRun) return;
  semModel.placeholder = s.aiProvider === 'openrouter' ? DEFAULT_EMBEDDING_MODEL : 'nomic-embed-text';
  if (document.activeElement !== semModel) semModel.value = s.semanticModel;
  $('#sem-model-help').textContent = t(s.aiProvider === 'openrouter' ? 'semModelHelpOpenRouter' : 'semModelHelpCustom', DEFAULT_EMBEDDING_MODEL);
  const box = $('#sem-status');
  const build = $<HTMLButtonElement>('#sem-build');
  if (status instanceof Error) {
    box.textContent = status.message;
    box.className = 'small warn-text';
    build.textContent = t('semBuild');
    build.disabled = true;
    return;
  }
  const job = status.job;
  const indexing = job?.state === 'indexing';
  const parts = [status.model ? t('semIndexed', status.indexed, status.total, status.model) : ''];
  if (status.problem) parts.push(status.problem);
  else if (status.pending && !indexing) {
    parts.push(
      status.usd === undefined
        ? tn('semPendingTokens', status.pending, status.tokens.toLocaleString())
        : status.usd === 0
          ? tn('semPendingFree', status.pending)
          : tn('semPendingCost', status.pending, formatUsd(status.usd)),
    );
  }
  if (indexing) parts.push(t('semProgress', job.done, job.total));
  else if (job?.error) parts.push(job.error);
  box.textContent = parts.filter(Boolean).join(' ');
  box.className = `small ${status.problem || job?.error ? 'warn-text' : 'muted'}`;
  const gauge = $('#sem-gauge');
  gauge.hidden = !indexing;
  const pct = job?.total ? Math.round((job.done / job.total) * 100) : 0;
  gauge.setAttribute('aria-valuenow', String(pct));
  gauge.querySelector<HTMLElement>('span')!.style.width = `${pct}%`;
  build.textContent = status.indexed ? tn('semUpdate', status.pending) : t('semBuild');
  build.disabled = !status.enabled || !!status.problem || !status.pending || indexing;
  $('#sem-stop').hidden = !indexing;
  $<HTMLButtonElement>('#sem-delete').disabled = !status.indexed || indexing;
}

semanticJobItem.watch(() => void renderSemantic());
$('#sem-model-save').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#sem-model-save'),
    async () => {
      const model = semModel.value.trim();
      if (model && !ENDPOINT_MODEL.test(model)) throw new Error(t('aiEndpointModelInvalid'));
      await saveSetting('semanticModel', model);
      await renderSemantic();
    },
    actionError,
  ),
);
$('#sem-build').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#sem-build'),
    async () => {
      const status = await send({ type: 'semStatus' });
      const cost =
        status.usd === undefined ? tn('semPendingTokens', status.pending, status.tokens.toLocaleString()) : status.usd === 0 ? tn('semPendingFree', status.pending) : tn('semPendingCost', status.pending, formatUsd(status.usd));
      if (!confirm(t('semConfirmBuild', cost))) return;
      await send({ type: 'semBuild' });
    },
    actionError,
  ),
);
$('#sem-stop').addEventListener('click', () => withBusy($<HTMLButtonElement>('#sem-stop'), () => send({ type: 'semStop' }), actionError));
$('#sem-delete').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#sem-delete'),
    async () => {
      if (!confirm(t('semConfirmDelete'))) return;
      await send({ type: 'semDelete' });
      await renderSemantic();
    },
    actionError,
  ),
);

// ---------- encryption ----------

const encPass = $<HTMLInputElement>('#enc-pass');
const encPass2 = $<HTMLInputElement>('#enc-pass2');
const encUnderstand = $<HTMLInputElement>('#enc-understand');
const strengthKeys = ['encStrengthShort', 'encStrengthWeak', 'encStrengthFair', 'encStrengthStrong'] as const;

function renderEncryption(e: EncryptionStatus, connected: boolean) {
  $('#enc-offline').hidden = connected;
  $('#enc-off').hidden = !connected || e.state !== 'off';
  $('#enc-locked').hidden = !connected || e.state !== 'locked';
  $('#enc-on').hidden = !connected || e.state !== 'on';
  const badge = $('#enc-badge');
  badge.hidden = !connected;
  badge.className = `pill enc-${e.state}`;
  badge.textContent = t(e.state === 'on' ? 'encBadgeOn' : e.state === 'locked' ? 'encBadgeLocked' : 'encBadgeOff');
  const since = e.createdAt ? new Date(e.createdAt).toLocaleDateString() : '';
  const meta = e.createdBy ? t('encSinceBy', since, e.createdBy) : since ? t('encSince', since) : '';
  $('#enc-on-meta').textContent = meta;
  $('#enc-locked-meta').textContent = meta;
}

async function loadEncryption() {
  const status = await statusItem.getValue();
  renderEncryption(await encryptionStatusItem.getValue(), status.connected);
  if (!status.connected) return;
  // Ask Drive: another browser may have turned it on or off.
  renderEncryption(await send({ type: 'encStatus' }), true);
}
encryptionStatusItem.watch((e) => {
  void statusItem.getValue().then((s) => renderEncryption(e ?? { state: 'off' }, s.connected));
});

function checkPassphrase() {
  const p = encPass.value;
  const level = passphraseStrength(p);
  document.querySelector<HTMLElement>('.meter')!.dataset.level = String(p ? level : 0);
  const text = $('#enc-meter-text');
  const mismatch = encPass2.value !== '' && encPass2.value !== p;
  text.textContent = !p ? t('encStrengthHint', MIN_PASSPHRASE) : mismatch ? t('encMismatch') : t(strengthKeys[level], MIN_PASSPHRASE);
  text.classList.toggle('warn-text', mismatch || (p !== '' && level < 2));
  $<HTMLButtonElement>('#enc-enable').disabled = level === 0 || p !== encPass2.value || !encUnderstand.checked;
}
for (const input of [encPass, encPass2, encUnderstand]) input.addEventListener('input', checkPassphrase);
checkPassphrase();

$('#enc-off').addEventListener('submit', (e) => {
  e.preventDefault();
  void withBusy(
    $<HTMLButtonElement>('#enc-enable'),
    async () => {
      const passphrase = encPass.value;
      if (passphrase !== encPass2.value) throw new Error(t('encMismatch'));
      renderEncryption(await send({ type: 'encEnable', passphrase }), true);
      encPass.value = encPass2.value = '';
      encUnderstand.checked = false;
      checkPassphrase();
      showToast($('#action-ok'), t('encEnabledToast'));
    },
    actionError,
  );
});
$('#enc-locked').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('#enc-unlock-pass');
  void withBusy(
    $<HTMLButtonElement>('#enc-unlock'),
    async () => {
      renderEncryption(await send({ type: 'encUnlock', passphrase: input.value }), true);
      input.value = '';
    },
    actionError,
  );
});
$('#enc-lock').addEventListener('click', () =>
  withBusy($<HTMLButtonElement>('#enc-lock'), async () => renderEncryption(await send({ type: 'encLock' }), true), actionError),
);
$('#enc-disable').addEventListener('click', () => {
  if (!confirm(t('encDisableConfirm'))) return;
  void withBusy(
    $<HTMLButtonElement>('#enc-disable'),
    async () => renderEncryption(await send({ type: 'encDisable' }), true),
    actionError,
  );
});
$('#enc-reset').addEventListener('click', () => {
  // Deletes data that cannot be recovered: the user types a word to confirm.
  const word = t('encResetWord');
  if (prompt(t('encResetConfirm', word))?.trim().toLocaleUpperCase() !== word.toLocaleUpperCase()) return;
  void withBusy(
    $<HTMLButtonElement>('#enc-reset'),
    async () => {
      const { deleted } = await send({ type: 'encReset' });
      showToast($('#action-ok'), t('encResetDone', deleted));
      await loadEncryption();
    },
    actionError,
  );
});
