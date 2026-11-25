import { t } from '../shared/i18n';

/** Encryption is on for this account, but the passphrase was not entered in this browser. */
export class LockedError extends Error {
  override name = 'LockedError';
  constructor() {
    super(t('errLocked'));
  }
}
