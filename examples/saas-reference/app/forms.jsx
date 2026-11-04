'use client';
import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { authenticate, saveNote, revokeOtherSessions } from './actions.js';
import { noteRequestKey } from '../lib/note-request-key.js';

export function AuthForm({ locale, mode }) {
  const t = useTranslations('App');
  const [state, action, pending] = useActionState(authenticate, {});
  return <form action={action} aria-busy={pending}>
    <input type="hidden" name="locale" value={locale} /><input type="hidden" name="mode" value={mode} />
    {mode === 'sign-up' && <><label htmlFor="name">{t('name')}</label><input id="name" name="name" autoComplete="name" required maxLength={100} /></>}
    <label htmlFor="email">{t('email')}</label><input id="email" name="email" type="email" autoComplete="email" required maxLength={254} aria-describedby={state.error ? 'auth-error' : undefined} />
    <label htmlFor="password">{t('password')}</label><input id="password" name="password" type="password" autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'} required minLength={12} maxLength={128} aria-describedby="password-hint" />
    <p id="password-hint" className="hint">{t('passwordHint')}</p>
    <p id="auth-error" role="alert">{state.error ? t(state.error) : ''}</p>
    <button disabled={pending}>{t(mode === 'sign-up' ? 'signUp' : 'signIn')}</button>
  </form>;
}

export function NoteForm({ locale, ownerId }) {
  const t = useTranslations('App');
  const [state, action, pending] = useActionState(saveNote, {});
  const [request, setRequest] = useState({});
  const [storageFailed, setStorageFailed] = useState(false);
  const requestKey = request.owner === ownerId && request.locale === locale ? request.key || '' : '';
  const prepare = (rotate = false) => {
    try { setRequest({ owner:ownerId, locale, key:noteRequestKey(sessionStorage,ownerId,locale,{rotate}) }); setStorageFailed(false); }
    catch { setStorageFailed(true); }
  };
  useEffect(() => { prepare(); }, [ownerId, locale]);
  useEffect(() => {
    if (state.saved && state.key === requestKey) prepare(true);
  }, [state, requestKey, ownerId, locale]);
  const error = state.error && (!state.key || state.key === requestKey) ? state.error : undefined;
  return <form action={action} aria-busy={pending}>
    <input type="hidden" name="locale" value={locale} />
    <input type="hidden" name="requestKey" value={requestKey} />
    <label htmlFor="body">{t('note')}</label><textarea id="body" name="body" required maxLength={500} rows={4} aria-invalid={state.error === 'required' || undefined} aria-describedby="note-status" />
    <button disabled={pending || !requestKey || storageFailed}>{t(pending ? 'saving' : 'save')}</button>
    {error === 'requestConflict' && <button type="button" onClick={() => prepare(true)}>{t('newNoteRequest')}</button>}
    <p id="note-status" role="status">{storageFailed ? t('requestStorageUnavailable') : error ? t(error) : state.saved ? t('saved') : ''}</p>
  </form>;
}

export function SessionForm({ locale }) {
  const t = useTranslations('App');
  const [state, action, pending] = useActionState(revokeOtherSessions, {});
  return <form action={action}><input type="hidden" name="locale" value={locale} />
    <button disabled={pending}>{t('revoke')}</button><p role="status">{state.error ? t(state.error) : state.updated ? t('updated') : ''}</p>
  </form>;
}
